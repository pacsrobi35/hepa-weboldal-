create index reference_images_uploaded_by_idx
  on public.reference_images (uploaded_by);

drop policy "published reference images are public" on public.reference_images;
drop policy "admins can read all reference images" on public.reference_images;

create policy "published reference images are public"
on public.reference_images
for select
to anon
using (is_published);

create policy "authenticated users can read allowed reference images"
on public.reference_images
for select
to authenticated
using (
  is_published
  or exists (
    select 1
    from public.admin_users
    where admin_users.user_id = (select auth.uid())
  )
);
