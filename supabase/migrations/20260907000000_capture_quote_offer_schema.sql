-- The quote-offer schema was originally created directly in production.
-- This migration captures that live state for repeatable rebuilds.

create sequence public.quote_offer_number_seq start with 1 increment by 1;

create table public.quote_offers (
  id bigint generated always as identity primary key,
  quote_request_id bigint not null
    references public.quote_requests(id) on delete cascade,
  offer_number text not null unique default (
    'HEPA-' || to_char(current_date, 'YYYY') || '-'
    || lpad(nextval('public.quote_offer_number_seq')::text, 5, '0')
  )
    constraint quote_offers_number_format_check
    check (offer_number ~ '^HEPA-[0-9]{4}-[0-9]{5,}$'),
  version integer not null
    constraint quote_offers_version_check
    check (version > 0),
  kind text not null default 'estimate'
    constraint quote_offers_kind_check
    check (kind = any (array['estimate', 'final'])),
  status text not null default 'draft'
    constraint quote_offers_status_check
    check (status = any (array['draft', 'sent', 'accepted', 'rejected', 'superseded'])),
  currency text not null default 'HUF'
    constraint quote_offers_currency_check
    check (currency = 'HUF'),
  vat_rate numeric(5,2) not null default 27
    constraint quote_offers_vat_rate_check
    check (vat_rate between 0 and 100),
  net_total numeric(16,2) not null default 0,
  vat_total numeric(16,2) not null default 0,
  gross_total numeric(16,2) not null default 0,
  deposit_percent numeric(5,2)
    constraint quote_offers_deposit_percent_check
    check (deposit_percent is null or deposit_percent between 0 and 100),
  deposit_amount numeric(16,2)
    constraint quote_offers_deposit_amount_check
    check (deposit_amount is null or deposit_amount >= 0),
  valid_until date,
  lead_time text
    constraint quote_offers_lead_time_check
    check (lead_time is null or char_length(lead_time) <= 200),
  customer_note text
    constraint quote_offers_customer_note_check
    check (customer_note is null or char_length(customer_note) <= 4000),
  internal_note text
    constraint quote_offers_internal_note_check
    check (internal_note is null or char_length(internal_note) <= 4000),
  sent_at timestamptz,
  sent_to text
    constraint quote_offers_sent_to_check
    check (sent_to is null or char_length(sent_to) <= 254),
  provider_message_id text
    constraint quote_offers_provider_message_id_check
    check (
      provider_message_id is null
      or char_length(provider_message_id) <= 200
    ),
  created_by uuid default auth.uid()
    references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint quote_offers_request_version_key
    unique (quote_request_id, version),
  constraint quote_offers_totals_check
    check (net_total >= 0 and vat_total >= 0 and gross_total >= 0)
);

create index quote_offers_request_created_idx
  on public.quote_offers (quote_request_id, created_at desc);
create index quote_offers_status_created_idx
  on public.quote_offers (status, created_at desc);
create index quote_offers_created_by_idx
  on public.quote_offers (created_by);
create unique index quote_offers_one_draft_per_request_idx
  on public.quote_offers (quote_request_id)
  where status = 'draft';

create table public.quote_offer_items (
  id bigint generated always as identity primary key,
  offer_id bigint not null
    references public.quote_offers(id) on delete cascade,
  position smallint not null
    constraint quote_offer_items_position_check
    check (position > 0),
  description text not null
    constraint quote_offer_items_description_check
    check (char_length(btrim(description)) between 2 and 300),
  quantity numeric(12,3) not null
    constraint quote_offer_items_quantity_check
    check (quantity > 0 and quantity <= 1000000),
  unit text not null default 'db'
    constraint quote_offer_items_unit_check
    check (char_length(btrim(unit)) between 1 and 20),
  unit_net_price numeric(16,2) not null
    constraint quote_offer_items_price_check
    check (unit_net_price between 0 and 99999999999999.99),
  line_net_total numeric(16,2)
    generated always as (round(quantity * unit_net_price, 2)) stored,
  created_at timestamptz not null default now(),
  constraint quote_offer_items_offer_position_key unique (offer_id, position)
);

create index quote_offer_items_offer_id_idx
  on public.quote_offer_items (offer_id);

create or replace function public.save_quote_offer(
  p_quote_request_id bigint,
  p_kind text,
  p_vat_rate numeric,
  p_deposit_percent numeric,
  p_valid_until date,
  p_lead_time text,
  p_customer_note text,
  p_internal_note text,
  p_items jsonb,
  p_offer_id bigint default null
)
returns bigint
language plpgsql
security invoker
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
begin
  if (select auth.uid()) is null or not exists (
    select 1 from public.admin_users
    where admin_users.user_id = (select auth.uid())
  ) then
    raise exception 'admin access required' using errcode = '42501';
  end if;

  if p_kind not in ('estimate', 'final') then
    raise exception 'invalid offer kind' using errcode = '22023';
  end if;
  if p_vat_rate is null or p_vat_rate < 0 or p_vat_rate > 100 then
    raise exception 'invalid vat rate' using errcode = '22023';
  end if;
  if p_deposit_percent is not null
     and (p_deposit_percent < 0 or p_deposit_percent > 100) then
    raise exception 'invalid deposit percent' using errcode = '22023';
  end if;
  if char_length(coalesce(p_lead_time, '')) > 200
     or char_length(coalesce(p_customer_note, '')) > 4000
     or char_length(coalesce(p_internal_note, '')) > 4000 then
    raise exception 'offer text is too long' using errcode = '22023';
  end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array'
     or jsonb_array_length(p_items) < 1
     or jsonb_array_length(p_items) > 50 then
    raise exception 'offer must have between 1 and 50 items' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended('quote-offer-' || p_quote_request_id::text, 0)
  );

  if not exists (
    select 1 from public.quote_requests
    where quote_requests.id = p_quote_request_id
  ) then
    raise exception 'quote request not found' using errcode = 'P0002';
  end if;

  if p_offer_id is null then
    select coalesce(max(quote_offers.version), 0) + 1
      into v_version
    from public.quote_offers
    where quote_offers.quote_request_id = p_quote_request_id;

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
    where quote_offers.id = p_offer_id
      and quote_offers.quote_request_id = p_quote_request_id
      and quote_offers.status = 'draft'
    returning quote_offers.id into v_offer_id;

    if v_offer_id is null then
      raise exception 'editable draft not found' using errcode = 'P0002';
    end if;

    delete from public.quote_offer_items
    where quote_offer_items.offer_id = v_offer_id;
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
        raise exception 'invalid item number' using errcode = '22023';
    end;

    if char_length(v_description) < 2
       or char_length(v_description) > 300
       or char_length(v_unit) < 1
       or char_length(v_unit) > 20
       or v_quantity <= 0
       or v_quantity > 1000000
       or v_unit_net_price < 0
       or v_unit_net_price > 99999999999999.99 then
      raise exception 'invalid offer item' using errcode = '22023';
    end if;

    insert into public.quote_offer_items (
      offer_id, position, description, quantity, unit, unit_net_price
    )
    values (
      v_offer_id, v_position, v_description, v_quantity, v_unit,
      v_unit_net_price
    );
  end loop;

  select coalesce(sum(quote_offer_items.line_net_total), 0)
    into v_net_total
  from public.quote_offer_items
  where quote_offer_items.offer_id = v_offer_id;

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
  where quote_offers.id = v_offer_id;

  update public.quote_requests
  set
    status = case
      when quote_requests.status in ('ordered', 'closed') then quote_requests.status
      else 'needs_quote'
    end,
    updated_at = now()
  where quote_requests.id = p_quote_request_id;

  return v_offer_id;
end;
$function$;

create or replace function public.mark_quote_offer_sent(
  p_offer_id bigint,
  p_sent_to text,
  p_provider_message_id text
)
returns void
language plpgsql
security invoker
set search_path = ''
as $function$
declare
  v_quote_request_id bigint;
begin
  if (select auth.uid()) is null or not exists (
    select 1 from public.admin_users
    where admin_users.user_id = (select auth.uid())
  ) then
    raise exception 'admin access required' using errcode = '42501';
  end if;

  if char_length(btrim(coalesce(p_sent_to, ''))) < 5
     or char_length(btrim(p_sent_to)) > 254
     or position('@' in p_sent_to) <= 1
     or char_length(coalesce(p_provider_message_id, '')) > 200 then
    raise exception 'invalid send metadata' using errcode = '22023';
  end if;

  select quote_offers.quote_request_id
    into v_quote_request_id
  from public.quote_offers
  where quote_offers.id = p_offer_id
    and quote_offers.status = 'draft'
  for update;

  if v_quote_request_id is null then
    raise exception 'sendable offer not found' using errcode = 'P0002';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended('quote-offer-' || v_quote_request_id::text, 0)
  );

  update public.quote_offers
  set status = 'superseded', updated_at = now()
  where quote_offers.quote_request_id = v_quote_request_id
    and quote_offers.id <> p_offer_id
    and quote_offers.status = 'sent';

  update public.quote_offers
  set
    status = 'sent',
    sent_at = now(),
    sent_to = lower(btrim(p_sent_to)),
    provider_message_id = nullif(btrim(p_provider_message_id), ''),
    updated_at = now()
  where quote_offers.id = p_offer_id
    and quote_offers.status = 'draft';

  if not found then
    raise exception 'sendable offer not found' using errcode = 'P0002';
  end if;

  update public.quote_requests
  set
    status = case
      when quote_requests.status in ('ordered', 'closed') then quote_requests.status
      else 'waiting'
    end,
    updated_at = now()
  where quote_requests.id = v_quote_request_id;
end;
$function$;

alter table public.quote_offers enable row level security;
alter table public.quote_offer_items enable row level security;

revoke all on table public.quote_offers from public, anon, authenticated;
revoke all on table public.quote_offer_items from public, anon, authenticated;
grant select, insert, update, delete on table public.quote_offers to authenticated;
grant select, insert, update, delete on table public.quote_offer_items to authenticated;
grant select, insert, update, delete on table public.quote_offers to service_role;
grant select, insert, update, delete on table public.quote_offer_items to service_role;

grant usage, select on sequence public.quote_offers_id_seq to authenticated, service_role;
grant usage, select on sequence public.quote_offer_items_id_seq to authenticated, service_role;
grant usage, select on sequence public.quote_offer_number_seq to authenticated, service_role;

create policy "admins can read quote offers"
on public.quote_offers for select to authenticated
using (
  exists (
    select 1 from public.admin_users
    where admin_users.user_id = (select auth.uid())
  )
);

create policy "admins can create quote offers"
on public.quote_offers for insert to authenticated
with check (
  created_by = (select auth.uid())
  and exists (
    select 1 from public.admin_users
    where admin_users.user_id = (select auth.uid())
  )
);

create policy "admins can update quote offers"
on public.quote_offers for update to authenticated
using (
  exists (
    select 1 from public.admin_users
    where admin_users.user_id = (select auth.uid())
  )
)
with check (
  exists (
    select 1 from public.admin_users
    where admin_users.user_id = (select auth.uid())
  )
);

create policy "admins can delete draft quote offers"
on public.quote_offers for delete to authenticated
using (
  status = 'draft'
  and exists (
    select 1 from public.admin_users
    where admin_users.user_id = (select auth.uid())
  )
);

create policy "admins can read quote offer items"
on public.quote_offer_items for select to authenticated
using (
  exists (
    select 1 from public.admin_users
    where admin_users.user_id = (select auth.uid())
  )
);

create policy "admins can create quote offer items"
on public.quote_offer_items for insert to authenticated
with check (
  exists (
    select 1 from public.admin_users
    where admin_users.user_id = (select auth.uid())
  )
);

create policy "admins can update quote offer items"
on public.quote_offer_items for update to authenticated
using (
  exists (
    select 1 from public.admin_users
    where admin_users.user_id = (select auth.uid())
  )
)
with check (
  exists (
    select 1 from public.admin_users
    where admin_users.user_id = (select auth.uid())
  )
);

create policy "admins can delete quote offer items"
on public.quote_offer_items for delete to authenticated
using (
  exists (
    select 1 from public.admin_users
    where admin_users.user_id = (select auth.uid())
  )
);

revoke all on function public.save_quote_offer(
  bigint, text, numeric, numeric, date, text, text, text, jsonb, bigint
) from public, anon;
grant execute on function public.save_quote_offer(
  bigint, text, numeric, numeric, date, text, text, text, jsonb, bigint
) to authenticated, service_role;

revoke all on function public.mark_quote_offer_sent(bigint, text, text)
  from public, anon;
grant execute on function public.mark_quote_offer_sent(bigint, text, text)
  to authenticated, service_role;
