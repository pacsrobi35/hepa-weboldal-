-- Only the public furniture/callback intake opts in to this protocol.
-- Existing records, manual entries and cutting submissions retain their behavior.
alter table public.quote_requests
  add column intake_state text not null default 'ready'
    check (intake_state in ('ingesting', 'ready')),
  add column intake_payload_hash text
    check (intake_payload_hash is null or intake_payload_hash ~ '^[0-9a-f]{64}$'),
  add column intake_expected_files integer
    check (intake_expected_files is null or intake_expected_files between 0 and 5);

-- Staff lists/counters must not show a partially uploaded request as actionable.
-- The ingestion service role bypasses RLS and can resume it safely.
create policy furniture_intake_must_be_ready
  on public.quote_requests as restrictive for select to authenticated
  using (intake_state = 'ready');

create function public.begin_furniture_quote_submission(
  p_submission_token uuid,
  p_payload_hash text,
  p_expected_files integer,
  p_request jsonb
)
returns table (quote_id bigint, state text, duplicate boolean)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_existing public.quote_requests%rowtype;
  v_id bigint;
begin
  if p_submission_token is null or p_payload_hash is null
     or p_payload_hash !~ '^[0-9a-f]{64}$'
     or p_expected_files is null or p_expected_files not between 0 and 5
     or p_request is null or jsonb_typeof(p_request) <> 'object' then
    raise exception 'invalid furniture submission' using errcode = '22023';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('furniture-request-' || p_submission_token::text, 0)
  );
  select * into v_existing from public.quote_requests
    where submission_token = p_submission_token for update;
  if found then
    if v_existing.source <> 'website' or v_existing.request_kind <> 'furniture' then
      return query select null::bigint, 'conflict'::text, true;
    elsif v_existing.intake_payload_hash is null then
      -- Pre-migration requests have no completion proof: never infer success.
      return query select v_existing.id, 'legacy'::text, true;
    elsif v_existing.intake_payload_hash <> p_payload_hash
       or v_existing.intake_expected_files is distinct from p_expected_files then
      return query select v_existing.id, 'conflict'::text, true;
    else
      return query select v_existing.id, v_existing.intake_state, true;
    end if;
    return;
  end if;

  insert into public.quote_requests (
    customer_name, phone, email, project_type, message, approximate_dimensions,
    wants_callback, wants_quote, wants_consultation, consent, source, request_kind,
    submission_token, intake_state, intake_payload_hash, intake_expected_files
  ) values (
    p_request->>'customer_name', p_request->>'phone', p_request->>'email',
    p_request->>'project_type', p_request->>'message', p_request->>'approximate_dimensions',
    (p_request->>'wants_callback')::boolean, (p_request->>'wants_quote')::boolean,
    (p_request->>'wants_consultation')::boolean, true, 'website', 'furniture',
    p_submission_token, 'ingesting', p_payload_hash, p_expected_files
  ) returning id into v_id;
  return query select v_id, 'ingesting'::text, false;
end;
$$;

create function public.finalize_furniture_quote_submission(
  p_quote_id bigint,
  p_payload_hash text,
  p_files jsonb
)
returns table (quote_id bigint, state text)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_quote public.quote_requests%rowtype;
  v_file record;
  v_count integer;
begin
  select * into v_quote from public.quote_requests where id = p_quote_id for update;
  if not found or v_quote.source <> 'website' or v_quote.request_kind <> 'furniture'
     or p_payload_hash is null or v_quote.intake_payload_hash is distinct from p_payload_hash then
    raise exception 'furniture submission mismatch' using errcode = '22023';
  end if;
  if v_quote.intake_state = 'ready' then
    return query select v_quote.id, 'ready'::text;
    return;
  end if;
  if p_files is null or jsonb_typeof(p_files) <> 'array'
     or jsonb_array_length(p_files) is distinct from v_quote.intake_expected_files then
    raise exception 'furniture attachments incomplete' using errcode = '22023';
  end if;
  select count(distinct f->>'storage_path') into v_count from jsonb_array_elements(p_files) f;
  if v_count <> v_quote.intake_expected_files then
    raise exception 'furniture attachment paths invalid' using errcode = '22023';
  end if;

  for v_file in select * from jsonb_to_recordset(p_files) as f(
    storage_path text, original_name text, content_type text, size_bytes bigint, content_sha256 text
  ) loop
    if v_file.storage_path is null
       or v_file.storage_path !~ ('^furniture/' || p_quote_id::text || '/[0-9]{2}-[0-9a-f]{24}\.(jpg|png|webp|pdf)$')
       or v_file.content_sha256 is null or v_file.content_sha256 !~ '^[0-9a-f]{64}$'
       or v_file.content_type is null
       or v_file.content_type not in ('image/jpeg', 'image/png', 'image/webp', 'application/pdf')
       or v_file.size_bytes is null or v_file.size_bytes not between 1 and 10485760 then
      raise exception 'furniture attachment invalid' using errcode = '22023';
    end if;
    if not exists (
      select 1 from storage.objects o
      where o.bucket_id = 'quote-request-files' and o.name = v_file.storage_path
        and (o.metadata->>'size')::bigint = v_file.size_bytes
    ) then
      raise exception 'furniture attachment missing in storage' using errcode = '22023';
    end if;
    insert into public.quote_request_files (
      quote_request_id, storage_path, original_name, content_type, size_bytes, content_sha256, file_purpose
    ) values (
      p_quote_id, v_file.storage_path, v_file.original_name, v_file.content_type,
      v_file.size_bytes, v_file.content_sha256, 'reference'
    );
  end loop;

  -- Metadata and completion become visible together, or neither does.
  update public.quote_requests set intake_state = 'ready' where id = p_quote_id;
  return query select p_quote_id, 'ready'::text;
end;
$$;

revoke all on function public.begin_furniture_quote_submission(uuid, text, integer, jsonb)
  from public, anon, authenticated;
revoke all on function public.finalize_furniture_quote_submission(bigint, text, jsonb)
  from public, anon, authenticated;
grant execute on function public.begin_furniture_quote_submission(uuid, text, integer, jsonb)
  to service_role;
grant execute on function public.finalize_furniture_quote_submission(bigint, text, jsonb)
  to service_role;

-- Public retries may recover a lost finalize response, but must not send mail
-- repeatedly after a provider's idempotency-key retention window expires.
create function public.claim_furniture_quote_notification(p_quote_id bigint, p_payload_hash text)
returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
begin
  update public.quote_requests
    set notification_error = 'notification-send-claimed'
    where id = p_quote_id and source = 'website' and request_kind = 'furniture'
      and intake_state = 'ready' and intake_payload_hash = p_payload_hash
      and notification_sent_at is null and notification_error is null;
  return found;
end;
$$;
revoke all on function public.claim_furniture_quote_notification(bigint, text)
  from public, anon, authenticated;
grant execute on function public.claim_furniture_quote_notification(bigint, text) to service_role;
