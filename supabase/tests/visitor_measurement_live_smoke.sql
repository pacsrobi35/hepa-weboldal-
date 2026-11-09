-- Authorized installation verification. All fixtures are rolled back, with no emails.
-- quote_requests triggers were inspected first: they only maintain workflow/status.
begin;
do $test$
declare
  sid uuid := gen_random_uuid();
  test_sid uuid := gen_random_uuid();
  view_id uuid := gen_random_uuid();
  submission uuid := gen_random_uuid();
  qid bigint;
  batch jsonb;
  before_report jsonb;
  report jsonb;
begin
  before_report := public.get_visitor_measurement_report(7,'all','all');
  insert into public.quote_requests(customer_name,phone,consent,source,request_kind,intake_state,wants_callback,submission_token,status)
  values('Mérési teszt – visszagörgetett adat','000000000',true,'website','furniture','ready',true,submission,'ordered') returning id into qid;
  batch := jsonb_build_object('sessionToken',sid,'pageViewId',view_id,'page','/','source','google_ads','campaignId','99999999999','device','mobile','isTest',false,
    'events',jsonb_build_array(
      jsonb_build_object('id',gen_random_uuid(),'type','page_view','target','','funnel','','value',0,'sequence',1),
      jsonb_build_object('id',gen_random_uuid(),'type','cta_click','target','phone','funnel','','value',0,'sequence',2),
      jsonb_build_object('id',gen_random_uuid(),'type','form_start','target','callback','funnel','callback','value',0,'sequence',3),
      jsonb_build_object('id',gen_random_uuid(),'type','submit_error','target','network','funnel','callback','value',0,'sequence',4),
      jsonb_build_object('id',gen_random_uuid(),'type','submit_success','target','callback','funnel','callback','value',0,'sequence',5,'submissionToken',submission),
      jsonb_build_object('id',gen_random_uuid(),'type','submit_success','target','callback','funnel','callback','value',0,'sequence',6,'submissionToken',gen_random_uuid())
    ));
  perform public.record_visitor_measurement(batch);
  perform public.record_visitor_measurement(batch);
  if (select count(*) from private.visitor_events where session_token=sid) <> 5 then raise exception 'Deduplication or success verification failed'; end if;
  report := public.get_visitor_measurement_report(7,'mobile','google_ads');
  if (report#>>'{summary,leads}')::integer < 1 or (report#>>'{summary,orders}')::integer < 1 then raise exception 'Verified lead/order link missing'; end if;
  report := public.get_visitor_measurement_report(7,'all','all');
  if (report#>>'{summary,visits}')::integer <> (before_report#>>'{summary,visits}')::integer+1 then raise exception 'Visit count mismatch'; end if;
  if (report#>>'{summary,phone_clicks}')::integer <> (before_report#>>'{summary,phone_clicks}')::integer+1 then raise exception 'Phone click count mismatch'; end if;
  if (report#>>'{summary,errors}')::integer <> (before_report#>>'{summary,errors}')::integer+1 then raise exception 'Error count mismatch'; end if;
  batch := jsonb_set(jsonb_set(batch,'{sessionToken}',to_jsonb(test_sid)),'{isTest}','true'::jsonb);
  batch := jsonb_set(batch,'{events}',jsonb_build_array(jsonb_build_object('id',gen_random_uuid(),'type','page_view','target','','funnel','','value',0,'sequence',1)));
  perform public.record_visitor_measurement(batch);
  if (public.get_visitor_measurement_report(7,'all','all')#>>'{summary,visits}')::integer <> (report#>>'{summary,visits}')::integer then raise exception 'Test session leaked into report'; end if;
  if has_table_privilege('anon','private.visitor_events','select') or has_table_privilege('authenticated','private.visitor_events','select')
    or has_function_privilege('anon','public.record_visitor_measurement(jsonb)','execute')
    or has_function_privilege('authenticated','public.get_visitor_measurement_report(integer,text,text)','execute') then raise exception 'Public data access was granted'; end if;
end;
$test$;
rollback;
select 'visitor measurement SQL checks passed; all fixtures rolled back' as result;
