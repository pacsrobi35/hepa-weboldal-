-- Keep an explicitly handed-over job and its case status in step.
-- The existing management RPC locks quote_requests before quote_workflows;
-- these row triggers run inside the same transaction as the requested change.
begin;

-- Newly entering Válaszra vár means a price has actually been communicated.
-- Historical waiting rows are left intact; email and offline delivery record
-- a sent offer before they set the parent inquiry to waiting.
create or replace function private.require_communicated_offer_for_waiting()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if not exists (
    select 1 from public.quote_offers
    where quote_request_id = new.id and status in ('sent', 'accepted')
  ) then
    raise exception 'Előbb rögzítsd, hogy az árat közölted az ügyféllel.' using errcode = '22023';
  end if;
  return new;
end;
$$;
revoke all on function private.require_communicated_offer_for_waiting()
  from public, anon, authenticated, service_role;

drop trigger if exists quote_requests_waiting_requires_offer on public.quote_requests;
create trigger quote_requests_waiting_requires_offer
after update of status on public.quote_requests
for each row
when (new.status = 'waiting' and old.status is distinct from new.status)
execute function private.require_communicated_offer_for_waiting();

create or replace function private.sync_quote_completion_from_status()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if new.status = 'closed' and new.close_reason = 'completed' then
    if old.status <> 'ordered' then
      raise exception 'Előbb jelöld az ügyet megrendeltnek, aztán zárd le átadottként.' using errcode = '22023';
    end if;

    update public.quote_workflows
       set work_stage = 'completed', updated_at = clock_timestamp()
     where quote_request_id = new.id and work_stage <> 'completed';
    if not found and not exists (
      select 1 from public.quote_workflows where quote_request_id = new.id
    ) then
      raise exception 'A munkalap hiányzik. Frissítsd az oldalt, majd próbáld újra.' using errcode = '22023';
    end if;
  elsif old.status = 'closed' and old.close_reason = 'completed' then
    -- Reopen through the work-stage editor, which can preserve the intended phase.
    if exists (
      select 1 from public.quote_workflows
      where quote_request_id = new.id and work_stage = 'completed'
    ) then
      raise exception 'Az átadott munka újranyitásához előbb módosítsd a munkafázist a munkalapon.' using errcode = '22023';
    end if;
  end if;
  return new;
end;
$$;
revoke all on function private.sync_quote_completion_from_status()
  from public, anon, authenticated, service_role;

drop trigger if exists quote_requests_sync_completion on public.quote_requests;
create trigger quote_requests_sync_completion
after update of status, close_reason on public.quote_requests
for each row
when (old.status is distinct from new.status or old.close_reason is distinct from new.close_reason)
execute function private.sync_quote_completion_from_status();

create or replace function private.sync_quote_completion_from_stage()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_status text;
  v_close_reason text;
begin
  if tg_op = 'INSERT' then
    if new.work_stage <> 'completed' then return new; end if;
  elsif new.work_stage is not distinct from old.work_stage then
    return new;
  end if;

  select status, close_reason into v_status, v_close_reason
  from public.quote_requests where id = new.quote_request_id;

  if new.work_stage = 'completed' then
    if v_status <> 'ordered'
      and (v_status is distinct from 'closed' or v_close_reason is distinct from 'completed') then
      raise exception 'Előbb jelöld az ügyet megrendeltnek, aztán állítsd a munkafázist Átadva értékre.' using errcode = '22023';
    end if;

    if v_status is distinct from 'closed' or v_close_reason is distinct from 'completed' then
      update public.quote_requests
      set status = 'closed', close_reason = 'completed', updated_at = clock_timestamp()
      where id = new.quote_request_id;
    end if;
  elsif tg_op = 'UPDATE' and old.work_stage = 'completed'
    and v_status = 'closed' and v_close_reason = 'completed' then
    update public.quote_requests
    set status = 'ordered', close_reason = null, updated_at = clock_timestamp()
    where id = new.quote_request_id;
  end if;
  return new;
end;
$$;
revoke all on function private.sync_quote_completion_from_stage()
  from public, anon, authenticated, service_role;

drop trigger if exists quote_workflows_sync_completion_insert on public.quote_workflows;
create trigger quote_workflows_sync_completion_insert
after insert on public.quote_workflows
for each row
when (new.work_stage = 'completed')
execute function private.sync_quote_completion_from_stage();

drop trigger if exists quote_workflows_sync_completion_update on public.quote_workflows;
create trigger quote_workflows_sync_completion_update
after update of work_stage on public.quote_workflows
for each row
when (old.work_stage is distinct from new.work_stage)
execute function private.sync_quote_completion_from_stage();

commit;
