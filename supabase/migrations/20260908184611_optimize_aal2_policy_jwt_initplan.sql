
begin;

alter policy "hepa_admin_requires_aal2"
  on public.quote_requests
  using (((select auth.jwt()) ->> 'aal') = 'aal2')
  with check (((select auth.jwt()) ->> 'aal') = 'aal2');

alter policy "hepa_admin_requires_aal2"
  on public.quote_request_files
  using (((select auth.jwt()) ->> 'aal') = 'aal2')
  with check (((select auth.jwt()) ->> 'aal') = 'aal2');

alter policy "hepa_admin_requires_aal2"
  on public.quote_offers
  using (((select auth.jwt()) ->> 'aal') = 'aal2')
  with check (((select auth.jwt()) ->> 'aal') = 'aal2');

alter policy "hepa_admin_requires_aal2"
  on public.quote_offer_items
  using (((select auth.jwt()) ->> 'aal') = 'aal2')
  with check (((select auth.jwt()) ->> 'aal') = 'aal2');

alter policy "hepa_admin_requires_aal2"
  on public.reference_images
  using (((select auth.jwt()) ->> 'aal') = 'aal2')
  with check (((select auth.jwt()) ->> 'aal') = 'aal2');

alter policy "hepa_admin_buckets_require_aal2"
  on storage.objects
  using (
    bucket_id not in ('reference-images', 'quote-request-files')
    or ((select auth.jwt()) ->> 'aal') = 'aal2'
  )
  with check (
    bucket_id not in ('reference-images', 'quote-request-files')
    or ((select auth.jwt()) ->> 'aal') = 'aal2'
  );

commit;
