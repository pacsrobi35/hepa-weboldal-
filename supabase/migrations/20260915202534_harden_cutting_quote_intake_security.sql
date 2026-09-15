begin;

alter table private.cutting_quote_notification_outbox
  enable row level security;

alter table private.cutting_quote_reconciliation
  enable row level security;

create index cutting_quote_items_material_request_idx
  on public.cutting_quote_items(material_id, quote_request_id);

alter policy hepa_cutting_admin_select
  on public.cutting_quote_requests
  using (
    coalesce(((select auth.jwt()) ->> 'aal'), '') = 'aal2'
    and exists (
      select 1
      from public.admin_users
      where user_id = (select auth.uid())
    )
  );

alter policy hepa_cutting_materials_admin_select
  on public.cutting_quote_materials
  using (
    coalesce(((select auth.jwt()) ->> 'aal'), '') = 'aal2'
    and exists (
      select 1
      from public.admin_users
      where user_id = (select auth.uid())
    )
  );

alter policy hepa_cutting_items_admin_select
  on public.cutting_quote_items
  using (
    coalesce(((select auth.jwt()) ->> 'aal'), '') = 'aal2'
    and exists (
      select 1
      from public.admin_users
      where user_id = (select auth.uid())
    )
  );

notify pgrst, 'reload schema';

commit;
