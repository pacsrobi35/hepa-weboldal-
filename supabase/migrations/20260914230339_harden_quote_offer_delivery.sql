-- P0 hardening for quote-offer email delivery.
--
-- This migration is intentionally atomic and remains a local, pre-deploy artifact.
-- Deploy the fail-closed Edge Function first, then this migration, validate with
-- QUOTE_OFFER_EMAIL_ENABLED unset/false, and enable only after the checks pass.

begin;

create extension if not exists pgcrypto with schema extensions;

create schema if not exists private;
revoke all on schema private from public, anon, authenticated, service_role;

-- customer_snapshot was introduced outside the captured migration history.  Make
-- the dependency explicit so a clean rebuild from 20260907000000 is repeatable.
alter table public.quote_offers
  add column if not exists customer_snapshot jsonb;

create table private.quote_offer_delivery_authorizations (
  id uuid primary key default gen_random_uuid(),
  offer_id bigint not null
    references public.quote_offers(id) on delete cascade,
  actor_user_id uuid not null
    references auth.users(id) on delete cascade,
  authorized_offer_updated_at timestamptz not null,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  created_at timestamptz not null default now(),
  constraint quote_offer_delivery_authorizations_expiry_check
    check (expires_at > created_at)
);

create index quote_offer_delivery_authorizations_lookup_idx
  on private.quote_offer_delivery_authorizations
    (offer_id, actor_user_id, created_at desc);

create table private.quote_offer_deliveries (
  id uuid primary key,
  offer_id bigint not null
    references public.quote_offers(id) on delete restrict,
  status text not null default 'preparing'
    constraint quote_offer_deliveries_status_check
    check (status = any (array[
      'preparing', 'ready', 'sending', 'provider_accepted', 'finalized',
      'retryable_error', 'needs_review', 'expired'
    ])),
  recipient_email text not null
    constraint quote_offer_deliveries_recipient_check
    check (
      char_length(recipient_email) between 5 and 254
      and recipient_email = lower(btrim(recipient_email))
      and recipient_email ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
    ),
  content_snapshot jsonb not null
    constraint quote_offer_deliveries_content_snapshot_check
    check (jsonb_typeof(content_snapshot) = 'object'),
  -- Store the exact outbound byte sequence, not a re-serialized jsonb value.
  provider_payload text,
  payload_sha256 text
    constraint quote_offer_deliveries_payload_sha256_check
    check (payload_sha256 is null or payload_sha256 ~ '^[0-9a-f]{64}$'),
  idempotency_key text not null unique
    constraint quote_offer_deliveries_idempotency_key_check
    check (char_length(idempotency_key) between 1 and 256),
  first_provider_attempt_at timestamptz,
  last_provider_attempt_at timestamptz,
  attempt_count integer not null default 0
    constraint quote_offer_deliveries_attempt_count_check
    check (attempt_count >= 0),
  attempt_in_flight boolean not null default false,
  ambiguous_attempt_seen boolean not null default false,
  lease_token uuid,
  lease_expires_at timestamptz,
  provider_message_id text
    constraint quote_offer_deliveries_provider_message_id_check
    check (
      provider_message_id is null
      or char_length(btrim(provider_message_id)) between 1 and 200
    ),
  last_error_code text
    constraint quote_offer_deliveries_last_error_code_check
    check (last_error_code is null or char_length(last_error_code) <= 100),
  last_http_status integer
    constraint quote_offer_deliveries_last_http_status_check
    check (last_http_status is null or last_http_status between 100 and 599),
  created_by uuid not null references auth.users(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint quote_offer_deliveries_offer_key unique (offer_id),
  constraint quote_offer_deliveries_payload_state_check check (
    (status = 'preparing' and provider_payload is null and payload_sha256 is null)
    or (
      status <> 'preparing'
      and provider_payload is not null
      and payload_sha256 is not null
    )
  ),
  constraint quote_offer_deliveries_lease_check check (
    (lease_token is null and lease_expires_at is null)
    or (lease_token is not null and lease_expires_at is not null)
  ),
  constraint quote_offer_deliveries_provider_acceptance_check check (
    status not in ('provider_accepted', 'finalized')
    or provider_message_id is not null
  ),
  constraint quote_offer_deliveries_finalized_lease_check check (
    status <> 'finalized'
    or (lease_token is null and attempt_in_flight = false)
  )
);

create unique index quote_offer_deliveries_provider_message_id_key
  on private.quote_offer_deliveries(provider_message_id)
  where provider_message_id is not null;

create index quote_offer_deliveries_status_updated_idx
  on private.quote_offer_deliveries(status, updated_at);

alter table private.quote_offer_delivery_authorizations enable row level security;
alter table private.quote_offer_deliveries enable row level security;
revoke all on table private.quote_offer_delivery_authorizations
  from public, anon, authenticated, service_role;
revoke all on table private.quote_offer_deliveries
  from public, anon, authenticated, service_role;

-- Browser-originated authorization is deliberately separate from the provider
-- state machine.  The short-lived capability proves a fresh AAL2 admin session;
-- only the Edge Function's service-role client can consume it.
create or replace function private.require_quote_delivery_admin()
returns uuid
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_user_id uuid;
  v_claims jsonb;
  v_exp_text text;
begin
  v_user_id := (select auth.uid());
  v_claims := (select auth.jwt());

  if v_user_id is null then
    raise exception 'delivery-unauthorized' using errcode = '42501';
  end if;

  if coalesce(v_claims ->> 'aal', '') <> 'aal2' then
    raise exception 'delivery-aal2-required' using errcode = '42501';
  end if;

  v_exp_text := v_claims ->> 'exp';
  if v_exp_text is null or v_exp_text !~ '^[0-9]+$' then
    raise exception 'delivery-token-expired' using errcode = '42501';
  end if;
  if v_exp_text::numeric <= extract(epoch from clock_timestamp()) then
    raise exception 'delivery-token-expired' using errcode = '42501';
  end if;

  if not exists (
    select 1
    from public.admin_users a
    where a.user_id = v_user_id
  ) then
    raise exception 'delivery-admin-required' using errcode = '42501';
  end if;

  return v_user_id;
end;
$function$;

create or replace function private.require_quote_delivery_service()
returns void
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if coalesce((select auth.jwt() ->> 'role'), '') <> 'service_role' then
    raise exception 'delivery-service-role-required' using errcode = '42501';
  end if;
end;
$function$;

revoke all on function private.require_quote_delivery_admin()
  from public, anon, authenticated, service_role;
revoke all on function private.require_quote_delivery_service()
  from public, anon, authenticated, service_role;

-- Snapshot trigger that works both with the captured baseline and with the newer
-- optional quote_workflows table.  The dynamic lookup avoids a hard dependency
-- on an object absent from the historical migration chain.
create or replace function public.snapshot_quote_offer_customer()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $function$
declare
  v_address text;
begin
  if tg_op = 'UPDATE'
     and (old.status <> 'draft' or new.status <> 'draft') then
    new.customer_snapshot := old.customer_snapshot;
    return new;
  end if;

  if to_regclass('public.quote_workflows') is not null then
    execute
      'select address from public.quote_workflows where quote_request_id = $1'
      into v_address
      using new.quote_request_id;
  end if;

  select jsonb_build_object(
    'customer_name', q.customer_name,
    'email', q.email,
    'phone', q.phone,
    'project_type', q.project_type,
    'city', q.city,
    'postcode', q.postcode,
    'address', v_address
  )
    into new.customer_snapshot
  from public.quote_requests q
  where q.id = new.quote_request_id;

  return new;
end;
$function$;

revoke all on function public.snapshot_quote_offer_customer()
  from public, anon, authenticated, service_role;

drop trigger if exists quote_offers_customer_snapshot on public.quote_offers;
create trigger quote_offers_customer_snapshot
before insert or update on public.quote_offers
for each row execute function public.snapshot_quote_offer_customer();

-- Sent offers and every offer with an active delivery record are immutable.
create or replace function private.guard_quote_offer_immutability()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if tg_op = 'INSERT' then
    if new.status <> 'draft'
       or new.sent_at is not null
       or new.sent_to is not null
       or new.provider_message_id is not null then
      raise exception 'new-offer-must-be-draft' using errcode = '55000';
    end if;
    return new;
  end if;

  if tg_op = 'DELETE' then
    if old.status <> 'draft'
       or exists (
         select 1
         from private.quote_offer_deliveries d
         where d.offer_id = old.id
       ) then
      raise exception 'offer-is-immutable' using errcode = '55000';
    end if;
    return old;
  end if;

  if old.status = 'draft' and new.status = 'draft' then
    if exists (
      select 1
      from private.quote_offer_deliveries d
      where d.offer_id = old.id
    ) then
      raise exception 'offer-delivery-already-prepared' using errcode = '55000';
    end if;

    if new.sent_at is not null
       or new.sent_to is not null
       or new.provider_message_id is not null then
      raise exception 'draft-cannot-have-send-metadata' using errcode = '55000';
    end if;
    return new;
  end if;

  if old.status = 'draft' and new.status = 'sent' then
    if (to_jsonb(new) - array[
          'status', 'sent_at', 'sent_to', 'provider_message_id', 'updated_at'
        ]::text[])
       is distinct from
       (to_jsonb(old) - array[
          'status', 'sent_at', 'sent_to', 'provider_message_id', 'updated_at'
        ]::text[])
       or new.sent_at is null
       or new.sent_to is null
       or new.provider_message_id is null
       or not exists (
         select 1
         from private.quote_offer_deliveries d
         where d.offer_id = old.id
           and d.status = 'provider_accepted'
           and d.recipient_email = lower(btrim(new.sent_to))
           and d.provider_message_id = new.provider_message_id
       ) then
      raise exception 'invalid-offer-finalization' using errcode = '55000';
    end if;
    return new;
  end if;

  if old.status = 'sent' and new.status = 'superseded' then
    if (to_jsonb(new) - array['status', 'updated_at']::text[])
       is distinct from
       (to_jsonb(old) - array['status', 'updated_at']::text[])
       or not exists (
         select 1
         from private.quote_offer_deliveries d
         join public.quote_offers replacement on replacement.id = d.offer_id
         where replacement.quote_request_id = old.quote_request_id
           and replacement.id <> old.id
           and d.status = 'provider_accepted'
       ) then
      raise exception 'invalid-offer-supersession' using errcode = '55000';
    end if;
    return new;
  end if;

  if old.status = 'sent' and new.status in ('accepted', 'rejected') then
    if (to_jsonb(new) - array['status', 'updated_at']::text[])
       is distinct from
       (to_jsonb(old) - array['status', 'updated_at']::text[]) then
      raise exception 'offer-content-is-immutable' using errcode = '55000';
    end if;
    return new;
  end if;

  raise exception 'offer-is-immutable' using errcode = '55000';
end;
$function$;

revoke all on function private.guard_quote_offer_immutability()
  from public, anon, authenticated, service_role;

drop trigger if exists quote_offers_immutable_guard on public.quote_offers;
create trigger quote_offers_immutable_guard
before insert or update or delete on public.quote_offers
for each row execute function private.guard_quote_offer_immutability();

-- Once a provider-sendable delivery exists, the customer identity used by the
-- frozen email must not change between the claim transaction and the provider
-- request.  Status/workflow updates remain allowed; only outbound identity
-- fields are protected until the delivery becomes terminal.
create or replace function private.guard_quote_request_delivery_identity()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if btrim(coalesce(new.customer_name, ''))
       is not distinct from btrim(coalesce(old.customer_name, ''))
     and lower(btrim(coalesce(new.email, '')))
       is not distinct from lower(btrim(coalesce(old.email, '')))
     and btrim(coalesce(new.phone, ''))
       is not distinct from btrim(coalesce(old.phone, ''))
     and btrim(coalesce(new.project_type, ''))
       is not distinct from btrim(coalesce(old.project_type, '')) then
    return new;
  end if;

  if exists (
    select 1
    from public.quote_offers o
    join private.quote_offer_deliveries d on d.offer_id = o.id
    where o.quote_request_id = old.id
      and d.status in ('preparing', 'ready', 'sending', 'retryable_error')
  ) then
    raise exception 'quote-request-delivery-active' using errcode = '55000';
  end if;

  return new;
end;
$function$;

revoke all on function private.guard_quote_request_delivery_identity()
  from public, anon, authenticated, service_role;

drop trigger if exists quote_requests_delivery_identity_guard
  on public.quote_requests;
create trigger quote_requests_delivery_identity_guard
before update on public.quote_requests
for each row execute function private.guard_quote_request_delivery_identity();

-- All item mutations share the request-scoped advisory guard used by save and
-- delivery preparation.  Browser DML is revoked below, and the trigger protects
-- privileged/accidental writes as a second line of defense.
create or replace function private.guard_quote_offer_item_immutability()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_old_offer_id bigint;
  v_new_offer_id bigint;
  v_offer_id bigint;
  v_quote_request_id bigint;
  v_status text;
begin
  v_old_offer_id := case when tg_op in ('UPDATE', 'DELETE') then old.offer_id end;
  v_new_offer_id := case when tg_op in ('INSERT', 'UPDATE') then new.offer_id end;

  if tg_op = 'UPDATE' and v_old_offer_id <> v_new_offer_id then
    raise exception 'offer-item-cannot-move' using errcode = '55000';
  end if;

  v_offer_id := coalesce(v_new_offer_id, v_old_offer_id);
  select o.quote_request_id
    into v_quote_request_id
  from public.quote_offers o
  where o.id = v_offer_id;

  -- A permitted parent delete reaches cascading child deletes after the parent
  -- is no longer visible.  The parent guard already rejected unsafe deletes.
  if v_quote_request_id is null and tg_op = 'DELETE' then
    return old;
  end if;
  if v_quote_request_id is null then
    raise exception 'offer-not-found' using errcode = 'P0002';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended('quote-offer-' || v_quote_request_id::text, 0)
  );

  select o.status
    into v_status
  from public.quote_offers o
  where o.id = v_offer_id
  for key share;

  if v_status <> 'draft'
     or exists (
       select 1
       from private.quote_offer_deliveries d
       where d.offer_id = v_offer_id
     ) then
    raise exception 'offer-items-are-immutable' using errcode = '55000';
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$function$;

revoke all on function private.guard_quote_offer_item_immutability()
  from public, anon, authenticated, service_role;

drop trigger if exists quote_offer_items_immutable_guard
  on public.quote_offer_items;
create trigger quote_offer_items_immutable_guard
before insert or update or delete on public.quote_offer_items
for each row execute function private.guard_quote_offer_item_immutability();

-- Replace the legacy save RPC with an AAL2-gated compare-and-swap variant.  For
-- existing drafts, delivery-prepared is checked before the stale timestamp so a
-- retrying UI can distinguish an immutable frozen delivery from an ordinary
-- stale browser tab without attempting another write.
revoke all on function public.save_quote_offer(
  bigint, text, numeric, numeric, date, text, text, text, jsonb, bigint
) from public, anon, authenticated, service_role;
drop function public.save_quote_offer(
  bigint, text, numeric, numeric, date, text, text, text, jsonb, bigint
);

create function public.save_quote_offer(
  p_quote_request_id bigint,
  p_kind text,
  p_vat_rate numeric,
  p_deposit_percent numeric,
  p_valid_until date,
  p_lead_time text,
  p_customer_note text,
  p_internal_note text,
  p_items jsonb,
  p_offer_id bigint default null,
  p_expected_updated_at timestamptz default null
)
returns bigint
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_offer_id bigint;
  v_version integer;
  v_item jsonb;
  v_position smallint := 0;
  v_description text;
  v_unit text;
  v_quantity numeric(12,3);
  v_unit_net_price numeric(16,2);
  v_net_total numeric(16,2);
  v_vat_total numeric(16,2);
  v_gross_total numeric(16,2);
  v_deposit_amount numeric(16,2);
  v_existing public.quote_offers%rowtype;
begin
  perform private.require_quote_delivery_admin();

  if p_kind not in ('estimate', 'final') then
    raise exception 'invalid-offer-kind' using errcode = '22023';
  end if;
  if p_vat_rate is null or p_vat_rate < 0 or p_vat_rate > 100 then
    raise exception 'invalid-vat-rate' using errcode = '22023';
  end if;
  if p_deposit_percent is not null
     and (p_deposit_percent < 0 or p_deposit_percent > 100) then
    raise exception 'invalid-deposit-percent' using errcode = '22023';
  end if;
  if char_length(coalesce(p_lead_time, '')) > 200
     or char_length(coalesce(p_customer_note, '')) > 4000
     or char_length(coalesce(p_internal_note, '')) > 4000 then
    raise exception 'offer-text-too-long' using errcode = '22023';
  end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array'
     or jsonb_array_length(p_items) < 1
     or jsonb_array_length(p_items) > 50 then
    raise exception 'offer-items-invalid' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended('quote-offer-' || p_quote_request_id::text, 0)
  );

  if p_offer_id is not null then
    select o.*
      into v_existing
    from public.quote_offers o
    where o.id = p_offer_id
      and o.quote_request_id = p_quote_request_id
      and o.status = 'draft'
    for update;

    if not found then
      raise exception 'editable-draft-not-found' using errcode = 'P0002';
    end if;

    if exists (
      select 1
      from private.quote_offer_deliveries d
      where d.offer_id = p_offer_id
    ) then
      raise exception 'offer-delivery-already-prepared' using errcode = '55000';
    end if;

    if p_expected_updated_at is null then
      raise exception 'offer-version-required' using errcode = '22023';
    end if;
    if v_existing.updated_at is distinct from p_expected_updated_at then
      raise exception 'quote-offer-stale' using errcode = '40001';
    end if;
  end if;

  perform 1
  from public.quote_requests q
  where q.id = p_quote_request_id
  for update;
  if not found then
    raise exception 'quote-request-not-found' using errcode = 'P0002';
  end if;

  if p_offer_id is null then
    select coalesce(max(o.version), 0) + 1
      into v_version
    from public.quote_offers o
    where o.quote_request_id = p_quote_request_id;

    insert into public.quote_offers (
      quote_request_id, version, kind, vat_rate, deposit_percent,
      valid_until, lead_time, customer_note, internal_note, created_by
    )
    values (
      p_quote_request_id, v_version, p_kind, p_vat_rate, p_deposit_percent,
      p_valid_until, nullif(btrim(p_lead_time), ''),
      nullif(btrim(p_customer_note), ''),
      nullif(btrim(p_internal_note), ''), (select auth.uid())
    )
    returning id into v_offer_id;
  else
    update public.quote_offers
    set
      kind = p_kind,
      vat_rate = p_vat_rate,
      deposit_percent = p_deposit_percent,
      valid_until = p_valid_until,
      lead_time = nullif(btrim(p_lead_time), ''),
      customer_note = nullif(btrim(p_customer_note), ''),
      internal_note = nullif(btrim(p_internal_note), ''),
      updated_at = now()
    where id = p_offer_id
      and updated_at = p_expected_updated_at
    returning id into v_offer_id;

    if v_offer_id is null then
      raise exception 'quote-offer-stale' using errcode = '40001';
    end if;

    delete from public.quote_offer_items
    where offer_id = v_offer_id;
  end if;

  for v_item in select value from jsonb_array_elements(p_items)
  loop
    v_position := v_position + 1;
    v_description := btrim(coalesce(v_item ->> 'description', ''));
    v_unit := btrim(coalesce(v_item ->> 'unit', 'db'));

    begin
      v_quantity := replace(coalesce(v_item ->> 'quantity', ''), ',', '.')::numeric;
      v_unit_net_price := replace(
        coalesce(v_item ->> 'unit_net_price', ''), ',', '.'
      )::numeric;
    exception
      when invalid_text_representation or numeric_value_out_of_range then
        raise exception 'invalid-item-number' using errcode = '22023';
    end;

    if char_length(v_description) < 2
       or char_length(v_description) > 300
       or char_length(v_unit) < 1
       or char_length(v_unit) > 20
       or v_quantity <= 0
       or v_quantity > 1000000
       or v_unit_net_price < 0
       or v_unit_net_price > 99999999999999.99 then
      raise exception 'invalid-offer-item' using errcode = '22023';
    end if;

    insert into public.quote_offer_items (
      offer_id, position, description, quantity, unit, unit_net_price
    ) values (
      v_offer_id, v_position, v_description, v_quantity, v_unit,
      v_unit_net_price
    );
  end loop;

  select coalesce(sum(i.line_net_total), 0)
    into v_net_total
  from public.quote_offer_items i
  where i.offer_id = v_offer_id;

  v_vat_total := round(v_net_total * p_vat_rate / 100, 2);
  v_gross_total := v_net_total + v_vat_total;
  v_deposit_amount := case
    when p_deposit_percent is null then null
    else round(v_gross_total * p_deposit_percent / 100, 2)
  end;

  update public.quote_offers
  set
    net_total = v_net_total,
    vat_total = v_vat_total,
    gross_total = v_gross_total,
    deposit_amount = v_deposit_amount,
    updated_at = now()
  where id = v_offer_id;

  update public.quote_requests
  set
    status = case
      when status in ('ordered', 'closed') then status
      else 'needs_quote'
    end,
    updated_at = now()
  where id = p_quote_request_id;

  return v_offer_id;
end;
$function$;

-- Mint a five-minute, single-use AAL2 capability.  It authorizes an Edge
-- Function operation but cannot mutate provider state from a browser session.
create or replace function public.authorize_quote_offer_delivery(
  p_offer_id bigint
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_user_id uuid;
  v_quote_request_id bigint;
  v_offer_status text;
  v_offer_updated_at timestamptz;
  v_authorization private.quote_offer_delivery_authorizations%rowtype;
begin
  v_user_id := private.require_quote_delivery_admin();

  select o.quote_request_id
    into v_quote_request_id
  from public.quote_offers o
  where o.id = p_offer_id;
  if v_quote_request_id is null then
    raise exception 'offer-not-found' using errcode = 'P0002';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended('quote-offer-' || v_quote_request_id::text, 0)
  );

  select o.status, o.updated_at
    into v_offer_status, v_offer_updated_at
  from public.quote_offers o
  where o.id = p_offer_id
  for key share;
  if not found then
    raise exception 'offer-not-found' using errcode = 'P0002';
  end if;
  if v_offer_status not in ('draft', 'sent') then
    raise exception 'offer-not-sendable' using errcode = '55000';
  end if;

  update private.quote_offer_delivery_authorizations
  set consumed_at = now()
  where offer_id = p_offer_id
    and actor_user_id = v_user_id
    and consumed_at is null;

  insert into private.quote_offer_delivery_authorizations (
    offer_id, actor_user_id, authorized_offer_updated_at, expires_at
  ) values (
    p_offer_id, v_user_id, v_offer_updated_at, now() + interval '5 minutes'
  )
  returning * into v_authorization;

  return jsonb_build_object(
    'state', 'authorized',
    'authorization_id', v_authorization.id,
    'offer_id', v_authorization.offer_id,
    'authorized_offer_updated_at',
      v_authorization.authorized_offer_updated_at,
    'expires_at', v_authorization.expires_at
  );
end;
$function$;

-- Reserve an offer and freeze all business/customer data used to render the
-- email.  Delivery RPC lock order is request advisory guard -> offer row ->
-- delivery row -> request row -> authorization row.
create or replace function public.prepare_quote_offer_delivery(
  p_authorization_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_offer_id bigint;
  v_user_id uuid;
  v_quote_request_id bigint;
  v_request public.quote_requests%rowtype;
  v_offer public.quote_offers%rowtype;
  v_delivery private.quote_offer_deliveries%rowtype;
  v_authorization private.quote_offer_delivery_authorizations%rowtype;
  v_delivery_found boolean;
  v_delivery_id uuid;
  v_email text;
  v_items jsonb;
  v_snapshot jsonb;
begin
  perform private.require_quote_delivery_service();

  select a.offer_id, a.actor_user_id, o.quote_request_id
    into v_offer_id, v_user_id, v_quote_request_id
  from private.quote_offer_delivery_authorizations a
  join public.quote_offers o on o.id = a.offer_id
  where a.id = p_authorization_id;
  if v_offer_id is null then
    raise exception 'delivery-authorization-not-found' using errcode = 'P0002';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended('quote-offer-' || v_quote_request_id::text, 0)
  );

  select o.* into v_offer
  from public.quote_offers o
  where o.id = v_offer_id
  for update;

  select d.* into v_delivery
  from private.quote_offer_deliveries d
  where d.offer_id = v_offer_id
  for update;
  v_delivery_found := found;

  select q.* into v_request
  from public.quote_requests q
  where q.id = v_quote_request_id
  for update;
  if not found then
    raise exception 'quote-request-not-found' using errcode = 'P0002';
  end if;

  select a.* into v_authorization
  from private.quote_offer_delivery_authorizations a
  where a.id = p_authorization_id
  for update;
  if not found
     or v_authorization.consumed_at is not null
     or v_authorization.expires_at <= clock_timestamp() then
    raise exception 'delivery-authorization-expired' using errcode = '42501';
  end if;

  if v_authorization.authorized_offer_updated_at
       is distinct from v_offer.updated_at then
    raise exception 'delivery-authorization-stale' using errcode = '40001';
  end if;

  -- Existing non-terminal deliveries can still reach the provider.  Recheck
  -- their customer snapshot under the same request-row lock before returning
  -- the frozen payload for a retry.
  if (not v_delivery_found
      or v_delivery.status in ('preparing', 'ready', 'sending', 'retryable_error'))
     and (
       v_offer.customer_snapshot is null
       or jsonb_typeof(v_offer.customer_snapshot) <> 'object'
     ) then
    raise exception 'offer-requires-resave' using errcode = '22023';
  end if;

  if (not v_delivery_found
      or v_delivery.status in ('preparing', 'ready', 'sending', 'retryable_error'))
     and (
       (v_offer.customer_snapshot ->> 'customer_name')
         is distinct from v_request.customer_name
       or lower(btrim(coalesce(v_offer.customer_snapshot ->> 'email', '')))
         is distinct from lower(btrim(coalesce(v_request.email, '')))
       or btrim(coalesce(v_offer.customer_snapshot ->> 'phone', ''))
         is distinct from btrim(coalesce(v_request.phone, ''))
       or btrim(coalesce(v_offer.customer_snapshot ->> 'project_type', ''))
         is distinct from btrim(coalesce(v_request.project_type, ''))
     ) then
    raise exception 'offer-snapshot-stale' using errcode = '40001';
  end if;

  update private.quote_offer_delivery_authorizations
  set consumed_at = now()
  where id = v_authorization.id;

  if v_delivery_found then
    return jsonb_build_object(
      'state', v_delivery.status,
      'delivery_id', v_delivery.id,
      'offer_id', v_delivery.offer_id,
      'recipient_email', v_delivery.recipient_email,
      'content_snapshot', v_delivery.content_snapshot,
      'provider_payload', v_delivery.provider_payload,
      'payload_sha256', v_delivery.payload_sha256,
      'idempotency_key', v_delivery.idempotency_key,
      'provider_message_id', v_delivery.provider_message_id,
      'lease_expires_at', v_delivery.lease_expires_at,
      'first_provider_attempt_at', v_delivery.first_provider_attempt_at
    );
  end if;

  if v_offer.status = 'sent' then
    return jsonb_build_object(
      'state', 'already_sent',
      'offer_id', v_offer.id,
      'provider_message_id', v_offer.provider_message_id
    );
  end if;
  if v_offer.status <> 'draft' then
    raise exception 'offer-not-draft' using errcode = '55000';
  end if;
  if v_request.status in ('ordered', 'closed') then
    raise exception 'quote-request-locked' using errcode = '55000';
  end if;

  v_email := lower(btrim(coalesce(v_offer.customer_snapshot ->> 'email', '')));
  if char_length(btrim(coalesce(
       v_offer.customer_snapshot ->> 'customer_name', ''
     ))) not between 2 and 200
     or char_length(btrim(coalesce(
       v_offer.customer_snapshot ->> 'project_type', ''
     ))) not between 1 and 100
     or char_length(v_email) not between 5 and 254
     or v_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' then
    raise exception 'offer-snapshot-invalid' using errcode = '22023';
  end if;

  if v_offer.gross_total <= 0
     or char_length(btrim(coalesce(v_offer.lead_time, ''))) = 0 then
    raise exception 'offer-not-sendable' using errcode = '22023';
  end if;
  if v_offer.valid_until is null
     or v_offer.valid_until
        < (current_timestamp at time zone 'Europe/Budapest')::date then
    raise exception 'offer-expired' using errcode = '22023';
  end if;

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'position', i.position,
        'description', i.description,
        'quantity', i.quantity,
        'unit', i.unit,
        'unit_net_price', i.unit_net_price,
        'line_net_total', i.line_net_total
      ) order by i.position
    ),
    '[]'::jsonb
  ) into v_items
  from public.quote_offer_items i
  where i.offer_id = v_offer.id;

  if jsonb_array_length(v_items) not between 1 and 50 then
    raise exception 'offer-items-invalid' using errcode = '22023';
  end if;

  v_snapshot := jsonb_build_object(
    'offer', jsonb_build_object(
      'id', v_offer.id,
      'offer_number', v_offer.offer_number,
      'version', v_offer.version,
      'kind', v_offer.kind,
      'currency', v_offer.currency,
      'vat_rate', v_offer.vat_rate,
      'net_total', v_offer.net_total,
      'vat_total', v_offer.vat_total,
      'gross_total', v_offer.gross_total,
      'deposit_percent', v_offer.deposit_percent,
      'deposit_amount', v_offer.deposit_amount,
      'valid_until', v_offer.valid_until,
      'lead_time', v_offer.lead_time,
      'customer_note', v_offer.customer_note
    ),
    'customer', jsonb_build_object(
      'customer_name', v_offer.customer_snapshot ->> 'customer_name',
      'email', v_email,
      'phone', v_offer.customer_snapshot ->> 'phone',
      'project_type', v_offer.customer_snapshot ->> 'project_type',
      'city', v_offer.customer_snapshot ->> 'city',
      'postcode', v_offer.customer_snapshot ->> 'postcode',
      'address', v_offer.customer_snapshot ->> 'address'
    ),
    'items', v_items
  );

  v_delivery_id := gen_random_uuid();
  insert into private.quote_offer_deliveries (
    id, offer_id, recipient_email, content_snapshot, idempotency_key, created_by
  ) values (
    v_delivery_id,
    v_offer.id,
    v_email,
    v_snapshot,
    'quote-offer/' || v_offer.id::text || '/' || v_delivery_id::text,
    v_user_id
  )
  returning * into v_delivery;

  return jsonb_build_object(
    'state', v_delivery.status,
    'delivery_id', v_delivery.id,
    'offer_id', v_delivery.offer_id,
    'recipient_email', v_delivery.recipient_email,
    'content_snapshot', v_delivery.content_snapshot,
    'provider_payload', v_delivery.provider_payload,
    'payload_sha256', v_delivery.payload_sha256,
    'idempotency_key', v_delivery.idempotency_key
  );
end;
$function$;

-- First writer wins: provider_payload is the exact JSON request body that will
-- be sent on every retry; its SHA-256 is computed and later verified in the DB.
create or replace function public.freeze_quote_offer_delivery_payload(
  p_delivery_id uuid,
  p_provider_payload text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_offer_id bigint;
  v_quote_request_id bigint;
  v_delivery private.quote_offer_deliveries%rowtype;
  v_payload jsonb;
  v_payload_sha256 text;
begin
  perform private.require_quote_delivery_service();

  select d.offer_id, o.quote_request_id
    into v_offer_id, v_quote_request_id
  from private.quote_offer_deliveries d
  join public.quote_offers o on o.id = d.offer_id
  where d.id = p_delivery_id;
  if v_offer_id is null then
    raise exception 'delivery-not-found' using errcode = 'P0002';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended('quote-offer-' || v_quote_request_id::text, 0)
  );
  perform 1 from public.quote_offers where id = v_offer_id for update;
  select d.* into v_delivery
  from private.quote_offer_deliveries d
  where d.id = p_delivery_id
  for update;
  perform 1 from public.quote_requests where id = v_quote_request_id for update;

  if v_delivery.provider_payload is not null then
    -- The first exact payload wins.  A concurrent invocation may have rendered
    -- with different environment data, but it must never alter an active lease
    -- or a provider-accepted/finalized delivery.  The caller continues with the
    -- already-frozen bytes and stable idempotency key.
    return jsonb_build_object(
      'state', v_delivery.status,
      'delivery_id', v_delivery.id,
      'provider_payload', v_delivery.provider_payload,
      'payload_sha256', v_delivery.payload_sha256,
      'idempotency_key', v_delivery.idempotency_key,
      'last_error_code', v_delivery.last_error_code,
      'payload_mismatch',
        v_delivery.provider_payload is distinct from p_provider_payload
    );
  end if;

  if v_delivery.status <> 'preparing' then
    raise exception 'delivery-payload-cannot-be-frozen' using errcode = '55000';
  end if;
  if p_provider_payload is null
     or char_length(p_provider_payload) not between 2 and 800000 then
    raise exception 'delivery-payload-invalid' using errcode = '22023';
  end if;

  begin
    v_payload := p_provider_payload::jsonb;
  exception
    when invalid_text_representation then
      raise exception 'delivery-payload-invalid' using errcode = '22023';
  end;

  if jsonb_typeof(v_payload) is distinct from 'object'
     or (v_payload - array[
       'from', 'to', 'reply_to', 'subject', 'html', 'text'
     ]::text[]) <> '{}'::jsonb
     or jsonb_typeof(v_payload -> 'from') is distinct from 'string'
     or jsonb_typeof(v_payload -> 'to') is distinct from 'array'
     or jsonb_typeof(v_payload -> 'reply_to') is distinct from 'string'
     or jsonb_typeof(v_payload -> 'subject') is distinct from 'string'
     or jsonb_typeof(v_payload -> 'html') is distinct from 'string'
     or jsonb_typeof(v_payload -> 'text') is distinct from 'string' then
    raise exception 'delivery-payload-invalid' using errcode = '22023';
  end if;

  if jsonb_array_length(v_payload -> 'to') <> 1
     or jsonb_typeof((v_payload -> 'to') -> 0) is distinct from 'string'
     or lower(btrim((v_payload -> 'to') ->> 0)) <> v_delivery.recipient_email
     or char_length(btrim(v_payload ->> 'from')) not between 3 and 320
     or char_length(btrim(v_payload ->> 'reply_to')) not between 5 and 254
     or char_length(btrim(v_payload ->> 'subject')) not between 1 and 200
     or char_length(v_payload ->> 'html') not between 1 and 500000
     or char_length(v_payload ->> 'text') not between 1 and 200000 then
    raise exception 'delivery-payload-invalid' using errcode = '22023';
  end if;

  v_payload_sha256 := encode(
    extensions.digest(convert_to(p_provider_payload, 'UTF8'), 'sha256'),
    'hex'
  );

  update private.quote_offer_deliveries
  set
    provider_payload = p_provider_payload,
    payload_sha256 = v_payload_sha256,
    status = 'ready',
    updated_at = now()
  where id = v_delivery.id
  returning * into v_delivery;

  return jsonb_build_object(
    'state', v_delivery.status,
    'delivery_id', v_delivery.id,
    'provider_payload', v_delivery.provider_payload,
    'payload_sha256', v_delivery.payload_sha256,
    'idempotency_key', v_delivery.idempotency_key
  );
end;
$function$;

create or replace function public.claim_quote_offer_delivery(
  p_delivery_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_offer_id bigint;
  v_quote_request_id bigint;
  v_request public.quote_requests%rowtype;
  v_offer public.quote_offers%rowtype;
  v_delivery private.quote_offer_deliveries%rowtype;
  v_lease_token uuid;
  v_actual_hash text;
begin
  perform private.require_quote_delivery_service();

  select d.offer_id, o.quote_request_id
    into v_offer_id, v_quote_request_id
  from private.quote_offer_deliveries d
  join public.quote_offers o on o.id = d.offer_id
  where d.id = p_delivery_id;
  if v_offer_id is null then
    raise exception 'delivery-not-found' using errcode = 'P0002';
  end if;

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
  select q.* into v_request
  from public.quote_requests q
  where q.id = v_quote_request_id
  for update;

  if v_delivery.status = 'finalized' then
    return jsonb_build_object(
      'state', 'finalized',
      'delivery_id', v_delivery.id,
      'provider_message_id', v_delivery.provider_message_id
    );
  end if;
  if v_delivery.status in ('needs_review', 'expired') then
    return jsonb_build_object(
      'state', v_delivery.status,
      'delivery_id', v_delivery.id,
      'last_error_code', v_delivery.last_error_code
    );
  end if;

  -- This is the final database gate before the provider request.  Compare the
  -- exact frozen delivery snapshot, not the mutable offer-side snapshot.
  if (v_delivery.content_snapshot #>> '{customer,customer_name}')
       is distinct from v_request.customer_name
     or lower(btrim(coalesce(
       v_delivery.content_snapshot #>> '{customer,email}', ''
     ))) is distinct from lower(btrim(coalesce(v_request.email, '')))
     or lower(btrim(coalesce(
       v_delivery.content_snapshot #>> '{customer,email}', ''
     ))) is distinct from v_delivery.recipient_email
     or btrim(coalesce(
       v_delivery.content_snapshot #>> '{customer,phone}', ''
     )) is distinct from btrim(coalesce(v_request.phone, ''))
     or btrim(coalesce(
       v_delivery.content_snapshot #>> '{customer,project_type}', ''
     )) is distinct from btrim(coalesce(v_request.project_type, '')) then
    raise exception 'offer-snapshot-stale' using errcode = '40001';
  end if;
  if v_delivery.provider_payload is null then
    return jsonb_build_object(
      'state', 'payload_required',
      'delivery_id', v_delivery.id
    );
  end if;

  if v_offer.status <> 'draft' then
    update private.quote_offer_deliveries
    set status = 'needs_review', last_error_code = 'offer-state-changed',
        lease_token = null, lease_expires_at = null, updated_at = now()
    where id = v_delivery.id;
    return jsonb_build_object(
      'state', 'needs_review', 'delivery_id', v_delivery.id,
      'last_error_code', 'offer-state-changed'
    );
  end if;

  if v_request.status in ('ordered', 'closed') then
    update private.quote_offer_deliveries
    set
      status = case when first_provider_attempt_at is null
                    then 'expired' else 'needs_review' end,
      last_error_code = 'quote-request-locked',
      lease_token = null,
      lease_expires_at = null,
      updated_at = now()
    where id = v_delivery.id
    returning * into v_delivery;
    return jsonb_build_object(
      'state', v_delivery.status, 'delivery_id', v_delivery.id,
      'last_error_code', v_delivery.last_error_code
    );
  end if;

  if v_offer.valid_until is null
     or v_offer.valid_until
        < (current_timestamp at time zone 'Europe/Budapest')::date then
    update private.quote_offer_deliveries
    set
      status = case when first_provider_attempt_at is null
                    then 'expired' else 'needs_review' end,
      last_error_code = 'offer-expired',
      lease_token = null,
      lease_expires_at = null,
      updated_at = now()
    where id = v_delivery.id
    returning * into v_delivery;
    return jsonb_build_object(
      'state', v_delivery.status, 'delivery_id', v_delivery.id,
      'last_error_code', v_delivery.last_error_code
    );
  end if;

  if v_delivery.lease_expires_at > now() then
    return jsonb_build_object(
      'state', 'send_in_progress',
      'delivery_id', v_delivery.id,
      'lease_expires_at', v_delivery.lease_expires_at
    );
  end if;

  -- Resend only retains idempotency keys for 24h.  Keep a safety margin.
  if v_delivery.first_provider_attempt_at is not null
     and v_delivery.first_provider_attempt_at
         <= now() - interval '23 hours 45 minutes' then
    update private.quote_offer_deliveries
    set status = 'needs_review',
        last_error_code = 'idempotency-window-expired',
        lease_token = null, lease_expires_at = null, updated_at = now()
    where id = v_delivery.id;
    return jsonb_build_object(
      'state', 'needs_review', 'delivery_id', v_delivery.id,
      'last_error_code', 'idempotency-window-expired'
    );
  end if;

  v_actual_hash := encode(
    extensions.digest(convert_to(v_delivery.provider_payload, 'UTF8'), 'sha256'),
    'hex'
  );
  if v_delivery.payload_sha256 is distinct from v_actual_hash then
    update private.quote_offer_deliveries
    set status = 'needs_review', last_error_code = 'payload-hash-mismatch',
        lease_token = null, lease_expires_at = null, updated_at = now()
    where id = v_delivery.id;
    return jsonb_build_object(
      'state', 'needs_review', 'delivery_id', v_delivery.id,
      'last_error_code', 'payload-hash-mismatch'
    );
  end if;

  if v_delivery.status not in ('ready', 'retryable_error', 'sending') then
    update private.quote_offer_deliveries
    set status = 'needs_review', last_error_code = 'invalid-delivery-state',
        lease_token = null, lease_expires_at = null, updated_at = now()
    where id = v_delivery.id;
    return jsonb_build_object(
      'state', 'needs_review', 'delivery_id', v_delivery.id,
      'last_error_code', 'invalid-delivery-state'
    );
  end if;

  v_lease_token := gen_random_uuid();
  update private.quote_offer_deliveries
  set
    status = 'sending',
    -- If the previous lease ended without a recorded provider outcome, preserve
    -- that uncertainty forever; a later definitive 4xx must not make reset safe.
    ambiguous_attempt_seen = ambiguous_attempt_seen or attempt_in_flight,
    attempt_in_flight = true,
    lease_token = v_lease_token,
    lease_expires_at = now() + interval '90 seconds',
    first_provider_attempt_at = coalesce(first_provider_attempt_at, now()),
    last_provider_attempt_at = now(),
    attempt_count = attempt_count + 1,
    last_error_code = null,
    last_http_status = null,
    updated_at = now()
  where id = v_delivery.id
  returning * into v_delivery;

  return jsonb_build_object(
    'state', 'claimed',
    'delivery_id', v_delivery.id,
    'offer_id', v_delivery.offer_id,
    'lease_token', v_delivery.lease_token,
    'lease_expires_at', v_delivery.lease_expires_at,
    'provider_payload', v_delivery.provider_payload,
    'payload_sha256', v_delivery.payload_sha256,
    'idempotency_key', v_delivery.idempotency_key,
    'attempt_count', v_delivery.attempt_count
  );
end;
$function$;

create or replace function public.record_quote_offer_delivery_error(
  p_delivery_id uuid,
  p_lease_token uuid,
  p_error_code text,
  p_http_status integer default null,
  p_needs_review boolean default false,
  p_hold_lease boolean default false,
  p_ambiguous_attempt boolean default false,
  p_provider_message_id text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_offer_id bigint;
  v_quote_request_id bigint;
  v_delivery private.quote_offer_deliveries%rowtype;
begin
  perform private.require_quote_delivery_service();
  if char_length(btrim(coalesce(p_error_code, ''))) not between 1 and 100
     or (p_http_status is not null and p_http_status not between 100 and 599) then
    raise exception 'delivery-error-metadata-invalid' using errcode = '22023';
  end if;
  if p_provider_message_id is not null
     and (
       not p_needs_review
       or char_length(btrim(p_provider_message_id)) not between 1 and 200
     ) then
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
    hashtextextended('quote-offer-' || v_quote_request_id::text, 0)
  );
  perform 1 from public.quote_offers where id = v_offer_id for update;
  select d.* into v_delivery
  from private.quote_offer_deliveries d
  where d.id = p_delivery_id
  for update;
  perform 1 from public.quote_requests where id = v_quote_request_id for update;

  if v_delivery.status = 'finalized' then
    if p_provider_message_id is not null
       and v_delivery.provider_message_id
           is distinct from btrim(p_provider_message_id) then
      raise exception 'provider-message-id-mismatch' using errcode = '55000';
    end if;
    return jsonb_build_object(
      'state', 'finalized', 'delivery_id', v_delivery.id,
      'provider_message_id', v_delivery.provider_message_id
    );
  end if;
  if v_delivery.status <> 'sending'
     or v_delivery.lease_token is distinct from p_lease_token then
    return jsonb_build_object(
      'state', 'lease_mismatch', 'delivery_id', v_delivery.id
    );
  end if;

  update private.quote_offer_deliveries
  set
    status = case when p_needs_review then 'needs_review'
                  else 'retryable_error' end,
    attempt_in_flight = false,
    ambiguous_attempt_seen = ambiguous_attempt_seen or p_ambiguous_attempt,
    provider_message_id = coalesce(
      provider_message_id,
      nullif(btrim(p_provider_message_id), '')
    ),
    last_error_code = btrim(p_error_code),
    last_http_status = p_http_status,
    lease_token = case when p_needs_review then null
                       when p_hold_lease then lease_token else null end,
    lease_expires_at = case when p_needs_review then null
                            when p_hold_lease then lease_expires_at else null end,
    updated_at = now()
  where id = v_delivery.id
  returning * into v_delivery;

  return jsonb_build_object(
    'state', v_delivery.status,
    'delivery_id', v_delivery.id,
    'last_error_code', v_delivery.last_error_code,
    'provider_message_id', v_delivery.provider_message_id,
    'lease_expires_at', v_delivery.lease_expires_at
  );
end;
$function$;

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

-- Explicit recovery: only a never-attempted delivery or its sole, definitively
-- rejected provider attempt may be removed.  Any ambiguous, unresolved,
-- repeated or provider-accepted attempt requires manual reconciliation instead.
create or replace function public.reset_quote_offer_delivery(
  p_authorization_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_offer_id bigint;
  v_quote_request_id bigint;
  v_authorization private.quote_offer_delivery_authorizations%rowtype;
  v_delivery private.quote_offer_deliveries%rowtype;
  v_offer_status text;
  v_offer_updated_at timestamptz;
  v_safe boolean;
begin
  perform private.require_quote_delivery_service();

  select a.offer_id, o.quote_request_id
    into v_offer_id, v_quote_request_id
  from private.quote_offer_delivery_authorizations a
  join public.quote_offers o on o.id = a.offer_id
  where a.id = p_authorization_id;
  if v_offer_id is null then
    raise exception 'delivery-authorization-not-found' using errcode = 'P0002';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended('quote-offer-' || v_quote_request_id::text, 0)
  );
  select o.status, o.updated_at into v_offer_status, v_offer_updated_at
  from public.quote_offers o
  where o.id = v_offer_id
  for update;
  select d.* into v_delivery
  from private.quote_offer_deliveries d
  where d.offer_id = v_offer_id
  for update;
  perform 1 from public.quote_requests where id = v_quote_request_id for update;
  select a.* into v_authorization
  from private.quote_offer_delivery_authorizations a
  where a.id = p_authorization_id
  for update;

  if not found
     or v_authorization.consumed_at is not null
     or v_authorization.expires_at <= clock_timestamp() then
    raise exception 'delivery-authorization-expired' using errcode = '42501';
  end if;

  if v_authorization.authorized_offer_updated_at
       is distinct from v_offer_updated_at then
    raise exception 'delivery-authorization-stale' using errcode = '40001';
  end if;

  if v_delivery.id is null then
    update private.quote_offer_delivery_authorizations
    set consumed_at = now() where id = v_authorization.id;
    return jsonb_build_object('state', 'no_delivery', 'offer_id', v_offer_id);
  end if;

  if v_delivery.lease_expires_at > now() then
    return jsonb_build_object(
      'state', 'send_in_progress',
      'delivery_id', v_delivery.id,
      'lease_expires_at', v_delivery.lease_expires_at
    );
  end if;

  v_safe := v_offer_status = 'draft'
    and v_delivery.provider_message_id is null
    and v_delivery.attempt_in_flight = false
    and v_delivery.ambiguous_attempt_seen = false
    and v_delivery.status not in ('provider_accepted', 'finalized')
    and (
      (
        v_delivery.first_provider_attempt_at is null
        and v_delivery.attempt_count = 0
      )
      or (
        v_delivery.attempt_count = 1
        and v_delivery.status = 'needs_review'
        and v_delivery.last_http_status in (400, 404, 405, 406, 410, 413, 415, 422)
        and coalesce(v_delivery.last_error_code, '') not in (
          'invalid_idempotent_request',
          'concurrent_idempotent_requests'
        )
      )
    );

  if not v_safe then
    raise exception 'delivery-reset-unsafe' using errcode = '55000';
  end if;

  delete from private.quote_offer_deliveries where id = v_delivery.id;
  update private.quote_offer_delivery_authorizations
  set consumed_at = now() where id = v_authorization.id;

  return jsonb_build_object(
    'state', 'reset',
    'offer_id', v_offer_id,
    'delivery_id', v_delivery.id
  );
end;
$function$;

-- RESTRICTIVE avoids an AAL2 condition being OR-ed away by existing permissive
-- admin policies.  PostgREST verifies token expiry; mutation RPCs additionally
-- validate exp inside private.require_quote_delivery_admin().
drop policy if exists hepa_admin_requires_aal2 on public.quote_requests;
create policy hepa_admin_requires_aal2
on public.quote_requests as restrictive
for all to authenticated
using (coalesce((select auth.jwt() ->> 'aal'), '') = 'aal2')
with check (coalesce((select auth.jwt() ->> 'aal'), '') = 'aal2');

drop policy if exists hepa_admin_requires_aal2 on public.quote_offers;
create policy hepa_admin_requires_aal2
on public.quote_offers as restrictive
for all to authenticated
using (coalesce((select auth.jwt() ->> 'aal'), '') = 'aal2')
with check (coalesce((select auth.jwt() ->> 'aal'), '') = 'aal2');

drop policy if exists hepa_admin_requires_aal2 on public.quote_offer_items;
create policy hepa_admin_requires_aal2
on public.quote_offer_items as restrictive
for all to authenticated
using (coalesce((select auth.jwt() ->> 'aal'), '') = 'aal2')
with check (coalesce((select auth.jwt() ->> 'aal'), '') = 'aal2');

create unique index if not exists quote_offers_provider_message_id_key
  on public.quote_offers(provider_message_id)
  where provider_message_id is not null;

-- Browser sessions read offer data but all offer/item writes now go through the
-- validated save RPC.  This removes the direct-DML path that could race a frozen
-- delivery snapshot.
revoke insert, update, delete on table public.quote_offers from authenticated;
revoke insert, update, delete on table public.quote_offer_items from authenticated;
revoke usage, select on sequence public.quote_offers_id_seq from authenticated;
revoke usage, select on sequence public.quote_offer_items_id_seq from authenticated;
revoke usage, select on sequence public.quote_offer_number_seq from authenticated;

revoke all on function public.mark_quote_offer_sent(bigint, text, text)
  from public, anon, authenticated, service_role;

revoke all on function public.save_quote_offer(
  bigint, text, numeric, numeric, date, text, text, text, jsonb, bigint, timestamptz
) from public, anon, authenticated, service_role;
revoke all on function public.authorize_quote_offer_delivery(bigint)
  from public, anon, authenticated, service_role;
revoke all on function public.prepare_quote_offer_delivery(uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.freeze_quote_offer_delivery_payload(uuid, text)
  from public, anon, authenticated, service_role;
revoke all on function public.claim_quote_offer_delivery(uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.record_quote_offer_delivery_error(
  uuid, uuid, text, integer, boolean, boolean, boolean, text
) from public, anon, authenticated, service_role;
revoke all on function public.finalize_quote_offer_delivery(uuid, uuid, text, integer)
  from public, anon, authenticated, service_role;
revoke all on function public.reset_quote_offer_delivery(uuid)
  from public, anon, authenticated, service_role;

grant execute on function public.save_quote_offer(
  bigint, text, numeric, numeric, date, text, text, text, jsonb, bigint, timestamptz
) to authenticated;
grant execute on function public.authorize_quote_offer_delivery(bigint)
  to authenticated;

grant execute on function public.prepare_quote_offer_delivery(uuid)
  to service_role;
grant execute on function public.freeze_quote_offer_delivery_payload(uuid, text)
  to service_role;
grant execute on function public.claim_quote_offer_delivery(uuid)
  to service_role;
grant execute on function public.record_quote_offer_delivery_error(
  uuid, uuid, text, integer, boolean, boolean, boolean, text
) to service_role;
grant execute on function public.finalize_quote_offer_delivery(uuid, uuid, text, integer)
  to service_role;
grant execute on function public.reset_quote_offer_delivery(uuid)
  to service_role;

notify pgrst, 'reload schema';

commit;

