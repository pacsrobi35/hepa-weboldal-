-- Manual intake retries must only acknowledge an identical original payload.
-- Historical rows remain nullable because their original form data cannot be
-- reconstructed safely from subsequently editable workflow fields.
alter table public.quote_requests
  add column if not exists manual_payload_hash text;

alter table public.quote_requests
  add constraint quote_requests_manual_payload_hash_check
    check (manual_payload_hash is null or manual_payload_hash ~ '^[0-9a-f]{64}$');

-- Existing storage paths are unique, but distinct manual paths can point to
-- duplicate content after a retry. Scope this index to the manual uploader so
-- the website's original intake flow keeps its existing behavior.
create unique index if not exists quote_request_files_quote_sha256_uidx
  on public.quote_request_files (quote_request_id, file_purpose, content_sha256)
  where content_sha256 is not null and storage_path like 'manual/%';
