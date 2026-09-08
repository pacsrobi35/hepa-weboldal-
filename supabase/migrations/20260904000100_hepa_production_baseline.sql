-- Reconstructed baseline of the HEPA production schema.
--
-- Production already contained these objects before migration tracking was
-- enabled. This file is used for clean rebuilds; on the existing production
-- project its version is marked as applied without executing the statements.

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null
    constraint profiles_display_name_length
    check (char_length(btrim(display_name)) between 2 and 80),
  company text
    constraint profiles_company_length
    check (company is null or char_length(company) <= 120),
  job_title text
    constraint profiles_job_title_length
    check (job_title is null or char_length(job_title) <= 120),
  phone text
    constraint profiles_phone_length
    check (phone is null or char_length(phone) <= 40),
  bio text
    constraint profiles_bio_length
    check (bio is null or char_length(bio) <= 500),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.admin_users (
  user_id uuid primary key references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);

create table public.quote_requests (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  status text not null default 'new'
    constraint quote_requests_status_check
    check (status = any (array['new', 'needs_quote', 'waiting', 'ordered', 'closed'])),
  customer_name text not null
    constraint quote_requests_customer_name_check
    check (char_length(btrim(customer_name)) between 2 and 100),
  email text
    constraint quote_requests_email_check
    check (
      email is null
      or (
        char_length(btrim(email)) between 5 and 254
        and position('@' in email) > 1
      )
    ),
  phone text not null
    constraint quote_requests_phone_check
    check (char_length(btrim(phone)) between 6 and 40),
  project_type text
    constraint quote_requests_project_type_check
    check (
      project_type is null
      or project_type = any (
        array[
          'kitchen', 'wardrobe', 'entryway', 'bathroom',
          'living_room', 'office', 'custom', 'other'
        ]
      )
    ),
  postcode text
    constraint quote_requests_postcode_check
    check (postcode is null or char_length(postcode) <= 20),
  city text
    constraint quote_requests_city_check
    check (city is null or char_length(city) <= 120),
  budget_range text
    constraint quote_requests_budget_range_check
    check (budget_range is null or char_length(budget_range) <= 60),
  preferred_contact text not null default 'phone'
    constraint quote_requests_preferred_contact_check
    check (preferred_contact = any (array['phone', 'email'])),
  message text
    constraint quote_requests_message_check
    check (
      message is null
      or char_length(btrim(message)) between 3 and 4000
    ),
  consent boolean not null
    constraint quote_requests_consent_check
    check (consent is true),
  source text not null default 'website'
    constraint quote_requests_source_check
    check (source = 'website'),
  approximate_dimensions text
    constraint quote_requests_approximate_dimensions_check
    check (
      approximate_dimensions is null
      or char_length(approximate_dimensions) <= 500
    ),
  wants_callback boolean not null default false,
  wants_quote boolean not null default false,
  wants_consultation boolean not null default false
);

create index quote_requests_status_created_at_idx
  on public.quote_requests (status, created_at desc);

create table public.quote_request_files (
  id bigint generated always as identity primary key,
  quote_request_id bigint not null
    references public.quote_requests(id) on delete cascade,
  storage_path text not null unique
    constraint quote_request_files_storage_path_check
    check (char_length(storage_path) between 3 and 500),
  original_name text not null
    constraint quote_request_files_original_name_check
    check (char_length(original_name) between 1 and 255),
  content_type text not null
    constraint quote_request_files_content_type_check
    check (
      content_type = any (
        array['image/jpeg', 'image/png', 'image/webp', 'application/pdf']
      )
    ),
  size_bytes bigint not null
    constraint quote_request_files_size_bytes_check
    check (size_bytes between 1 and 10485760),
  created_at timestamptz not null default now()
);

create index quote_request_files_quote_request_id_idx
  on public.quote_request_files (quote_request_id);

alter table public.profiles enable row level security;
alter table public.admin_users enable row level security;
alter table public.quote_requests enable row level security;
alter table public.quote_request_files enable row level security;

revoke all on table public.profiles from public, anon, authenticated;
revoke all on table public.admin_users from public, anon, authenticated;
revoke all on table public.quote_requests from public, anon, authenticated;
revoke all on table public.quote_request_files from public, anon, authenticated;

grant select, insert, update on table public.profiles to authenticated;
grant select on table public.admin_users to authenticated;
grant select on table public.quote_requests to authenticated;
grant update (status, updated_at) on table public.quote_requests to authenticated;
grant select on table public.quote_request_files to authenticated;

grant select, insert, update, delete on table public.profiles to service_role;
grant select, insert, update, delete on table public.admin_users to service_role;
grant select, insert, update, delete on table public.quote_requests to service_role;
grant select, insert, update, delete on table public.quote_request_files to service_role;
grant usage, select on sequence public.quote_requests_id_seq to service_role;
grant usage, select on sequence public.quote_request_files_id_seq to service_role;

create policy "profiles_select_own"
on public.profiles for select to authenticated
using ((select auth.uid()) = id);

create policy "profiles_insert_own"
on public.profiles for insert to authenticated
with check ((select auth.uid()) = id);

create policy "profiles_update_own"
on public.profiles for update to authenticated
using ((select auth.uid()) = id)
with check ((select auth.uid()) = id);

create policy "users can read own admin membership"
on public.admin_users for select to authenticated
using ((select auth.uid()) = user_id);

create policy "admins can read quote requests"
on public.quote_requests for select to authenticated
using (
  exists (
    select 1 from public.admin_users
    where admin_users.user_id = (select auth.uid())
  )
);

create policy "admins can update quote requests"
on public.quote_requests for update to authenticated
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

create policy "admins can read quote request files"
on public.quote_request_files for select to authenticated
using (
  exists (
    select 1 from public.admin_users
    where admin_users.user_id = (select auth.uid())
  )
);

insert into storage.buckets (
  id, name, public, file_size_limit, allowed_mime_types
)
values (
  'quote-request-files',
  'quote-request-files',
  false,
  10485760,
  array['image/jpeg', 'image/png', 'image/webp', 'application/pdf']::text[]
);

create policy "admins can read quote storage objects"
on storage.objects for select to authenticated
using (
  bucket_id = 'quote-request-files'
  and exists (
    select 1 from public.admin_users
    where admin_users.user_id = (select auth.uid())
  )
);
