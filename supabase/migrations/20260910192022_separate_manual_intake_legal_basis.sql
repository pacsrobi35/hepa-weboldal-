-- Keep the public-form consent distinct from a staff-confirmed manual request.
alter table public.quote_requests
  alter column consent drop not null,
  drop constraint quote_requests_consent_check,
  add column request_confirmed_at timestamptz,
  add constraint quote_requests_intake_basis_check
    check (
      (
        source = 'website'
        and consent is true
        and request_confirmed_at is null
      )
      or (
        source <> 'website'
        and consent is null
        and request_confirmed_at is not null
      )
    );

comment on column public.quote_requests.consent is
  'Explicit privacy consent submitted by the customer on the public website; null for manually recorded requests.';

comment on column public.quote_requests.request_confirmed_at is
  'When a staff member confirmed that the customer genuinely requested contact or a quote.';