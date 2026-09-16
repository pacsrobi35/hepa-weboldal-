-- Resend delivery tracking for sent quote offers.
-- Webhook events stay in the private schema; admins only receive the compact
-- status fields exposed by get_quote_offer_delivery_status().

begin;

alter table private.quote_offer_deliveries
  add column provider_delivery_status text,
  add column provider_status_at timestamptz,
  add column provider_status_event_id text;

alter table private.quote_offer_deliveries
  add constraint quote_offer_deliveries_provider_delivery_status_check
    check (
      provider_delivery_status is null
      or provider_delivery_status = any (array[
        'sent', 'delivery_delayed', 'delivered', 'bounced',
        'failed', 'complained', 'suppressed'
      ])
    ),
  add constraint quote_offer_deliveries_provider_status_at_check
    check (
      (provider_delivery_status is null and provider_status_at is null)
      or (provider_delivery_status is not null and provider_status_at is not null)
    ),
  add constraint quote_offer_deliveries_provider_status_event_id_check
    check (
      provider_status_event_id is null
      or char_length(btrim(provider_status_event_id)) between 1 and 200
    );

create table private.quote_offer_delivery_events (
  id bigint generated always as identity primary key,
  svix_id text not null unique
    constraint quote_offer_delivery_events_svix_id_check
    check (char_length(btrim(svix_id)) between 1 and 200),
  -- Null is intentional: a signed webhook may beat the provider-response
  -- finalization transaction. The attach trigger reconciles it later.
  delivery_id uuid
    references private.quote_offer_deliveries(id) on delete cascade,
  provider_message_id text not null
    constraint quote_offer_delivery_events_message_id_check
    check (char_length(btrim(provider_message_id)) between 1 and 200),
  event_type text not null
    constraint quote_offer_delivery_events_type_check
    check (event_type = any (array[
      'email.sent', 'email.delivery_delayed', 'email.delivered',
      'email.bounced', 'email.failed', 'email.complained',
      'email.suppressed'
    ])),
  event_created_at timestamptz not null,
  payload_sha256 text not null
    constraint quote_offer_delivery_events_payload_sha256_check
    check (payload_sha256 ~ '^[0-9a-f]{64}$'),
  received_at timestamptz not null default now()
);

create index quote_offer_delivery_events_delivery_created_idx
  on private.quote_offer_delivery_events(delivery_id, event_created_at desc);
create index quote_offer_delivery_events_unmatched_message_idx
  on private.quote_offer_delivery_events(provider_message_id)
  where delivery_id is null;

alter table private.quote_offer_delivery_events enable row level security;
revoke all on table private.quote_offer_delivery_events
  from public, anon, authenticated, service_role;
revoke usage, select on sequence private.quote_offer_delivery_events_id_seq
  from public, anon, authenticated, service_role;

create or replace function private.recalculate_quote_offer_provider_status(
  p_delivery_id uuid
)
returns void
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_event private.quote_offer_delivery_events%rowtype;
  v_status text;
begin
  select e.* into v_event
  from private.quote_offer_delivery_events e
  where e.delivery_id = p_delivery_id
  order by
    e.event_created_at desc,
    case e.event_type
      when 'email.sent' then 10
      when 'email.delivery_delayed' then 20
      when 'email.delivered' then 30
      when 'email.bounced' then 40
      when 'email.failed' then 40
      when 'email.suppressed' then 40
      when 'email.complained' then 50
      else 0
    end desc,
    e.svix_id desc
  limit 1;

  if not found then
    return;
  end if;

  v_status := case v_event.event_type
    when 'email.sent' then 'sent'
    when 'email.delivery_delayed' then 'delivery_delayed'
    when 'email.delivered' then 'delivered'
    when 'email.bounced' then 'bounced'
    when 'email.failed' then 'failed'
    when 'email.complained' then 'complained'
    when 'email.suppressed' then 'suppressed'
  end;

  update private.quote_offer_deliveries
  set
    provider_delivery_status = v_status,
    provider_status_at = v_event.event_created_at,
    provider_status_event_id = v_event.svix_id,
    updated_at = now()
  where id = p_delivery_id
    and (
      provider_delivery_status is distinct from v_status
      or provider_status_at is distinct from v_event.event_created_at
      or provider_status_event_id is distinct from v_event.svix_id
    );
end;
$function$;

revoke all on function private.recalculate_quote_offer_provider_status(uuid)
  from public, anon, authenticated, service_role;

create or replace function private.initialize_quote_offer_provider_status()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $function$
begin
  if new.provider_message_id is not null
     and new.status in ('provider_accepted', 'finalized')
     and new.provider_delivery_status is null then
    new.provider_delivery_status := 'sent';
    new.provider_status_at := clock_timestamp();
  end if;

  return new;
end;
$function$;

revoke all on function private.initialize_quote_offer_provider_status()
  from public, anon, authenticated, service_role;

create trigger initialize_quote_offer_provider_status
before insert or update on private.quote_offer_deliveries
for each row execute function private.initialize_quote_offer_provider_status();

create or replace function private.attach_quote_offer_provider_events()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if new.provider_message_id is null
     or old.provider_message_id is not distinct from new.provider_message_id then
    return new;
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended('resend-email-' || new.provider_message_id, 0)
  );

  update private.quote_offer_delivery_events
  set delivery_id = new.id
  where provider_message_id = new.provider_message_id
    and delivery_id is null;

  perform private.recalculate_quote_offer_provider_status(new.id);
  return new;
end;
$function$;

revoke all on function private.attach_quote_offer_provider_events()
  from public, anon, authenticated, service_role;

create trigger attach_quote_offer_provider_events
after update of provider_message_id on private.quote_offer_deliveries
for each row execute function private.attach_quote_offer_provider_events();

-- Take the same provider-message advisory lock before the existing row-lock
-- order. This closes the small race where a fast webhook could otherwise be
-- committed between the provider response and local finalization.
create or replace function public.finalize_quote_offer_delivery(
  p_delivery_id uuid,
  p_lease_token uuid,
  p_provider_message_id text,
  p_http_status integer
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_offer_id bigint;
  v_quote_request_id bigint;
  v_offer public.quote_offers%rowtype;
  v_delivery private.quote_offer_deliveries%rowtype;
begin
  perform private.require_quote_delivery_service();
  if char_length(btrim(coalesce(p_provider_message_id, ''))) not between 1 and 200
     or p_http_status is null
     or p_http_status not between 200 and 299 then
    raise exception 'provider-message-id-invalid' using errcode = '22023';
  end if;

  select d.offer_id, o.quote_request_id
    into v_offer_id, v_quote_request_id
  from private.quote_offer_deliveries d
  join public.quote_offers o on o.id = d.offer_id
  where d.id = p_delivery_id;
  if v_offer_id is null then
    raise exception 'delivery-not-found' using errcode = 'P0002';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended('resend-email-' || btrim(p_provider_message_id), 0)
  );
  perform pg_advisory_xact_lock(
    hashtextextended('quote-offer-' || v_quote_request_id::text, 0)
  );

  select o.* into v_offer
  from public.quote_offers o
  where o.id = v_offer_id
  for update;
  select d.* into v_delivery
  from private.quote_offer_deliveries d
  where d.id = p_delivery_id
  for update;
  perform 1 from public.quote_requests where id = v_quote_request_id for update;

  if v_delivery.status = 'finalized' then
    if v_delivery.provider_message_id <> btrim(p_provider_message_id) then
      raise exception 'provider-message-id-mismatch' using errcode = '55000';
    end if;
    return jsonb_build_object(
      'state', 'finalized', 'delivery_id', v_delivery.id,
      'provider_message_id', v_delivery.provider_message_id
    );
  end if;

  if v_offer.status <> 'draft'
     or v_delivery.status <> 'sending'
     or v_delivery.lease_token is distinct from p_lease_token then
    raise exception 'delivery-finalization-conflict' using errcode = '40001';
  end if;

  update private.quote_offer_deliveries
  set
    status = 'provider_accepted',
    attempt_in_flight = false,
    provider_message_id = btrim(p_provider_message_id),
    last_error_code = null,
    last_http_status = p_http_status,
    updated_at = now()
  where id = v_delivery.id;

  update public.quote_offers
  set status = 'superseded', updated_at = now()
  where quote_request_id = v_quote_request_id
    and id <> v_offer.id
    and status = 'sent';

  update public.quote_offers
  set
    status = 'sent',
    sent_at = now(),
    sent_to = v_delivery.recipient_email,
    provider_message_id = btrim(p_provider_message_id),
    updated_at = now()
  where id = v_offer.id and status = 'draft';
  if not found then
    raise exception 'delivery-finalization-conflict' using errcode = '40001';
  end if;

  update public.quote_requests
  set
    status = case when status in ('ordered', 'closed') then status
                  else 'waiting' end,
    updated_at = now()
  where id = v_quote_request_id;

  update private.quote_offer_deliveries
  set
    status = 'finalized',
    attempt_in_flight = false,
    lease_token = null,
    lease_expires_at = null,
    updated_at = now()
  where id = v_delivery.id
  returning * into v_delivery;

  return jsonb_build_object(
    'state', 'finalized',
    'delivery_id', v_delivery.id,
    'offer_id', v_delivery.offer_id,
    'provider_message_id', v_delivery.provider_message_id
  );
end;
$function$;

-- Provider acceptance means Resend has accepted the message for delivery, not
-- that the recipient server has received it yet.
update private.quote_offer_deliveries d
set
  provider_delivery_status = 'sent',
  provider_status_at = coalesce(o.sent_at, d.updated_at)
from public.quote_offers o
where o.id = d.offer_id
  and d.provider_message_id is not null
  and d.provider_delivery_status is null;

create or replace function public.record_quote_offer_provider_event(
  p_svix_id text,
  p_provider_message_id text,
  p_event_type text,
  p_event_created_at timestamptz,
  p_payload_sha256 text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_delivery private.quote_offer_deliveries%rowtype;
  v_existing_event private.quote_offer_delivery_events%rowtype;
  v_event_id bigint;
begin
  perform private.require_quote_delivery_service();

  if char_length(btrim(coalesce(p_svix_id, ''))) not between 1 and 200
     or char_length(btrim(coalesce(p_provider_message_id, ''))) not between 1 and 200
     or p_event_created_at is null
     or coalesce(p_payload_sha256, '') !~ '^[0-9a-f]{64}$' then
    raise exception 'provider-event-invalid' using errcode = '22023';
  end if;

  if p_event_type is null or p_event_type <> all (array[
    'email.sent', 'email.delivery_delayed', 'email.delivered',
    'email.bounced', 'email.failed', 'email.complained',
    'email.suppressed'
  ]) then
    return jsonb_build_object('state', 'ignored_event_type');
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended('resend-email-' || btrim(p_provider_message_id), 0)
  );

  -- Keep unmatched signed events only long enough to cover a finalization race.
  delete from private.quote_offer_delivery_events
  where delivery_id is null
    and received_at < now() - interval '30 days';

  select d.* into v_delivery
  from private.quote_offer_deliveries d
  where d.provider_message_id = btrim(p_provider_message_id)
  for update;

  insert into private.quote_offer_delivery_events (
    svix_id,
    delivery_id,
    provider_message_id,
    event_type,
    event_created_at,
    payload_sha256
  ) values (
    btrim(p_svix_id),
    v_delivery.id,
    btrim(p_provider_message_id),
    p_event_type,
    p_event_created_at,
    p_payload_sha256
  )
  on conflict (svix_id) do nothing
  returning id into v_event_id;

  if v_event_id is null then
    select e.* into v_existing_event
    from private.quote_offer_delivery_events e
    where e.svix_id = btrim(p_svix_id);

    if v_existing_event.payload_sha256 is distinct from p_payload_sha256
       or v_existing_event.provider_message_id
          is distinct from btrim(p_provider_message_id)
       or v_existing_event.event_type is distinct from p_event_type
       or v_existing_event.event_created_at is distinct from p_event_created_at then
      raise exception 'provider-event-replay-mismatch' using errcode = '22023';
    end if;

    return jsonb_build_object(
      'state', 'duplicate',
      'delivery_id', v_existing_event.delivery_id
    );
  end if;

  if v_delivery.id is null then
    return jsonb_build_object('state', 'pending_match');
  end if;

  perform private.recalculate_quote_offer_provider_status(v_delivery.id);
  select d.* into v_delivery
  from private.quote_offer_deliveries d
  where d.id = v_delivery.id;

  return jsonb_build_object(
    'state', 'updated',
    'delivery_id', v_delivery.id,
    'provider_delivery_status', v_delivery.provider_delivery_status,
    'provider_status_at', v_delivery.provider_status_at
  );
end;
$function$;

create or replace function public.get_quote_offer_delivery_status(
  p_offer_id bigint
)
returns table (
  offer_id bigint,
  provider_delivery_status text,
  provider_status_at timestamptz,
  recipient_email text,
  sent_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.require_quote_delivery_admin();

  return query
  select
    d.offer_id,
    d.provider_delivery_status,
    d.provider_status_at,
    d.recipient_email,
    o.sent_at
  from private.quote_offer_deliveries d
  join public.quote_offers o on o.id = d.offer_id
  where d.offer_id = p_offer_id;
end;
$function$;

revoke all on function public.record_quote_offer_provider_event(
  text, text, text, timestamptz, text
) from public, anon, authenticated, service_role;
revoke all on function public.get_quote_offer_delivery_status(bigint)
  from public, anon, authenticated, service_role;

grant execute on function public.record_quote_offer_provider_event(
  text, text, text, timestamptz, text
) to service_role;
grant execute on function public.get_quote_offer_delivery_status(bigint)
  to authenticated;

notify pgrst, 'reload schema';

commit;

