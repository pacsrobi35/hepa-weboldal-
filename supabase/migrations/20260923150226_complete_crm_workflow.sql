begin;

alter table public.quote_requests
  add column if not exists close_reason text;

alter table public.quote_requests
  alter column status set default 'needs_quote';

update public.quote_requests
set close_reason = 'legacy_unspecified'
where status = 'closed'
  and close_reason is null;

alter table public.quote_requests
  drop constraint if exists quote_requests_close_reason_check;

alter table public.quote_requests
  add constraint quote_requests_close_reason_check
  check (
    (status <> 'closed' and close_reason is null)
    or (status = 'closed' and close_reason in (
      'completed','declined','no_response','cancelled','duplicate_test','legacy_unspecified'
    ))
  );

alter table public.quote_workflows
  add column if not exists promised_date date;

alter table public.quote_workflows
  drop constraint if exists quote_workflows_work_stage_check;

alter table public.quote_workflows
  add constraint quote_workflows_work_stage_check
  check (
    work_stage in (
      'not_started','survey','design','materials','production','installation',
      'cutting_received','material_wait','cutting','edgebanding','ready','completed'
    )
  );

alter table public.quote_request_files
  drop constraint if exists quote_request_files_file_purpose_check;

alter table public.quote_request_files
  add constraint quote_request_files_file_purpose_check
  check (
    file_purpose in (
      'reference','cutting_list','help_attachment','paper_order','signed_offer',
      'contract','survey_photo','visualization','workshop_drawing'
    )
  );

create or replace function private.normalize_quote_status()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if new.status = 'new' then
    new.status := 'needs_quote';
  end if;
  if new.status <> 'closed' then
    new.close_reason := null;
  end if;
  return new;
end;
$$;

drop trigger if exists quote_requests_normalize_status on public.quote_requests;
create trigger quote_requests_normalize_status
before insert or update of status, close_reason on public.quote_requests
for each row execute function private.normalize_quote_status();

update public.quote_requests
set status = 'needs_quote',
    close_reason = null,
    updated_at = clock_timestamp()
where status = 'new';

create or replace function private.ensure_quote_workflow()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  insert into public.quote_workflows (quote_request_id)
  values (new.id)
  on conflict (quote_request_id) do nothing;
  return new;
end;
$$;

drop trigger if exists quote_requests_ensure_workflow on public.quote_requests;
create trigger quote_requests_ensure_workflow
after insert on public.quote_requests
for each row execute function private.ensure_quote_workflow();

insert into public.quote_workflows (quote_request_id)
select q.id
from public.quote_requests q
left join public.quote_workflows w on w.quote_request_id = q.id
where w.quote_request_id is null
on conflict (quote_request_id) do nothing;

CREATE OR REPLACE FUNCTION private.manage_quote_workflow_impl(p_quote_request_id bigint, p_operation text, p_expected_quote_updated_at timestamp with time zone DEFAULT NULL::timestamp with time zone, p_expected_workflow_updated_at timestamp with time zone DEFAULT NULL::timestamp with time zone, p_contact jsonb DEFAULT '{}'::jsonb, p_workflow jsonb DEFAULT '{}'::jsonb, p_body text DEFAULT NULL::text)
 RETURNS bigint
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
  v_close_reason text;
  v_user_id uuid;
begin
  v_user_id := private.require_quote_delivery_admin();
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
      or (v_email is not null and (char_length(v_email) > 254 or v_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'))
      or (v_phone is not null and char_length(v_phone) not between 6 and 40)
      or v_preferred_contact not in ('phone','email')
      or char_length(coalesce(p_contact->>'city','')) > 120
      or char_length(coalesce(p_contact->>'postcode','')) > 20
      or char_length(coalesce(p_contact->>'approximate_dimensions','')) > 500
      or char_length(coalesce(p_contact->>'budget_range','')) > 60
      or (nullif(btrim(p_contact->>'message'),'') is not null and char_length(btrim(p_contact->>'message')) not between 3 and 5000)
      or (v_quote.request_kind = 'furniture' and nullif(p_contact->>'project_type','') is not null and p_contact->>'project_type' not in
        ('kitchen','wardrobe','entryway','bathroom','living_room','office','custom','other')) then
      raise exception 'Ellenőrizd az ügyfél nevét és elérhetőségeit.' using errcode = '22023';
    end if;
    update public.quote_requests set
      customer_name = v_customer_name, email = v_email, phone = v_phone, preferred_contact = v_preferred_contact,
      city = nullif(btrim(p_contact->>'city'),''), postcode = nullif(btrim(p_contact->>'postcode'),''),
      project_type = case when v_quote.request_kind = 'cutting' then 'cutting'
        else nullif(p_contact->>'project_type','') end,
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
    v_close_reason := nullif(btrim(coalesce(p_contact->>'close_reason', '')), '');
    if v_status is null or v_status not in ('needs_quote','waiting','ordered','closed') then
      raise exception 'Érvénytelen állapot.' using errcode = '22023';
    end if;
    if v_close_reason is not null and v_close_reason not in
      ('completed','declined','no_response','cancelled','duplicate_test') then
      raise exception 'Érvénytelen lezárási ok.' using errcode = '22023';
    end if;
    if v_status = 'closed' and v_close_reason is null then
      raise exception 'A lezárás okát kötelező megadni.' using errcode = '22023';
    end if;
    update public.quote_requests
    set status = v_status,
        close_reason = case when v_status = 'closed' then v_close_reason else null end,
        updated_at = clock_timestamp()
    where id = p_quote_request_id;
    v_activity := 'Ügy állapota: ' || case v_quote.status when 'new' then 'Új' when 'needs_quote' then 'Árajánlatra vár'
      when 'waiting' then 'Ügyfél válaszára vár' when 'ordered' then 'Megrendelt' when 'closed' then 'Lezárt' else v_quote.status end
      || ' → ' || case v_status when 'new' then 'Új' when 'needs_quote' then 'Árajánlatra vár'
      when 'waiting' then 'Ügyfél válaszára vár' when 'ordered' then 'Megrendelt' when 'closed' then 'Lezárt' end || '.';
    if v_status = 'closed' then
      v_activity := v_activity || ' Lezárás oka: ' || case v_close_reason
        when 'completed' then 'elkészült / átadva'
        when 'declined' then 'ajánlat elutasítva'
        when 'no_response' then 'nem érkezett válasz'
        when 'cancelled' then 'ügyfél lemondta'
        when 'duplicate_test' then 'duplikált / teszt ügy'
      end || '.';
    end if;

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
      if (v_quote.request_kind = 'furniture' and v_new_workflow.work_stage not in
          ('not_started','survey','design','materials','production','installation','completed'))
        or (v_quote.request_kind = 'cutting' and v_new_workflow.work_stage not in
          ('not_started','cutting_received','material_wait','cutting','edgebanding','ready','completed')) then
        raise exception 'A munkafázis nem illik ehhez az ügytípushoz.' using errcode = '22023';
      end if;
      if v_new_workflow.deposit_paid < 0 or v_new_workflow.other_paid < 0
        or (v_new_workflow.agreed_total is not null and
          v_new_workflow.deposit_paid + v_new_workflow.other_paid > v_new_workflow.agreed_total) then
        raise exception 'A rögzített befizetések nem lehetnek nagyobbak a megállapodott végösszegnél.' using errcode = '22023';
      end if;
      -- Clearing a scheduled task requires the explicit completion action.
      if v_workflow.next_action is not null and v_new_workflow.next_action is null then
        raise exception 'A meglévő teendőt az Elintézve gombbal zárd le, vagy írd át az új teendőre.' using errcode = '22023';
      end if;
      insert into public.quote_workflows (
        quote_request_id,address,is_test,next_action,next_action_date,next_action_time,next_action_kind,work_stage,
        promised_date,survey_date,installation_date,agreed_total,deposit_paid,other_paid,callback_completed_at,updated_at
      ) values (
        p_quote_request_id,v_new_workflow.address,v_new_workflow.is_test,v_new_workflow.next_action,
        v_new_workflow.next_action_date,v_new_workflow.next_action_time,v_new_workflow.next_action_kind,v_new_workflow.work_stage,
        v_new_workflow.promised_date,v_new_workflow.survey_date,v_new_workflow.installation_date,v_new_workflow.agreed_total,
        v_new_workflow.deposit_paid,v_new_workflow.other_paid,
        case when v_new_workflow.next_action_kind = 'callback' then null else v_workflow.callback_completed_at end,clock_timestamp()
      ) on conflict (quote_request_id) do update set
        address=excluded.address,is_test=excluded.is_test,next_action=excluded.next_action,
        next_action_date=excluded.next_action_date,next_action_time=excluded.next_action_time,next_action_kind=excluded.next_action_kind,
        work_stage=excluded.work_stage,promised_date=excluded.promised_date,survey_date=excluded.survey_date,
        installation_date=excluded.installation_date,agreed_total=excluded.agreed_total,
        deposit_paid=excluded.deposit_paid,other_paid=excluded.other_paid,
        callback_completed_at=excluded.callback_completed_at,updated_at=excluded.updated_at;
      v_activity := 'Munkalap mentve. Munkafázis: ' || case v_new_workflow.work_stage
        when 'not_started' then 'Még nincs elindítva' when 'survey' then 'Felmérés' when 'design' then 'Tervezés'
        when 'materials' then 'Anyagbeszerzés' when 'production' then 'Gyártás' when 'installation' then 'Beépítés'
        when 'cutting_received' then 'Felvéve' when 'material_wait' then 'Anyagra vár'
        when 'cutting' then 'Szabás' when 'edgebanding' then 'Élzárás' when 'ready' then 'Kész'
        when 'completed' then 'Átadva' end || '.';
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
    values(p_quote_request_id,v_activity,v_user_id) returning id into v_activity_id;
  return v_activity_id;
end;
$function$;

revoke all on function private.manage_quote_workflow_impl(
  bigint,text,timestamptz,timestamptz,jsonb,jsonb,text
) from public, anon;
grant usage on schema private to authenticated;
grant execute on function private.manage_quote_workflow_impl(
  bigint,text,timestamptz,timestamptz,jsonb,jsonb,text
) to authenticated;

create or replace function public.manage_quote_workflow(
  p_quote_request_id bigint,
  p_operation text,
  p_expected_quote_updated_at timestamptz default null,
  p_expected_workflow_updated_at timestamptz default null,
  p_contact jsonb default '{}'::jsonb,
  p_workflow jsonb default '{}'::jsonb,
  p_body text default null
)
returns bigint
language sql
security invoker
set search_path = ''
as $$
  select private.manage_quote_workflow_impl(
    p_quote_request_id,
    p_operation,
    p_expected_quote_updated_at,
    p_expected_workflow_updated_at,
    p_contact,
    p_workflow,
    p_body
  );
$$;

revoke all on function public.manage_quote_workflow(
  bigint,text,timestamptz,timestamptz,jsonb,jsonb,text
) from public, anon;
grant execute on function public.manage_quote_workflow(
  bigint,text,timestamptz,timestamptz,jsonb,jsonb,text
) to authenticated;

create or replace function private.decide_quote_offer_impl(
  p_offer_id bigint,
  p_decision text,
  p_expected_offer_updated_at timestamptz,
  p_note text default null
)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid;
  v_quote_request_id bigint;
  v_offer public.quote_offers%rowtype;
  v_quote public.quote_requests%rowtype;
  v_workflow public.quote_workflows%rowtype;
  v_activity_id bigint;
  v_body text;
  v_note text;
begin
  v_user_id := private.require_quote_delivery_admin();
  v_note := nullif(btrim(coalesce(p_note, '')), '');

  if p_offer_id is null or p_offer_id < 1
     or p_decision is null
     or p_decision not in ('accepted','rejected')
     or p_expected_offer_updated_at is null then
    raise exception 'invalid-offer-decision' using errcode = '22023';
  end if;
  if v_note is not null and char_length(v_note) > 1000 then
    raise exception 'offer-decision-note-too-long' using errcode = '22023';
  end if;

  select quote_request_id
  into v_quote_request_id
  from public.quote_offers
  where id = p_offer_id;

  if not found then
    raise exception 'offer-not-found' using errcode = 'P0002';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended('quote-offer-' || v_quote_request_id::text, 0)
  );

  select *
  into v_offer
  from public.quote_offers
  where id = p_offer_id
    and quote_request_id = v_quote_request_id
  for update;

  if not found then
    raise exception 'offer-not-found' using errcode = 'P0002';
  end if;
  if v_offer.status <> 'sent' then
    raise exception 'offer-not-awaiting-decision' using errcode = '55000';
  end if;
  if v_offer.updated_at is distinct from p_expected_offer_updated_at then
    raise exception 'quote-offer-stale' using errcode = '40001';
  end if;
  select *
  into v_quote
  from public.quote_requests
  where id = v_offer.quote_request_id
  for update;
  if not found then
    raise exception 'quote-request-not-found' using errcode = 'P0002';
  end if;
  if v_quote.status = 'closed' or exists (
    select 1
    from public.quote_offers accepted
    where accepted.quote_request_id = v_offer.quote_request_id
      and accepted.status = 'accepted'
      and accepted.id <> v_offer.id
  ) then
    raise exception 'offer-parent-already-finalized' using errcode = '55000';
  end if;
  if exists (
    select 1
    from public.quote_offers newer
    where newer.quote_request_id = v_offer.quote_request_id
      and newer.version > v_offer.version
      and newer.status = 'draft'
  ) then
    raise exception 'newer-offer-draft-exists' using errcode = '55000';
  end if;
  if p_decision = 'accepted' and v_offer.gross_total > 999999999999 then
    raise exception 'offer-total-exceeds-workflow-limit' using errcode = '22023';
  end if;
  if p_decision = 'accepted' then
    select *
    into v_workflow
    from public.quote_workflows
    where quote_request_id = v_offer.quote_request_id
    for update;

    if found and coalesce(v_workflow.deposit_paid, 0) + coalesce(v_workflow.other_paid, 0)
        > v_offer.gross_total then
      raise exception 'offer-total-below-recorded-payments' using errcode = '22023';
    end if;
  end if;

  update public.quote_offers
  set status = p_decision,
      updated_at = clock_timestamp()
  where id = v_offer.id;

  if p_decision = 'accepted' then
    update public.quote_requests
    set status = 'ordered',
        close_reason = null,
        updated_at = clock_timestamp()
    where id = v_offer.quote_request_id;

    insert into public.quote_workflows (
      quote_request_id,
      agreed_total,
      updated_at
    ) values (
      v_offer.quote_request_id,
      v_offer.gross_total,
      clock_timestamp()
    )
    on conflict (quote_request_id) do update
      set agreed_total = excluded.agreed_total,
          updated_at = excluded.updated_at;

    v_body := 'Árajánlat elfogadva és rendelésre váltva: '
      || v_offer.offer_number || ', bruttó '
      || trim(to_char(v_offer.gross_total, 'FM999999999999990D00')) || ' Ft.';
  else
    if v_quote.status = 'ordered' then
      v_body := 'A közvetlen rendeléshez készített opcionális árajánlat elutasítva: '
        || v_offer.offer_number || '. A rendelés folyamatban maradt.';
    else
      update public.quote_requests
      set status = 'closed',
          close_reason = 'declined',
          updated_at = clock_timestamp()
      where id = v_offer.quote_request_id;

      v_body := 'Árajánlat elutasítva: ' || v_offer.offer_number || '.';
    end if;
  end if;

  if v_note is not null then
    v_body := v_body || ' Megjegyzés: ' || v_note;
  end if;

  insert into public.quote_activities (quote_request_id, body, created_by)
  values (v_offer.quote_request_id, v_body, v_user_id)
  returning id into v_activity_id;

  return v_activity_id;
end;
$$;

revoke all on function private.decide_quote_offer_impl(
  bigint,text,timestamptz,text
) from public, anon;
grant execute on function private.decide_quote_offer_impl(
  bigint,text,timestamptz,text
) to authenticated;

create or replace function public.decide_quote_offer(
  p_offer_id bigint,
  p_decision text,
  p_expected_offer_updated_at timestamptz,
  p_note text default null
)
returns bigint
language sql
security invoker
set search_path = ''
as $$
  select private.decide_quote_offer_impl(
    p_offer_id,
    p_decision,
    p_expected_offer_updated_at,
    p_note
  );
$$;

revoke all on function public.decide_quote_offer(
  bigint,text,timestamptz,text
) from public, anon;
grant execute on function public.decide_quote_offer(
  bigint,text,timestamptz,text
) to authenticated;

-- All CRM writes now go through admin/AAL2-checked RPCs. Keep authenticated
-- reads, but remove the legacy direct mutations that could bypass CAS and
-- business invariants through PostgREST.
revoke update (
  customer_name,email,phone,preferred_contact,city,postcode,project_type,
  approximate_dimensions,budget_range,message,status,updated_at
) on public.quote_requests from authenticated;
revoke insert, update on public.quote_workflows from authenticated;
revoke insert on public.quote_activities from authenticated;

comment on column public.quote_requests.close_reason is
  'Lezárási ok: completed, declined, no_response, cancelled, duplicate_test; legacy_unspecified csak korábbi sorok backfill értéke.';
comment on column public.quote_workflows.promised_date is
  'Az ügyféllel vállalt elkészülési vagy átadási dátum.';

commit;
