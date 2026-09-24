-- Creating the quote, cutting detail, workflow, and initial activity in one
-- transaction prevents a process interruption from leaving a partial case.
alter table public.quote_requests
  add column manual_intake_state text not null default 'ready',
  add column manual_expected_files integer not null default 0,
  add constraint quote_requests_manual_intake_state_check
    check (manual_intake_state in ('ingesting', 'ready')),
  add constraint quote_requests_manual_expected_files_check
    check (manual_expected_files between 0 and 5);

create or replace function public.create_manual_quote_request(p_request jsonb)
returns jsonb
language plpgsql
security invoker
set search_path to ''
as $function$
declare
  v_token uuid;
  v_user uuid;
  v_hash text;
  v_kind text;
  v_entry_type text;
  v_expected_files integer;
  v_quote_id bigint;
  v_existing record;
begin
  if jsonb_typeof(p_request) <> 'object' then
    raise exception 'invalid-manual-request' using errcode = '22023';
  end if;
  v_token := (p_request ->> 'submission_token')::uuid;
  v_user := (p_request ->> 'entered_by')::uuid;
  v_hash := p_request ->> 'payload_hash';
  v_kind := p_request ->> 'request_kind';
  v_entry_type := p_request ->> 'entry_type';
  v_expected_files := (p_request ->> 'expected_files')::integer;
  if v_hash is null or v_hash !~ '^[0-9a-f]{64}$' or
     v_kind is null or v_kind not in ('furniture', 'cutting') or
     v_entry_type is null or v_entry_type not in ('quote_request', 'direct_order') or
     v_expected_files is null or v_expected_files not between 0 and 5 or
     nullif(btrim(p_request #>> '{quote,customer_name}'), '') is null then
    raise exception 'invalid-manual-request' using errcode = '22023';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('manual-request-' || v_token::text, 0)
  );
  select id, entered_by, manual_payload_hash, manual_intake_state
    into v_existing
  from public.quote_requests where submission_token = v_token;
  if found then
    if v_existing.entered_by is distinct from v_user then
      return pg_catalog.jsonb_build_object('state', 'conflict');
    end if;
    if v_existing.manual_payload_hash is distinct from v_hash then
      return pg_catalog.jsonb_build_object('state', 'conflict', 'quote_id', v_existing.id);
    end if;
    return pg_catalog.jsonb_build_object(
      'state', v_existing.manual_intake_state, 'quote_id', v_existing.id, 'duplicate', true
    );
  end if;

  insert into public.quote_requests (
    approximate_dimensions, budget_range, city, company_name, consent,
    customer_name, email, entered_by, manual_payload_hash, manual_intake_state,
    manual_expected_files, message, phone, postcode, preferred_contact,
    project_type, request_kind, request_confirmed_at, source, status,
    submission_token, wants_callback, wants_consultation, wants_quote
  ) values (
    nullif(p_request #>> '{quote,approximate_dimensions}', ''),
    nullif(p_request #>> '{quote,budget_range}', ''),
    nullif(p_request #>> '{quote,city}', ''),
    nullif(p_request #>> '{quote,company_name}', ''),
    null, p_request #>> '{quote,customer_name}',
    nullif(p_request #>> '{quote,email}', ''),
    v_user, v_hash,
    case when v_expected_files > 0 then 'ingesting' else 'ready' end,
    v_expected_files, nullif(p_request #>> '{quote,message}', ''),
    nullif(p_request #>> '{quote,phone}', ''),
    nullif(p_request #>> '{quote,postcode}', ''),
    p_request #>> '{quote,preferred_contact}',
    nullif(p_request #>> '{quote,project_type}', ''),
    v_kind, pg_catalog.clock_timestamp(),
    p_request #>> '{quote,source}',
    case when v_entry_type = 'direct_order' then 'ordered' else 'needs_quote' end,
    v_token,
    coalesce((p_request #>> '{quote,wants_callback}')::boolean, false),
    coalesce((p_request #>> '{quote,wants_consultation}')::boolean, false),
    v_entry_type = 'quote_request'
  ) returning id into v_quote_id;

  if v_kind = 'cutting' then
    insert into public.cutting_quote_requests (
      flow, fulfillment, material_source, payload_hash, postal_code,
      project_note, quote_request_id, size_basis, submission_state, target_date
    ) values (
      case when v_expected_files > 0 then 'upload' else 'manual' end,
      p_request #>> '{cutting,fulfillment}',
      p_request #>> '{cutting,material_source}',
      v_hash,
      nullif(p_request #>> '{cutting,postal_code}', ''),
      nullif(p_request #>> '{cutting,project_note}', ''),
      v_quote_id, 'finished', 'ready',
      nullif(p_request #>> '{cutting,target_date}', '')::date
    );
  end if;

  insert into public.quote_workflows (
    address, agreed_total, deposit_paid, next_action, next_action_date,
    next_action_kind, next_action_time, other_paid, promised_date,
    quote_request_id, work_stage, updated_at
  ) values (
    nullif(p_request #>> '{workflow,address}', ''),
    nullif(p_request #>> '{workflow,agreed_total}', '')::numeric,
    coalesce((p_request #>> '{workflow,deposit_paid}')::numeric, 0),
    nullif(p_request #>> '{workflow,next_action}', ''),
    nullif(p_request #>> '{workflow,next_action_date}', '')::date,
    nullif(p_request #>> '{workflow,next_action_kind}', ''),
    nullif(p_request #>> '{workflow,next_action_time}', '')::time,
    coalesce((p_request #>> '{workflow,other_paid}')::numeric, 0),
    nullif(p_request #>> '{workflow,promised_date}', '')::date,
    v_quote_id,
    case when v_entry_type = 'direct_order' and v_kind = 'cutting'
      then 'cutting_received' else 'not_started' end,
    pg_catalog.clock_timestamp()
  );

  insert into public.quote_activities (quote_request_id, body, created_by)
  values (
    v_quote_id,
    case when v_entry_type = 'direct_order'
      then 'Közvetlen rendelés kézzel rögzítve.'
      else 'Árajánlatkérés kézzel rögzítve.' end,
    v_user
  );
  return pg_catalog.jsonb_build_object(
    'state', case when v_expected_files > 0 then 'ingesting' else 'ready' end,
    'quote_id', v_quote_id, 'duplicate', false
  );
end;
$function$;

-- Only the server-side Edge Function, after checking AAL2/admin membership,
-- may call this service-role-only initializer. The function is not exposed to
-- client tokens even though it lives in an API-exposed schema.
revoke all on function public.create_manual_quote_request(jsonb) from public, anon, authenticated;
grant execute on function public.create_manual_quote_request(jsonb) to service_role;

create or replace function public.finalize_manual_quote_request(
  p_quote_id bigint,
  p_submission_token uuid,
  p_payload_hash text,
  p_expected_files jsonb
)
returns boolean
language plpgsql
security invoker
set search_path to ''
as $function$
declare
  v_quote record;
  v_matching integer;
begin
  if jsonb_typeof(p_expected_files) <> 'array' then
    raise exception 'invalid-manual-files' using errcode = '22023';
  end if;
  select submission_token, manual_payload_hash, manual_expected_files,
         manual_intake_state
    into v_quote
  from public.quote_requests
  where id = p_quote_id for update;
  if not found then
    return false;
  end if;
  if v_quote.submission_token is distinct from p_submission_token or
     v_quote.manual_payload_hash is distinct from p_payload_hash or
     pg_catalog.jsonb_array_length(p_expected_files) <> v_quote.manual_expected_files then
    return false;
  end if;
  select count(*) into v_matching
  from pg_catalog.jsonb_to_recordset(p_expected_files) as expected(sha256 text, purpose text)
  join public.quote_request_files f
    on f.quote_request_id = p_quote_id
   and f.content_sha256 = expected.sha256
   and f.file_purpose = expected.purpose
   and f.storage_path like 'manual/%';
  if v_matching <> v_quote.manual_expected_files then
    return false;
  end if;
  if v_quote.manual_intake_state <> 'ready' then
    update public.quote_requests set manual_intake_state = 'ready'
    where id = p_quote_id;
  end if;
  return true;
end;
$function$;

revoke all on function public.finalize_manual_quote_request(bigint, uuid, text, jsonb)
  from public, anon, authenticated;
grant execute on function public.finalize_manual_quote_request(bigint, uuid, text, jsonb)
  to service_role;
