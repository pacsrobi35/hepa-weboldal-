alter table public.quote_requests
  add column if not exists submission_token uuid;

create unique index if not exists quote_requests_submission_token_uidx
  on public.quote_requests (submission_token)
  where submission_token is not null;

comment on column public.quote_requests.submission_token is
  'Böngészőnként egy beküldési próbálkozást azonosító token a véletlen duplikációk megelőzésére.';
