-- Allow authenticated staff to record quote requests received outside the website.
alter table public.quote_requests
  drop constraint quote_requests_source_check,
  add constraint quote_requests_source_check
    check (
      source = any (
        array['website', 'email', 'phone', 'paper', 'in_person', 'other']
      )
    );

alter table public.quote_requests
  alter column phone drop not null,
  drop constraint quote_requests_phone_check,
  add constraint quote_requests_phone_check
    check (
      phone is null
      or char_length(btrim(phone)) between 6 and 40
    ),
  add constraint quote_requests_contact_check
    check (
      nullif(btrim(phone), '') is not null
      or nullif(btrim(email), '') is not null
    ),
  drop constraint quote_requests_preferred_contact_check,
  add constraint quote_requests_preferred_contact_check
    check (
      (
        preferred_contact = 'phone'
        and nullif(btrim(phone), '') is not null
      )
      or (
        preferred_contact = 'email'
        and nullif(btrim(email), '') is not null
      )
    );

alter table public.quote_requests
  drop constraint quote_requests_message_check,
  add constraint quote_requests_message_check
    check (
      message is null
      or char_length(btrim(message)) between 3 and 5000
    );

alter table public.quote_requests
  add column entered_by uuid
    references auth.users(id) on delete set null;

create index quote_requests_entered_by_idx
  on public.quote_requests (entered_by)
  where entered_by is not null;

comment on column public.quote_requests.source is
  'Origin of the request: website, email, phone, paper, in person, or other.';

comment on column public.quote_requests.entered_by is
  'Authenticated staff member who manually recorded the request; null for website submissions.';