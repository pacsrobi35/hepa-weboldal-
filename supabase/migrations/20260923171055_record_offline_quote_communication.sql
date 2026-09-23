-- Record prices given by telephone, in person or on paper separately from
-- provider-accepted email delivery. Preserve failed/uncertain email attempts.
begin;

alter table public.quote_offers
  add column if not exists communicated_via text,
  add column if not exists communicated_on date;

alter table public.quote_offers
  add constraint quote_offers_communicated_via_check
  check (communicated_via is null or communicated_via in ('email','phone','in_person','paper'));

alter table public.quote_offers drop constraint if exists quote_offers_status_check;
alter table public.quote_offers
  add constraint quote_offers_status_check
  check (status in ('draft','sent','accepted','rejected','superseded','discarded'));

-- Keep the existing provider-accepted email branch intact. An offline transition
-- has no recipient email and cannot claim a provider message ID.
create or replace function private.guard_quote_offer_immutability()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if tg_op = 'INSERT' then
    if new.status <> 'draft' or new.sent_at is not null
       or new.sent_to is not null or new.provider_message_id is not null
       or new.communicated_via is not null or new.communicated_on is not null then
      raise exception 'new-offer-must-be-draft' using errcode = '55000';
    end if;
    return new;
  end if;

  if tg_op = 'DELETE' then
    if old.status <> 'draft' or exists (
      select 1 from private.quote_offer_deliveries d where d.offer_id = old.id
    ) then
      raise exception 'offer-is-immutable' using errcode = '55000';
    end if;
    return old;
  end if;

  if old.status = 'draft' and new.status = 'draft' then
    if exists (select 1 from private.quote_offer_deliveries d where d.offer_id = old.id) then
      raise exception 'offer-delivery-already-prepared' using errcode = '55000';
    end if;
    if new.sent_at is not null or new.sent_to is not null
       or new.provider_message_id is not null or new.communicated_via is not null
       or new.communicated_on is not null then
      raise exception 'draft-cannot-have-send-metadata' using errcode = '55000';
    end if;
    return new;
  end if;

  if old.status = 'draft' and new.status = 'discarded' then
    perform private.require_quote_delivery_admin();
    if exists (select 1 from private.quote_offer_deliveries d where d.offer_id = old.id)
       or (to_jsonb(new) - array['status','updated_at']::text[])
          is distinct from (to_jsonb(old) - array['status','updated_at']::text[]) then
      raise exception 'draft-cannot-be-discarded' using errcode = '55000';
    end if;
    return new;
  end if;

  if old.status = 'draft' and new.status = 'sent' then
    if (to_jsonb(new) - array[
      'status','sent_at','sent_to','provider_message_id','updated_at',
      'communicated_via','communicated_on'
    ]::text[]) is distinct from (to_jsonb(old) - array[
      'status','sent_at','sent_to','provider_message_id','updated_at',
      'communicated_via','communicated_on'
    ]::text[]) or new.sent_at is null then
      raise exception 'offer-content-is-immutable' using errcode = '55000';
    end if;

    if new.sent_to is not null and new.provider_message_id is not null
       and new.communicated_on is null
       and coalesce(new.communicated_via, 'email') = 'email'
       and exists (
         select 1 from private.quote_offer_deliveries d
         where d.offer_id = old.id and d.status = 'provider_accepted'
           and d.recipient_email = lower(btrim(new.sent_to))
           and d.provider_message_id = new.provider_message_id
       ) then
      new.communicated_via := 'email';
      return new;
    end if;

    if new.communicated_via in ('phone','in_person','paper')
       and new.communicated_on is not null and new.sent_to is null
       and new.provider_message_id is null
       and new.communicated_on <= (clock_timestamp() at time zone 'Europe/Budapest')::date
       and not exists (
         select 1 from private.quote_offer_deliveries d where d.offer_id = old.id
       ) then
      perform private.require_quote_delivery_admin();
      return new;
    end if;
    raise exception 'invalid-offer-finalization' using errcode = '55000';
  end if;

  if old.status = 'sent' and new.status = 'superseded' then
    if (to_jsonb(new) - array['status','updated_at']::text[])
       is distinct from (to_jsonb(old) - array['status','updated_at']::text[])
       or not (
         exists (
           select 1 from private.quote_offer_deliveries d
           join public.quote_offers replacement on replacement.id = d.offer_id
           where replacement.quote_request_id = old.quote_request_id
             and replacement.id <> old.id and d.status = 'provider_accepted'
         ) or exists (
           select 1 from public.quote_offers replacement
           where replacement.quote_request_id = old.quote_request_id
             and replacement.version > old.version and replacement.status = 'sent'
             and replacement.communicated_via in ('phone','in_person','paper')
             and replacement.communicated_on is not null
         )
       ) then
      raise exception 'invalid-offer-supersession' using errcode = '55000';
    end if;
    return new;
  end if;

  if old.status = 'sent' and new.status in ('accepted','rejected') then
    if (to_jsonb(new) - array['status','updated_at']::text[])
       is distinct from (to_jsonb(old) - array['status','updated_at']::text[]) then
      raise exception 'offer-content-is-immutable' using errcode = '55000';
    end if;
    return new;
  end if;

  raise exception 'offer-is-immutable' using errcode = '55000';
end;
$function$;

create or replace function public.record_quote_offer_communication(
  p_offer_id bigint,
  p_expected_updated_at timestamptz,
  p_channel text,
  p_communicated_on date
)
returns bigint
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_actor uuid;
  v_request_id bigint;
  v_offer public.quote_offers%rowtype;
  v_quote public.quote_requests%rowtype;
  v_activity_id bigint;
  v_method text;
begin
  v_actor := private.require_quote_delivery_admin();
  if p_offer_id is null or p_offer_id < 1 or p_expected_updated_at is null
     or p_channel not in ('phone','in_person','paper') or p_channel is null
     or p_communicated_on is null
     or p_communicated_on > (clock_timestamp() at time zone 'Europe/Budapest')::date
     or p_communicated_on < (clock_timestamp() at time zone 'Europe/Budapest')::date - 365 then
    raise exception 'invalid-offline-communication' using errcode = '22023';
  end if;

  select quote_request_id into v_request_id from public.quote_offers where id = p_offer_id;
  if not found then raise exception 'offer-not-found' using errcode = 'P0002'; end if;
  perform pg_advisory_xact_lock(hashtextextended('quote-offer-' || v_request_id::text, 0));

  select * into v_offer from public.quote_offers where id = p_offer_id for update;
  if not found then raise exception 'offer-not-found' using errcode = 'P0002'; end if;
  if v_offer.updated_at is distinct from p_expected_updated_at then
    raise exception 'quote-offer-stale' using errcode = '40001';
  end if;
  if v_offer.status <> 'draft' or exists (
    select 1 from private.quote_offer_deliveries d where d.offer_id = v_offer.id
  ) then
    raise exception 'draft-not-sendable-offline' using errcode = '55000';
  end if;
  if v_offer.gross_total <= 0 or not exists (
    select 1 from public.quote_offer_items i where i.offer_id = v_offer.id
  ) then
    raise exception 'offline-offer-requires-positive-total' using errcode = '22023';
  end if;

  select * into v_quote from public.quote_requests where id = v_request_id for update;
  if not found then raise exception 'quote-request-not-found' using errcode = 'P0002'; end if;
  if v_quote.status = 'closed' or exists (
    select 1 from public.quote_offers o
    where o.quote_request_id = v_request_id and o.status = 'accepted'
  ) then
    raise exception 'offer-parent-already-finalized' using errcode = '55000';
  end if;

  update public.quote_offers
  set status = 'sent', sent_at = clock_timestamp(), communicated_via = p_channel,
      communicated_on = p_communicated_on, updated_at = clock_timestamp()
  where id = v_offer.id;

  update public.quote_offers
  set status = 'superseded', updated_at = clock_timestamp()
  where quote_request_id = v_request_id and id <> v_offer.id and status = 'sent';

  update public.quote_requests
  set status = case when status = 'ordered' then status else 'waiting' end,
      updated_at = clock_timestamp()
  where id = v_request_id;

  v_method := case p_channel
    when 'phone' then 'telefonon'
    when 'in_person' then 'személyesen'
    else 'papíron'
  end;
  insert into public.quote_activities (quote_request_id, body, created_by)
  values (v_request_id,
    'Ár közölve ' || v_method || ' (' || p_communicated_on::text || '): '
      || v_offer.offer_number || ', bruttó '
      || trim(to_char(v_offer.gross_total, 'FM999999999999990D00')) || ' Ft.',
    v_actor)
  returning id into v_activity_id;

  return v_activity_id;
end;
$function$;

create or replace function public.discard_quote_offer_draft(
  p_offer_id bigint,
  p_expected_updated_at timestamptz
)
returns bigint
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_actor uuid;
  v_request_id bigint;
  v_offer public.quote_offers%rowtype;
  v_activity_id bigint;
begin
  v_actor := private.require_quote_delivery_admin();
  if p_offer_id is null or p_offer_id < 1 or p_expected_updated_at is null then
    raise exception 'invalid-draft-discard' using errcode = '22023';
  end if;

  select quote_request_id into v_request_id from public.quote_offers where id = p_offer_id;
  if not found then raise exception 'offer-not-found' using errcode = 'P0002'; end if;
  perform pg_advisory_xact_lock(hashtextextended('quote-offer-' || v_request_id::text, 0));

  select * into v_offer from public.quote_offers where id = p_offer_id for update;
  if not found then raise exception 'offer-not-found' using errcode = 'P0002'; end if;
  if v_offer.updated_at is distinct from p_expected_updated_at then
    raise exception 'quote-offer-stale' using errcode = '40001';
  end if;
  if v_offer.status <> 'draft' or exists (
    select 1 from private.quote_offer_deliveries d where d.offer_id = v_offer.id
  ) then
    raise exception 'draft-cannot-be-discarded' using errcode = '55000';
  end if;

  perform 1 from public.quote_requests where id = v_request_id for update;
  if not found then raise exception 'quote-request-not-found' using errcode = 'P0002'; end if;

  update public.quote_offers
  set status = 'discarded', updated_at = clock_timestamp()
  where id = v_offer.id;

  update public.quote_requests
  set status = case
        when status in ('ordered','closed') then status
        when exists (
          select 1 from public.quote_offers o
          where o.quote_request_id = v_request_id and o.status = 'sent'
        ) then 'waiting'
        else 'needs_quote'
      end,
      updated_at = clock_timestamp()
  where id = v_request_id;

  insert into public.quote_activities (quote_request_id, body, created_by)
  values (v_request_id, 'Ajánlatpiszkozat elvetve: ' || v_offer.offer_number || '.', v_actor)
  returning id into v_activity_id;
  return v_activity_id;
end;
$function$;

revoke all on function public.record_quote_offer_communication(bigint,timestamptz,text,date)
  from public, anon, authenticated, service_role;
grant execute on function public.record_quote_offer_communication(bigint,timestamptz,text,date)
  to authenticated;
revoke all on function public.discard_quote_offer_draft(bigint,timestamptz)
  from public, anon, authenticated, service_role;
grant execute on function public.discard_quote_offer_draft(bigint,timestamptz)
  to authenticated;

comment on column public.quote_offers.communicated_via is
  'Email requires provider acceptance; phone, in_person and paper are recorded by an AAL2 admin.';
comment on column public.quote_offers.communicated_on is
  'Date when an admin states a non-email offer was actually communicated.';

commit;
