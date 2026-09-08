create table public.quote_submission_attempts (
  id bigint generated always as identity primary key,
  fingerprint_hash text not null
    constraint quote_submission_attempts_fingerprint_hash_check
    check (fingerprint_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now()
);

comment on table public.quote_submission_attempts is
  'Rövid ideig őrzött, vissza nem fejthető ujjlenyomatok az ajánlatkérő túlterhelésének korlátozásához.';

create index quote_submission_attempts_fingerprint_created_idx
  on public.quote_submission_attempts (fingerprint_hash, created_at desc);

create index quote_submission_attempts_created_idx
  on public.quote_submission_attempts (created_at);

alter table public.quote_submission_attempts enable row level security;

revoke all on table public.quote_submission_attempts from public, anon, authenticated;
grant select, insert, delete on table public.quote_submission_attempts to service_role;

revoke all on sequence public.quote_submission_attempts_id_seq from public, anon, authenticated;
grant usage, select on sequence public.quote_submission_attempts_id_seq to service_role;

alter table public.quote_requests
  add column notification_sent_at timestamptz,
  add column notification_error text;

alter table public.quote_requests
  add constraint quote_requests_notification_error_length
  check (notification_error is null or char_length(notification_error) <= 500);
