
begin;

alter table public.quote_requests enable row level security;
alter table public.quote_request_files enable row level security;
alter table public.quote_offers enable row level security;
alter table public.quote_offer_items enable row level security;
alter table public.reference_images enable row level security;

drop policy if exists "hepa_admin_requires_aal2" on public.quote_requests;
create policy "hepa_admin_requires_aal2"
  on public.quote_requests
  as restrictive
  for all
  to authenticated
  using ((select auth.jwt()->>'aal') = 'aal2')
  with check ((select auth.jwt()->>'aal') = 'aal2');

drop policy if exists "hepa_admin_requires_aal2" on public.quote_request_files;
create policy "hepa_admin_requires_aal2"
  on public.quote_request_files
  as restrictive
  for all
  to authenticated
  using ((select auth.jwt()->>'aal') = 'aal2')
  with check ((select auth.jwt()->>'aal') = 'aal2');

drop policy if exists "hepa_admin_requires_aal2" on public.quote_offers;
create policy "hepa_admin_requires_aal2"
  on public.quote_offers
  as restrictive
  for all
  to authenticated
  using ((select auth.jwt()->>'aal') = 'aal2')
  with check ((select auth.jwt()->>'aal') = 'aal2');

drop policy if exists "hepa_admin_requires_aal2" on public.quote_offer_items;
create policy "hepa_admin_requires_aal2"
  on public.quote_offer_items
  as restrictive
  for all
  to authenticated
  using ((select auth.jwt()->>'aal') = 'aal2')
  with check ((select auth.jwt()->>'aal') = 'aal2');

drop policy if exists "hepa_admin_requires_aal2" on public.reference_images;
create policy "hepa_admin_requires_aal2"
  on public.reference_images
  as restrictive
  for all
  to authenticated
  using ((select auth.jwt()->>'aal') = 'aal2')
  with check ((select auth.jwt()->>'aal') = 'aal2');

drop policy if exists "hepa_admin_buckets_require_aal2" on storage.objects;
create policy "hepa_admin_buckets_require_aal2"
  on storage.objects
  as restrictive
  for all
  to authenticated
  using (
    bucket_id not in ('reference-images', 'quote-request-files')
    or (select auth.jwt()->>'aal') = 'aal2'
  )
  with check (
    bucket_id not in ('reference-images', 'quote-request-files')
    or (select auth.jwt()->>'aal') = 'aal2'
  );

commit;
