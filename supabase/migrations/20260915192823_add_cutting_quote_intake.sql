begin;

alter table public.quote_requests
  add column request_kind text not null default 'furniture',
  add column company_name text;

alter table public.quote_requests
  add constraint quote_requests_request_kind_check
    check (request_kind = any (array['furniture', 'cutting'])),
  add constraint quote_requests_company_name_check
    check (
      company_name is null
      or char_length(btrim(company_name)) between 2 and 100
    );

alter table public.quote_requests
  drop constraint quote_requests_project_type_check,
  add constraint quote_requests_project_type_check
    check (
      project_type is null
      or project_type = any (array[
        'kitchen', 'wardrobe', 'entryway', 'bathroom',
        'living_room', 'office', 'custom', 'other', 'cutting'
      ])
    );

comment on column public.quote_requests.request_kind is
  'Top-level intake kind. Cutting requests remain separate from furniture project_type.';
comment on column public.quote_requests.company_name is
  'Optional company name supplied by the customer.';

alter table public.quote_request_files
  add column file_purpose text not null default 'reference',
  add column content_sha256 text;

alter table public.quote_request_files
  add constraint quote_request_files_file_purpose_check
    check (file_purpose = any (array['reference', 'cutting_list', 'help_attachment'])),
  add constraint quote_request_files_content_sha256_check
    check (content_sha256 is null or content_sha256 ~ '^[0-9a-f]{64}$');

alter table public.quote_request_files
  drop constraint quote_request_files_content_type_check,
  add constraint quote_request_files_content_type_check
    check (
      content_type = any (array[
        'image/jpeg',
        'image/png',
        'image/webp',
        'application/pdf',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'text/csv'
      ])
    );

update storage.buckets
set allowed_mime_types = array[
  'image/jpeg',
  'image/png',
  'image/webp',
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'text/csv'
]
where id = 'quote-request-files';

create table public.cutting_quote_requests (
  quote_request_id bigint primary key
    references public.quote_requests(id) on delete cascade,
  schema_version smallint not null default 1
    check (schema_version = 1),
  flow text not null
    check (flow = any (array['manual', 'upload', 'help'])),
  material_source text
    check (
      material_source is null
      or material_source = any (array['hepa', 'own', 'unknown'])
    ),
  size_basis text
    check (size_basis is null or size_basis = 'finished'),
  fulfillment text
    check (
      fulfillment is null
      or fulfillment = any (array['pickup', 'delivery', 'unknown'])
    ),
  postal_code text
    check (postal_code is null or postal_code ~ '^[1-9][0-9]{3}$'),
  target_date date,
  project_note text
    check (project_note is null or char_length(btrim(project_note)) between 1 and 2000),
  material_hint text
    check (material_hint is null or char_length(btrim(material_hint)) between 1 and 120),
  thickness_mm numeric(5,1)
    check (thickness_mm is null or thickness_mm between 1 and 100),
  help_topics text[] not null default '{}'::text[],
  help_description text
    check (help_description is null or char_length(btrim(help_description)) between 20 and 5000),
  submission_state text not null default 'ingesting'
    check (submission_state = any (array['ingesting', 'ready', 'failed'])),
  payload_hash text not null
    check (payload_hash ~ '^[0-9a-f]{64}$'),
  total_rows integer not null default 0
    check (total_rows between 0 and 500),
  total_pieces integer not null default 0
    check (total_pieces between 0 and 499500),
  total_area_m2 numeric(14,6) not null default 0
    check (total_area_m2 between 0 and 99999999),
  total_edge_m numeric(14,6) not null default 0
    check (total_edge_m between 0 and 99999999),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint cutting_quote_requests_flow_fields_check check (
    (
      flow in ('manual', 'upload')
      and material_source is not null
      and size_basis = 'finished'
      and fulfillment is not null
      and (
        (fulfillment = 'delivery' and postal_code is not null)
        or (fulfillment <> 'delivery' and postal_code is null)
      )
      and cardinality(help_topics) = 0
      and help_description is null
    )
    or (
      flow = 'help'
      and material_source is null
      and size_basis is null
      and fulfillment is null
      and postal_code is null
      and target_date is null
      and project_note is null
      and material_hint is null
      and thickness_mm is null
      and cardinality(help_topics) between 1 and 4
      and help_description is not null
    )
  ),
  constraint cutting_quote_requests_help_topics_check check (
    help_topics <@ array['material', 'size', 'edge', 'delivery']::text[]
  )
);

create table public.cutting_quote_materials (
  id bigint generated always as identity primary key,
  quote_request_id bigint not null
    references public.cutting_quote_requests(quote_request_id) on delete cascade,
  position integer not null check (position between 1 and 50),
  client_material_id text not null
    check (char_length(btrim(client_material_id)) between 1 and 100),
  name text not null
    check (char_length(btrim(name)) between 1 and 120),
  thickness_mm numeric(5,1) not null
    check (thickness_mm between 1 and 100),
  unique (quote_request_id, position),
  unique (quote_request_id, client_material_id),
  unique (id, quote_request_id)
);

create table public.cutting_quote_items (
  id bigint generated always as identity primary key,
  quote_request_id bigint not null
    references public.cutting_quote_requests(quote_request_id) on delete cascade,
  material_id bigint not null,
  position integer not null check (position between 1 and 500),
  label text
    check (label is null or char_length(btrim(label)) between 1 and 100),
  length_mm numeric(8,1) not null check (length_mm between 10 and 5000),
  width_mm numeric(8,1) not null check (width_mm between 10 and 5000),
  quantity integer not null check (quantity between 1 and 999),
  edge_code text not null
    check (edge_code = any (array[
      '0-0', '0-1', '0-2',
      '1-0', '1-1', '1-2',
      '2-0', '2-1', '2-2'
    ])),
  edge_material_type text
    check (
      edge_material_type is null
      or char_length(btrim(edge_material_type)) between 1 and 120
    ),
  note text
    check (note is null or char_length(btrim(note)) between 1 and 500),
  area_m2 numeric(14,6) generated always as (
    round((length_mm * width_mm * quantity) / 1000000::numeric, 6)
  ) stored,
  edge_length_m numeric(14,6) generated always as (
    round((
      (
        split_part(edge_code, '-', 1)::integer * length_mm
        + split_part(edge_code, '-', 2)::integer * width_mm
      ) * quantity
    ) / 1000::numeric, 6)
  ) stored,
  constraint cutting_quote_items_edge_material_check check (
    (edge_code = '0-0' and edge_material_type is null)
    or (edge_code <> '0-0' and edge_material_type is not null)
  ),
  unique (quote_request_id, position),
  constraint cutting_quote_items_material_request_fkey
    foreign key (material_id, quote_request_id)
    references public.cutting_quote_materials(id, quote_request_id)
    on delete cascade
);

create table private.cutting_quote_notification_outbox (
  quote_request_id bigint primary key
    references public.cutting_quote_requests(quote_request_id) on delete cascade,
  event_key text not null default 'new-cutting-request'
    check (event_key = 'new-cutting-request'),
  status text not null default 'pending'
    check (status = any (array['pending', 'sending', 'retryable_error', 'sent'])),
  attempt_count integer not null default 0 check (attempt_count between 0 and 100),
  next_attempt_at timestamptz not null default now(),
  provider_message_id text,
  last_error text
    check (last_error is null or char_length(last_error) <= 500),
  sent_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint cutting_quote_notification_state_check check (
    (status = 'sent' and sent_at is not null and provider_message_id is not null)
    or (status <> 'sent' and sent_at is null)
  )
);

create table private.cutting_quote_reconciliation (
  quote_request_id bigint primary key
    references public.cutting_quote_requests(quote_request_id) on delete cascade,
  reason text not null
    check (char_length(btrim(reason)) between 1 and 200),
  occurrence_count integer not null default 1
    check (occurrence_count between 1 and 1000),
  resolved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index cutting_quote_requests_state_created_idx
  on public.cutting_quote_requests(submission_state, created_at desc);
create index cutting_quote_materials_request_idx
  on public.cutting_quote_materials(quote_request_id, position);
create index cutting_quote_items_request_idx
  on public.cutting_quote_items(quote_request_id, position);
create index cutting_quote_items_material_idx
  on public.cutting_quote_items(material_id);
create index cutting_quote_notification_pending_idx
  on private.cutting_quote_notification_outbox(status, next_attempt_at)
  where status <> 'sent';
create index cutting_quote_reconciliation_open_idx
  on private.cutting_quote_reconciliation(updated_at)
  where resolved_at is null;

alter table public.cutting_quote_requests enable row level security;
alter table public.cutting_quote_materials enable row level security;
alter table public.cutting_quote_items enable row level security;

revoke all on public.cutting_quote_requests,
  public.cutting_quote_materials,
  public.cutting_quote_items
from public, anon, authenticated;

grant select on public.cutting_quote_requests,
  public.cutting_quote_materials,
  public.cutting_quote_items
to authenticated;

grant select, insert, update, delete on public.cutting_quote_requests,
  public.cutting_quote_materials,
  public.cutting_quote_items
to service_role;

grant select, insert, update on public.quote_workflows to service_role;

revoke all on sequence public.cutting_quote_materials_id_seq,
  public.cutting_quote_items_id_seq
from public, anon, authenticated;

grant usage, select on sequence public.cutting_quote_materials_id_seq,
  public.cutting_quote_items_id_seq
to service_role;

revoke all on private.cutting_quote_notification_outbox,
  private.cutting_quote_reconciliation
from public, anon, authenticated;

grant usage on schema private to service_role;
grant select, insert, update, delete on private.cutting_quote_notification_outbox,
  private.cutting_quote_reconciliation
to service_role;

create policy hepa_cutting_admin_select
on public.cutting_quote_requests
for select to authenticated
using (
  coalesce((select auth.jwt() ->> 'aal'), '') = 'aal2'
  and exists (
    select 1 from public.admin_users
    where user_id = (select auth.uid())
  )
);

create policy hepa_cutting_materials_admin_select
on public.cutting_quote_materials
for select to authenticated
using (
  coalesce((select auth.jwt() ->> 'aal'), '') = 'aal2'
  and exists (
    select 1 from public.admin_users
    where user_id = (select auth.uid())
  )
);

create policy hepa_cutting_items_admin_select
on public.cutting_quote_items
for select to authenticated
using (
  coalesce((select auth.jwt() ->> 'aal'), '') = 'aal2'
  and exists (
    select 1 from public.admin_users
    where user_id = (select auth.uid())
  )
);

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
    'company_name', q.company_name,
    'email', q.email,
    'phone', q.phone,
    'request_kind', q.request_kind,
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

create or replace function private.guard_quote_request_delivery_identity()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if btrim(coalesce(new.customer_name, ''))
       is not distinct from btrim(coalesce(old.customer_name, ''))
     and btrim(coalesce(new.company_name, ''))
       is not distinct from btrim(coalesce(old.company_name, ''))
     and lower(btrim(coalesce(new.email, '')))
       is not distinct from lower(btrim(coalesce(old.email, '')))
     and btrim(coalesce(new.phone, ''))
       is not distinct from btrim(coalesce(old.phone, ''))
     and new.request_kind is not distinct from old.request_kind
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

create or replace function public.create_cutting_quote_request(
  p_request jsonb
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $function$
declare
  v_submission_token uuid;
  v_flow text;
  v_quote_id bigint;
  v_existing_state text;
  v_existing_hash text;
  v_material_count integer;
  v_item_count integer;
  v_totals record;
begin
  if jsonb_typeof(p_request) <> 'object' then
    raise exception 'invalid-request-payload' using errcode = '22023';
  end if;

  begin
    v_submission_token := (p_request ->> 'submissionToken')::uuid;
  exception when others then
    raise exception 'invalid-submission-token' using errcode = '22023';
  end;

  v_flow := p_request ->> 'flow';
  if v_flow is null or v_flow not in ('manual', 'upload', 'help') then
    raise exception 'invalid-flow' using errcode = '22023';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('cutting-request-' || v_submission_token::text, 0)
  );

  select q.id, c.submission_state, c.payload_hash
  into v_quote_id, v_existing_state, v_existing_hash
  from public.quote_requests q
  join public.cutting_quote_requests c on c.quote_request_id = q.id
  where q.submission_token = v_submission_token
    and q.request_kind = 'cutting';

  if v_quote_id is not null then
    if v_existing_hash is distinct from (p_request ->> 'payloadHash') then
      return jsonb_build_object(
        'quote_id', v_quote_id,
        'duplicate', true,
        'state', 'conflict'
      );
    end if;

    return jsonb_build_object(
      'quote_id', v_quote_id,
      'duplicate', true,
      'state', v_existing_state
    );
  end if;

  if jsonb_typeof(coalesce(p_request #> '{details,materials}', '[]'::jsonb)) <> 'array'
     or jsonb_typeof(coalesce(p_request #> '{details,items}', '[]'::jsonb)) <> 'array' then
    raise exception 'invalid-cutting-collections' using errcode = '22023';
  end if;

  insert into public.quote_requests (
    status,
    customer_name,
    company_name,
    email,
    phone,
    project_type,
    postcode,
    preferred_contact,
    message,
    consent,
    source,
    approximate_dimensions,
    wants_callback,
    wants_quote,
    wants_consultation,
    submission_token,
    request_kind
  ) values (
    case when v_flow = 'help' then 'new' else 'needs_quote' end,
    p_request #>> '{contact,name}',
    nullif(btrim(p_request #>> '{contact,companyName}'), ''),
    nullif(btrim(p_request #>> '{contact,email}'), ''),
    nullif(btrim(p_request #>> '{contact,phone}'), ''),
    'cutting',
    nullif(btrim(p_request #>> '{logistics,postalCode}'), ''),
    p_request #>> '{contact,preferredContact}',
    nullif(btrim(p_request ->> 'message'), ''),
    true,
    'website',
    nullif(btrim(p_request ->> 'approximateDimensions'), ''),
    false,
    v_flow in ('manual', 'upload'),
    v_flow = 'help',
    v_submission_token,
    'cutting'
  )
  returning id into v_quote_id;

  insert into public.cutting_quote_requests (
    quote_request_id,
    schema_version,
    flow,
    material_source,
    size_basis,
    fulfillment,
    postal_code,
    target_date,
    project_note,
    material_hint,
    thickness_mm,
    help_topics,
    help_description,
    payload_hash
  ) values (
    v_quote_id,
    1,
    v_flow,
    nullif(p_request #>> '{details,materialSource}', ''),
    nullif(p_request #>> '{details,sizeBasis}', ''),
    nullif(p_request #>> '{logistics,fulfillment}', ''),
    nullif(p_request #>> '{logistics,postalCode}', ''),
    nullif(p_request #>> '{logistics,targetDate}', '')::date,
    nullif(btrim(p_request #>> '{logistics,note}'), ''),
    nullif(btrim(p_request #>> '{details,materialHint}'), ''),
    nullif(p_request #>> '{details,thicknessMm}', '')::numeric,
    case
      when jsonb_typeof(p_request #> '{details,topics}') = 'array'
      then array(select jsonb_array_elements_text(p_request #> '{details,topics}'))
      else '{}'::text[]
    end,
    nullif(btrim(p_request #>> '{details,description}'), ''),
    p_request ->> 'payloadHash'
  );

  if v_flow = 'manual' then
    insert into public.cutting_quote_materials (
      quote_request_id,
      position,
      client_material_id,
      name,
      thickness_mm
    )
    select
      v_quote_id,
      x.position,
      btrim(x.client_id),
      btrim(x.name),
      x.thickness_mm
    from jsonb_to_recordset(p_request #> '{details,materials}') as x(
      position integer,
      client_id text,
      name text,
      thickness_mm numeric
    );

    get diagnostics v_material_count = row_count;

    insert into public.cutting_quote_items (
      quote_request_id,
      material_id,
      position,
      label,
      length_mm,
      width_mm,
      quantity,
      edge_code,
      edge_material_type,
      note
    )
    select
      v_quote_id,
      m.id,
      x.position,
      nullif(btrim(x.label), ''),
      x.length_mm,
      x.width_mm,
      x.quantity,
      x.edge_code,
      nullif(btrim(x.edge_material_type), ''),
      nullif(btrim(x.note), '')
    from jsonb_to_recordset(p_request #> '{details,items}') as x(
      position integer,
      material_client_id text,
      label text,
      length_mm numeric,
      width_mm numeric,
      quantity integer,
      edge_code text,
      edge_material_type text,
      note text
    )
    join public.cutting_quote_materials m
      on m.quote_request_id = v_quote_id
     and m.client_material_id = x.material_client_id;

    get diagnostics v_item_count = row_count;

    if v_material_count <> jsonb_array_length(p_request #> '{details,materials}')
       or v_item_count <> jsonb_array_length(p_request #> '{details,items}')
       or v_material_count < 1
       or v_item_count < 1 then
      raise exception 'invalid-cutting-relations' using errcode = '22023';
    end if;

    select
      count(*)::integer as total_rows,
      coalesce(sum(quantity), 0)::integer as total_pieces,
      coalesce(sum(area_m2), 0)::numeric as total_area_m2,
      coalesce(sum(edge_length_m), 0)::numeric as total_edge_m
    into v_totals
    from public.cutting_quote_items
    where quote_request_id = v_quote_id;

    update public.cutting_quote_requests
    set
      total_rows = v_totals.total_rows,
      total_pieces = v_totals.total_pieces,
      total_area_m2 = v_totals.total_area_m2,
      total_edge_m = v_totals.total_edge_m,
      updated_at = clock_timestamp()
    where quote_request_id = v_quote_id;
  end if;

  if coalesce((p_request ->> 'isTest')::boolean, false) then
    insert into public.quote_workflows (quote_request_id, is_test)
    values (v_quote_id, true)
    on conflict (quote_request_id) do update set
      is_test = true,
      updated_at = clock_timestamp();
  end if;

  return jsonb_build_object(
    'quote_id', v_quote_id,
    'duplicate', false,
    'state', 'ingesting'
  );
end;
$function$;

create or replace function public.finalize_cutting_quote_request(
  p_quote_request_id bigint,
  p_files jsonb
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $function$
declare
  v_state text;
  v_flow text;
  v_file_count integer;
  v_expected_file_count integer;
begin
  if jsonb_typeof(p_files) <> 'array' or jsonb_array_length(p_files) > 5 then
    raise exception 'invalid-file-metadata' using errcode = '22023';
  end if;

  v_expected_file_count := jsonb_array_length(p_files);
  perform pg_catalog.pg_advisory_xact_lock(p_quote_request_id);

  select submission_state, flow into v_state, v_flow
  from public.cutting_quote_requests
  where quote_request_id = p_quote_request_id
  for update;

  if v_state is null then
    raise exception 'cutting-request-not-found' using errcode = 'P0002';
  end if;

  if (v_flow = 'manual' and v_expected_file_count <> 0)
     or (v_flow = 'upload' and v_expected_file_count < 1) then
    raise exception 'invalid-file-count-for-flow' using errcode = '22023';
  end if;

  if v_state = 'ready' then
    insert into private.cutting_quote_notification_outbox (quote_request_id)
    values (p_quote_request_id)
    on conflict (quote_request_id) do nothing;

    return jsonb_build_object(
      'quote_id', p_quote_request_id,
      'duplicate', true,
      'state', 'ready'
    );
  end if;

  if v_state <> 'ingesting' then
    raise exception 'cutting-request-not-finalizable' using errcode = '55000';
  end if;

  insert into public.quote_request_files (
    quote_request_id,
    storage_path,
    original_name,
    content_type,
    size_bytes,
    file_purpose,
    content_sha256
  )
  select
    p_quote_request_id,
    x.storage_path,
    x.original_name,
    x.content_type,
    x.size_bytes,
    x.file_purpose,
    x.content_sha256
  from jsonb_to_recordset(p_files) as x(
    storage_path text,
    original_name text,
    content_type text,
    size_bytes bigint,
    file_purpose text,
    content_sha256 text
  );

  get diagnostics v_file_count = row_count;

  if v_file_count <> v_expected_file_count then
    raise exception 'file-metadata-count-mismatch' using errcode = '22023';
  end if;

  update public.cutting_quote_requests
  set submission_state = 'ready', updated_at = clock_timestamp()
  where quote_request_id = p_quote_request_id;

  insert into private.cutting_quote_notification_outbox (quote_request_id)
  values (p_quote_request_id)
  on conflict (quote_request_id) do nothing;

  update private.cutting_quote_reconciliation
  set resolved_at = clock_timestamp(), updated_at = clock_timestamp()
  where quote_request_id = p_quote_request_id
    and resolved_at is null;

  return jsonb_build_object(
    'quote_id', p_quote_request_id,
    'duplicate', false,
    'state', 'ready'
  );
end;
$function$;

create or replace function public.mark_cutting_quote_reconciliation(
  p_quote_request_id bigint,
  p_reason text
)
returns void
language plpgsql
security invoker
set search_path = ''
as $function$
begin
  if char_length(btrim(coalesce(p_reason, ''))) not between 1 and 200 then
    raise exception 'invalid-reconciliation-reason' using errcode = '22023';
  end if;

  insert into private.cutting_quote_reconciliation (
    quote_request_id,
    reason
  ) values (
    p_quote_request_id,
    btrim(p_reason)
  )
  on conflict (quote_request_id) do update set
    reason = excluded.reason,
    occurrence_count = least(
      private.cutting_quote_reconciliation.occurrence_count + 1,
      1000
    ),
    resolved_at = null,
    updated_at = clock_timestamp();
end;
$function$;

create or replace function public.claim_cutting_quote_notification(
  p_quote_request_id bigint
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $function$
declare
  v_status text;
  v_updated_at timestamptz;
  v_attempt_count integer;
begin
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'cutting-notification-' || p_quote_request_id::text,
      0
    )
  );

  insert into private.cutting_quote_notification_outbox (quote_request_id)
  select p_quote_request_id
  from public.cutting_quote_requests
  where quote_request_id = p_quote_request_id
    and submission_state = 'ready'
  on conflict (quote_request_id) do nothing;

  select status, updated_at, attempt_count
  into v_status, v_updated_at, v_attempt_count
  from private.cutting_quote_notification_outbox
  where quote_request_id = p_quote_request_id
  for update;

  if v_status is null then
    return jsonb_build_object('state', 'not-ready');
  end if;

  if v_status = 'sent' then
    return jsonb_build_object('state', 'sent');
  end if;

  if v_status = 'sending'
     and v_updated_at > clock_timestamp() - interval '5 minutes' then
    return jsonb_build_object('state', 'busy');
  end if;

  update private.cutting_quote_notification_outbox
  set
    status = 'sending',
    attempt_count = least(attempt_count + 1, 100),
    last_error = null,
    updated_at = clock_timestamp()
  where quote_request_id = p_quote_request_id
  returning attempt_count into v_attempt_count;

  return jsonb_build_object(
    'state', 'send',
    'attempt', v_attempt_count
  );
end;
$function$;

create or replace function public.complete_cutting_quote_notification(
  p_quote_request_id bigint,
  p_sent boolean,
  p_provider_message_id text default null,
  p_error text default null
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $function$
declare
  v_status text;
begin
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'cutting-notification-' || p_quote_request_id::text,
      0
    )
  );

  select status into v_status
  from private.cutting_quote_notification_outbox
  where quote_request_id = p_quote_request_id
  for update;

  if v_status is null then
    raise exception 'notification-outbox-not-found' using errcode = 'P0002';
  end if;

  if v_status = 'sent' then
    return jsonb_build_object('state', 'sent');
  end if;

  if p_sent then
    if char_length(btrim(coalesce(p_provider_message_id, ''))) < 1 then
      raise exception 'provider-message-id-required' using errcode = '22023';
    end if;

    update private.cutting_quote_notification_outbox
    set
      status = 'sent',
      provider_message_id = left(btrim(p_provider_message_id), 300),
      last_error = null,
      sent_at = clock_timestamp(),
      updated_at = clock_timestamp()
    where quote_request_id = p_quote_request_id;

    update public.quote_requests
    set
      notification_sent_at = coalesce(notification_sent_at, clock_timestamp()),
      notification_error = null,
      updated_at = clock_timestamp()
    where id = p_quote_request_id;

    return jsonb_build_object('state', 'sent');
  end if;

  update private.cutting_quote_notification_outbox
  set
    status = 'retryable_error',
    last_error = left(coalesce(nullif(btrim(p_error), ''), 'notification-failed'), 500),
    next_attempt_at = clock_timestamp(),
    updated_at = clock_timestamp()
  where quote_request_id = p_quote_request_id;

  update public.quote_requests
  set
    notification_error = left(
      coalesce(nullif(btrim(p_error), ''), 'notification-failed'),
      500
    ),
    updated_at = clock_timestamp()
  where id = p_quote_request_id;

  return jsonb_build_object('state', 'retryable_error');
end;
$function$;

revoke all on function public.create_cutting_quote_request(jsonb)
from public, anon, authenticated, service_role;
revoke all on function public.finalize_cutting_quote_request(bigint, jsonb)
from public, anon, authenticated, service_role;
revoke all on function public.mark_cutting_quote_reconciliation(bigint, text)
from public, anon, authenticated, service_role;
revoke all on function public.claim_cutting_quote_notification(bigint)
from public, anon, authenticated, service_role;
revoke all on function public.complete_cutting_quote_notification(bigint, boolean, text, text)
from public, anon, authenticated, service_role;

grant execute on function public.create_cutting_quote_request(jsonb)
to service_role;
grant execute on function public.finalize_cutting_quote_request(bigint, jsonb)
to service_role;
grant execute on function public.mark_cutting_quote_reconciliation(bigint, text)
to service_role;
grant execute on function public.claim_cutting_quote_notification(bigint)
to service_role;
grant execute on function public.complete_cutting_quote_notification(bigint, boolean, text, text)
to service_role;

notify pgrst, 'reload schema';


commit;
