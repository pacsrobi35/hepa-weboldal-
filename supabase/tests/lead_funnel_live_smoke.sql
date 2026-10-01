-- Run only after this feature's migration is installed. All event changes are
-- rolled back; existing test requests are only read and no notifications run.
begin;
set local role service_role;
do $verify$
declare
  v_session uuid := 'f10a0000-0000-4000-8000-000000000001';
  v_fake uuid := 'f10a0000-0000-4000-8000-000000000002';
  v_callback uuid;
  v_cutting uuid;
  v_before bigint;
  v_after bigint;
begin
  begin
    if not exists (select 1 from public.quote_workflows where quote_request_id=49 and is_test)
      or not exists (select 1 from public.quote_workflows where quote_request_id=50 and is_test) then
      raise exception 'Expected marked test inquiries 49 and 50';
    end if;
    select submission_token into v_callback from public.quote_requests where id=49;
    select submission_token into v_cutting from public.quote_requests where id=50;
    if v_callback is null or v_cutting is null then raise exception 'Expected test submission tokens'; end if;
    select count(*) into v_before from public.quote_requests;
    delete from private.lead_funnel_events where session_token=v_session;
    if not public.record_lead_funnel_event(v_session,'cta_click','callback','/konyhabutor.html','mobile',null) then
      raise exception 'CTA insert failed';
    end if;
    if public.record_lead_funnel_event(v_session,'cta_click','callback','/konyhabutor.html','mobile',null) then
      raise exception 'CTA duplicate was counted';
    end if;
    if public.record_lead_funnel_event(v_session,'submit_success','callback','/konyhabutor.html','mobile',v_fake) then
      raise exception 'Unverified success was counted';
    end if;
    if public.record_lead_funnel_event(v_session,'submit_success','callback','/konyhabutor.html','mobile',v_callback) then
      raise exception 'Test callback success was counted';
    end if;
    if public.record_lead_funnel_event(v_session,'submit_success','cutting','/lapszabaszat-ajanlatkeres.html','mobile',v_cutting) then
      raise exception 'Test cutting success was counted';
    end if;
    if (select count(*) from private.lead_funnel_events where session_token=v_session) <> 1 then
      raise exception 'Unexpected retained stages';
    end if;
    select count(*) into v_after from public.quote_requests;
    if v_before <> v_after then raise exception 'Customer submission rows changed'; end if;
    if pg_catalog.has_function_privilege('anon','public.record_lead_funnel_event(uuid,text,text,text,text,uuid)','execute')
      or pg_catalog.has_function_privilege('authenticated','public.record_lead_funnel_event(uuid,text,text,text,text,uuid)','execute')
      or pg_catalog.has_table_privilege('anon','private.lead_funnel_events','select')
      or pg_catalog.has_table_privilege('authenticated','private.lead_funnel_events','select') then
      raise exception 'Public collector data access detected';
    end if;
    perform pg_catalog.set_config('hepa.funnel_smoke_result', '{"ok":true,"cta_insert":true,"dedupe":true,"unverified_success_excluded":true,"test_49_and_50_excluded":true,"no_customer_rows_changed":true,"public_access_denied":true}',true);
  exception when others then
    perform pg_catalog.set_config('hepa.funnel_smoke_result',jsonb_build_object('ok',false,'error',sqlerrm)::text,true);
  end;
end;
$verify$;
select current_setting('hepa.funnel_smoke_result')::jsonb as verification;
rollback;
