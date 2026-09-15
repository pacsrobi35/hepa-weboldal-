-- HEPA internal customer workflow. Apply only to the verified HEPA project.
-- Existing public quote ingestion and reference tables are deliberately untouched.
begin;

create table if not exists public.quote_workflows (
  quote_request_id bigint primary key references public.quote_requests(id) on delete cascade,
  address text check (char_length(address) <= 1000),
  is_test boolean not null default false,
  next_action text check (char_length(next_action) between 1 and 500),
  next_action_date date,
  next_action_time time without time zone,
  next_action_kind text check (next_action_kind in ('callback','quote','survey','installation','other')),
  callback_completed_at timestamptz,
  work_stage text not null default 'not_started'
    check (work_stage in ('not_started','survey','design','materials','production','installation','completed')),
  survey_date date,
  installation_date date,
  agreed_total numeric(14,2) check (agreed_total >= 0 and agreed_total <= 999999999999),
  deposit_paid numeric(14,2) not null default 0 check (deposit_paid >= 0 and deposit_paid <= 999999999999),
  other_paid numeric(14,2) not null default 0 check (other_paid >= 0 and other_paid <= 999999999999),
  updated_at timestamptz not null default now(),
  constraint quote_workflows_task_complete check (
    (next_action is null and next_action_date is null and next_action_kind is null and next_action_time is null)
    or (next_action is not null and next_action_date is not null and next_action_kind is not null)
  )
);

create table if not exists public.quote_activities (
  id bigint generated always as identity primary key,
  quote_request_id bigint not null references public.quote_requests(id) on delete cascade,
  body text not null check (char_length(btrim(body)) between 1 and 4000),
  created_at timestamptz not null default now(),
  created_by uuid not null default auth.uid() references auth.users(id)
);

create index if not exists quote_workflows_next_action_idx
  on public.quote_workflows(next_action_date) where next_action is not null and not is_test;
create index if not exists quote_activities_request_created_idx
  on public.quote_activities(quote_request_id, created_at desc, id desc);

alter table public.quote_workflows enable row level security;
alter table public.quote_activities enable row level security;
revoke all on public.quote_workflows, public.quote_activities from public, anon, authenticated;
grant select, insert, update on public.quote_workflows to authenticated;
grant select on public.quote_activities to authenticated;
grant insert (quote_request_id, body, created_by) on public.quote_activities to authenticated;
revoke all on sequence public.quote_activities_id_seq from public, anon, authenticated;
grant usage on sequence public.quote_activities_id_seq to authenticated;

-- The existing quote_requests policies already restrict every read/write to
-- registered admins with AAL2. Extend only editable columns, not the audience.
grant update (customer_name,email,phone,preferred_contact,city,postcode,project_type,approximate_dimensions,budget_range,message)
  on public.quote_requests to authenticated;

create table if not exists public.quote_offer_templates (
  id bigint generated always as identity primary key,
  name text not null check (char_length(btrim(name)) between 1 and 80),
  kind text not null default 'estimate' check (kind in ('estimate','final')),
  vat_rate numeric not null default 27 check (vat_rate >= 0 and vat_rate <= 100),
  deposit_percent numeric not null default 30 check (deposit_percent >= 0 and deposit_percent <= 100),
  lead_time text check (char_length(lead_time) <= 200),
  customer_note text check (char_length(customer_note) <= 4000),
  items jsonb not null check (jsonb_typeof(items) = 'array' and jsonb_array_length(items) between 1 and 50),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid not null default auth.uid() references auth.users(id)
);
create unique index if not exists quote_offer_templates_name_idx on public.quote_offer_templates(lower(btrim(name)));
alter table public.quote_offer_templates enable row level security;
revoke all on public.quote_offer_templates from public, anon, authenticated;
grant select, delete on public.quote_offer_templates to authenticated;
grant insert(name,kind,vat_rate,deposit_percent,lead_time,customer_note,items,created_by)
  on public.quote_offer_templates to authenticated;
revoke all on sequence public.quote_offer_templates_id_seq from public,anon,authenticated;
grant usage on sequence public.quote_offer_templates_id_seq to authenticated;
drop policy if exists hepa_template_select on public.quote_offer_templates;
create policy hepa_template_select on public.quote_offer_templates for select to authenticated
using ((select auth.jwt()->>'aal') = 'aal2' and exists (
  select 1 from public.admin_users where user_id = (select auth.uid())
));
drop policy if exists hepa_template_insert on public.quote_offer_templates;
create policy hepa_template_insert on public.quote_offer_templates for insert to authenticated
with check (created_by = (select auth.uid()) and (select auth.jwt()->>'aal') = 'aal2' and exists (
  select 1 from public.admin_users where user_id = (select auth.uid())
));
drop policy if exists hepa_template_delete on public.quote_offer_templates;
create policy hepa_template_delete on public.quote_offer_templates for delete to authenticated
using ((select auth.jwt()->>'aal') = 'aal2' and exists (
  select 1 from public.admin_users where user_id = (select auth.uid())
));

drop policy if exists hepa_workflow_select on public.quote_workflows;
create policy hepa_workflow_select on public.quote_workflows for select to authenticated
using ((select auth.jwt()->>'aal') = 'aal2' and exists (
  select 1 from public.admin_users where user_id = (select auth.uid())
));
drop policy if exists hepa_workflow_insert on public.quote_workflows;
create policy hepa_workflow_insert on public.quote_workflows for insert to authenticated
with check ((select auth.jwt()->>'aal') = 'aal2' and exists (
  select 1 from public.admin_users where user_id = (select auth.uid())
));
drop policy if exists hepa_workflow_update on public.quote_workflows;
create policy hepa_workflow_update on public.quote_workflows for update to authenticated
using ((select auth.jwt()->>'aal') = 'aal2' and exists (
  select 1 from public.admin_users where user_id = (select auth.uid())
))
with check ((select auth.jwt()->>'aal') = 'aal2' and exists (
  select 1 from public.admin_users where user_id = (select auth.uid())
));
drop policy if exists hepa_activity_select on public.quote_activities;
create policy hepa_activity_select on public.quote_activities for select to authenticated
using ((select auth.jwt()->>'aal') = 'aal2' and exists (
  select 1 from public.admin_users where user_id = (select auth.uid())
));
drop policy if exists hepa_activity_insert on public.quote_activities;
create policy hepa_activity_insert on public.quote_activities for insert to authenticated
with check (created_by = (select auth.uid()) and (select auth.jwt()->>'aal') = 'aal2' and exists (
  select 1 from public.admin_users where user_id = (select auth.uid())
));

create or replace function public.manage_quote_workflow(
  p_quote_request_id bigint,
  p_operation text,
  p_expected_quote_updated_at timestamptz default null,
  p_expected_workflow_updated_at timestamptz default null,
  p_contact jsonb default '{}'::jsonb,
  p_workflow jsonb default '{}'::jsonb,
  p_body text default null
) returns bigint
language plpgsql security invoker set search_path = ''
as $$
declare
  v_quote public.quote_requests%rowtype;
  v_workflow public.quote_workflows%rowtype;
  v_new_workflow public.quote_workflows%rowtype;
  v_activity text;
  v_activity_id bigint;
  v_customer_name text;
  v_email text;
  v_phone text;
  v_preferred_contact text;
  v_status text;
begin
  if auth.uid() is null or coalesce(auth.jwt()->>'aal', '') <> 'aal2' or not exists (
    select 1 from public.admin_users where user_id = auth.uid()
  ) then
    raise exception 'Nincs jogosultság a művelethez.' using errcode = '42501';
  end if;
  if p_quote_request_id is null or p_quote_request_id < 1
    or p_operation is null or p_operation not in ('contact','workflow','complete_task','note','status') then
    raise exception 'Érvénytelen művelet.' using errcode = '22023';
  end if;
  -- All operations lock the parent first: this also serializes first workflow creation.
  select * into v_quote from public.quote_requests where id = p_quote_request_id for update;
  if not found then raise exception 'Az ügy nem található.' using errcode = 'P0002'; end if;

  if p_operation = 'contact' then
    if v_quote.updated_at is distinct from p_expected_quote_updated_at then
      raise exception 'Az ügyfél adatai időközben módosultak. Frissítsd az oldalt, és ellenőrizd őket.' using errcode = '40001';
    end if;
    if jsonb_typeof(p_contact) <> 'object' then raise exception 'Hibás ügyféladatok.' using errcode = '22023'; end if;
    v_customer_name := btrim(coalesce(p_contact->>'customer_name',''));
    v_email := nullif(btrim(coalesce(p_contact->>'email','')), '');
    v_phone := nullif(btrim(coalesce(p_contact->>'phone','')), '');
    v_preferred_contact := coalesce(p_contact->>'preferred_contact', v_quote.preferred_contact);
    if v_preferred_contact = 'phone' and v_phone is null then v_preferred_contact := 'email'; end if;
    if v_preferred_contact = 'email' and v_email is null then v_preferred_contact := 'phone'; end if;
    if char_length(v_customer_name) not between 2 and 100
      or (v_email is null and v_phone is null)
      or (v_quote.wants_quote and v_email is null)
      or (v_email is not null and (char_length(v_email) > 254 or v_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'))
      or (v_phone is not null and char_length(v_phone) not between 6 and 40)
      or v_preferred_contact not in ('phone','email')
      or char_length(coalesce(p_contact->>'city','')) > 120
      or char_length(coalesce(p_contact->>'postcode','')) > 20
      or char_length(coalesce(p_contact->>'approximate_dimensions','')) > 500
      or char_length(coalesce(p_contact->>'budget_range','')) > 60
      or (nullif(btrim(p_contact->>'message'),'') is not null and char_length(btrim(p_contact->>'message')) not between 3 and 5000)
      or (nullif(p_contact->>'project_type','') is not null and p_contact->>'project_type' not in
        ('kitchen','wardrobe','entryway','bathroom','living_room','office','custom','other')) then
      raise exception 'Ellenőrizd az ügyfél nevét és elérhetőségeit. Árajánlatkéréshez e-mail-cím szükséges.' using errcode = '22023';
    end if;
    update public.quote_requests set
      customer_name = v_customer_name, email = v_email, phone = v_phone, preferred_contact = v_preferred_contact,
      city = nullif(btrim(p_contact->>'city'),''), postcode = nullif(btrim(p_contact->>'postcode'),''),
      project_type = nullif(p_contact->>'project_type',''),
      approximate_dimensions = nullif(btrim(p_contact->>'approximate_dimensions'),''),
      budget_range = nullif(btrim(p_contact->>'budget_range'),''), message = nullif(btrim(p_contact->>'message'),''),
      updated_at = clock_timestamp()
    where id = p_quote_request_id;
    v_activity := 'Ügyféladatok és igény pontosítva.';

  elsif p_operation = 'status' then
    if v_quote.updated_at is distinct from p_expected_quote_updated_at then
      raise exception 'Az ügy időközben módosult. Frissítsd az oldalt.' using errcode = '40001';
    end if;
    v_status := p_contact->>'status';
    if v_status is null or v_status not in ('new','needs_quote','waiting','ordered','closed') then
      raise exception 'Érvénytelen állapot.' using errcode = '22023';
    end if;
    update public.quote_requests set status = v_status, updated_at = clock_timestamp() where id = p_quote_request_id;
    v_activity := 'Ügy állapota: ' || case v_quote.status when 'new' then 'Új' when 'needs_quote' then 'Árajánlatra vár'
      when 'waiting' then 'Válaszra vár' when 'ordered' then 'Megrendelt' when 'closed' then 'Lezárt' else v_quote.status end
      || ' → ' || case v_status when 'new' then 'Új' when 'needs_quote' then 'Árajánlatra vár'
      when 'waiting' then 'Válaszra vár' when 'ordered' then 'Megrendelt' when 'closed' then 'Lezárt' end || '.';

  elsif p_operation in ('workflow','complete_task') then
    select * into v_workflow from public.quote_workflows where quote_request_id = p_quote_request_id for update;
    if v_workflow.updated_at is distinct from p_expected_workflow_updated_at then
      raise exception 'A munkalap időközben módosult. Frissítsd az oldalt, és ellenőrizd a friss adatokat.' using errcode = '40001';
    end if;
    if p_operation = 'complete_task' then
      if v_workflow.next_action is null then
        if not v_quote.wants_callback or v_workflow.callback_completed_at is not null then
          raise exception 'Nincs lezárható teendő.' using errcode = '22023';
        end if;
        insert into public.quote_workflows(quote_request_id,callback_completed_at,updated_at)
          values(p_quote_request_id,clock_timestamp(),clock_timestamp())
          on conflict (quote_request_id) do update set callback_completed_at=excluded.callback_completed_at,updated_at=excluded.updated_at;
        v_activity := 'Az ügyfél által kért visszahívás elintézve.';
      else
        v_activity := 'Teendő elintézve: ' || v_workflow.next_action || ' (tervezve: ' || v_workflow.next_action_date::text
          || coalesce(' ' || left(v_workflow.next_action_time::text, 5), '') || ').';
        update public.quote_workflows set next_action = null, next_action_date = null, next_action_time = null,
          next_action_kind = null,
          callback_completed_at = case when v_workflow.next_action_kind = 'callback' then clock_timestamp() else callback_completed_at end,
          updated_at = clock_timestamp() where quote_request_id = p_quote_request_id;
      end if;
    else
      if jsonb_typeof(p_workflow) <> 'object' then raise exception 'Hibás munkalap.' using errcode = '22023'; end if;
      v_new_workflow := jsonb_populate_record(null::public.quote_workflows, p_workflow);
      if v_new_workflow.work_stage is null or v_new_workflow.is_test is null
        or v_new_workflow.deposit_paid is null or v_new_workflow.other_paid is null then
        raise exception 'Hiányos munkalap.' using errcode = '22023';
      end if;
      -- Clearing a scheduled task requires the explicit completion action.
      if v_workflow.next_action is not null and v_new_workflow.next_action is null then
        raise exception 'A meglévő teendőt az Elintézve gombbal zárd le, vagy írd át az új teendőre.' using errcode = '22023';
      end if;
      insert into public.quote_workflows (
        quote_request_id,address,is_test,next_action,next_action_date,next_action_time,next_action_kind,work_stage,
        survey_date,installation_date,agreed_total,deposit_paid,other_paid,callback_completed_at,updated_at
      ) values (
        p_quote_request_id,v_new_workflow.address,v_new_workflow.is_test,v_new_workflow.next_action,
        v_new_workflow.next_action_date,v_new_workflow.next_action_time,v_new_workflow.next_action_kind,v_new_workflow.work_stage,
        v_new_workflow.survey_date,v_new_workflow.installation_date,v_new_workflow.agreed_total,
        v_new_workflow.deposit_paid,v_new_workflow.other_paid,
        case when v_new_workflow.next_action_kind = 'callback' then null else v_workflow.callback_completed_at end,clock_timestamp()
      ) on conflict (quote_request_id) do update set
        address=excluded.address,is_test=excluded.is_test,next_action=excluded.next_action,
        next_action_date=excluded.next_action_date,next_action_time=excluded.next_action_time,next_action_kind=excluded.next_action_kind,
        work_stage=excluded.work_stage,survey_date=excluded.survey_date,installation_date=excluded.installation_date,
        agreed_total=excluded.agreed_total,deposit_paid=excluded.deposit_paid,other_paid=excluded.other_paid,
        callback_completed_at=excluded.callback_completed_at,updated_at=excluded.updated_at;
      v_activity := 'Munkalap mentve. Munkafázis: ' || case v_new_workflow.work_stage
        when 'not_started' then 'Még nincs elindítva' when 'survey' then 'Felmérés' when 'design' then 'Tervezés'
        when 'materials' then 'Anyagbeszerzés' when 'production' then 'Gyártás' when 'installation' then 'Beépítés' when 'completed' then 'Átadva' end || '.';
      if v_workflow.next_action is distinct from v_new_workflow.next_action
        or v_workflow.next_action_date is distinct from v_new_workflow.next_action_date
        or v_workflow.next_action_time is distinct from v_new_workflow.next_action_time then
        v_activity := v_activity || coalesce(' Következő teendő: ' || v_new_workflow.next_action || ' – ' || v_new_workflow.next_action_date::text
          || coalesce(' ' || left(v_new_workflow.next_action_time::text,5),'') || '.', '');
      end if;
      if coalesce(v_workflow.is_test,false) is distinct from v_new_workflow.is_test then
        v_activity := v_activity || case when v_new_workflow.is_test then ' Tesztként megjelölve.' else 'Tesztjelölés megszüntetve.' end;
      end if;
      if v_workflow.agreed_total is distinct from v_new_workflow.agreed_total
        or coalesce(v_workflow.deposit_paid,0) is distinct from v_new_workflow.deposit_paid
        or coalesce(v_workflow.other_paid,0) is distinct from v_new_workflow.other_paid then
        v_activity := v_activity || ' Bruttó megállapodott összeg: ' || coalesce(v_new_workflow.agreed_total::text,'nincs megadva')
          || ' Ft; rögzített előleg: ' || v_new_workflow.deposit_paid::text || ' Ft; további befizetés: ' || v_new_workflow.other_paid::text || ' Ft.';
      end if;
    end if;
  else
    v_activity := btrim(coalesce(p_body,''));
    if char_length(v_activity) not between 1 and 4000 then
      raise exception 'A bejegyzés 1–4000 karakter lehet.' using errcode = '22023';
    end if;
  end if;

  insert into public.quote_activities(quote_request_id,body,created_by)
    values(p_quote_request_id,v_activity,auth.uid()) returning id into v_activity_id;
  return v_activity_id;
end;
$$;

revoke all on function public.manage_quote_workflow(bigint,text,timestamptz,timestamptz,jsonb,jsonb,text) from public,anon,authenticated;
grant execute on function public.manage_quote_workflow(bigint,text,timestamptz,timestamptz,jsonb,jsonb,text) to authenticated;

-- New/saved draft offers capture the recipient identity. Once sent, later
-- dossier edits must not rewrite that historical snapshot. No legacy backfill.
alter table public.quote_offers add column if not exists customer_snapshot jsonb;
create or replace function public.snapshot_quote_offer_customer()
returns trigger language plpgsql security invoker set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' and old.status <> 'draft' then
    new.customer_snapshot := old.customer_snapshot;
  else
    select jsonb_build_object(
      'customer_name', q.customer_name, 'email', q.email, 'phone', q.phone,
      'project_type', q.project_type, 'city', q.city, 'postcode', q.postcode, 'address', w.address
    ) into new.customer_snapshot
    from public.quote_requests q
    left join public.quote_workflows w on w.quote_request_id = q.id
    where q.id = new.quote_request_id;
  end if;
  return new;
end;
$$;
revoke all on function public.snapshot_quote_offer_customer() from public, anon, authenticated;
drop trigger if exists quote_offers_customer_snapshot on public.quote_offers;
create trigger quote_offers_customer_snapshot before insert or update on public.quote_offers
  for each row execute function public.snapshot_quote_offer_customer();
notify pgrst, 'reload schema';
commit;

