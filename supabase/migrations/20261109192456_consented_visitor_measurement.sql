-- Additive, consent-gated analytics. No form contents, IPs, click IDs, full URLs,
-- browser fingerprints or persistent visitor identifiers. The existing funnel is preserved.
create table private.visitor_events (
  event_id uuid primary key,
  session_token uuid not null,
  page_view_id uuid not null,
  sequence integer not null check (sequence between 0 and 1000000),
  created_at timestamptz not null default clock_timestamp(),
  page text not null check (page in ('/','/konyhabutor.html','/lapszabaszat.html','/lapszabaszat-ajanlatkeres.html')),
  source text not null check (source in ('direct','google_ads','google_organic','facebook','instagram','bing','referral','other_campaign')),
  campaign_id text not null default '' check (campaign_id ~ '^(?:[0-9]{1,20})?$'),
  device text not null check (device in ('mobile','desktop')),
  event text not null check (event in ('page_view','section_view','scroll_depth','engaged','cta_click','reference_view','details_open','form_view','form_start','form_step','validation_error','submit_attempt','submit_error','submit_success','resource_error')),
  target text not null check (target ~ '^[a-z0-9_:-]{0,40}$'),
  funnel text not null check (funnel in ('','callback','cutting')),
  value integer not null default 0 check (value between 0 and 1800000),
  is_test boolean not null default false,
  quote_request_id bigint references public.quote_requests(id) on delete cascade,
  constraint success_is_verified check ((event = 'submit_success') = (quote_request_id is not null))
);
create index visitor_events_created_at_idx on private.visitor_events (created_at);
create index visitor_events_session_idx on private.visitor_events (session_token, created_at, sequence);
create index visitor_events_quote_idx on private.visitor_events (quote_request_id) where quote_request_id is not null;
alter table private.visitor_events enable row level security;
alter table private.visitor_events force row level security;
revoke all on private.visitor_events from public, anon, authenticated, service_role;
grant select, insert, delete on private.visitor_events to service_role;
comment on table private.visitor_events is 'Optional first-party website measurement. Private/service-only. Thirty-day report window and bounded cleanup on ingestion. Tests are excluded from reports.';

create function public.record_visitor_measurement(p_batch jsonb)
returns boolean language plpgsql security invoker set search_path = '' as $fn$
declare
  e jsonb;
  qid bigint;
  previous private.visitor_events%rowtype;
begin
  if jsonb_typeof(p_batch->'events') <> 'array' or jsonb_array_length(p_batch->'events') not between 1 and 20 then
    raise exception 'Invalid batch' using errcode = '22023';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('hepa-visitor-collector',0));
  with expired as (select event_id from private.visitor_events where created_at < now()-interval '30 days' order by created_at limit 1000)
  delete from private.visitor_events e using expired x where e.event_id=x.event_id;
  if (select count(*) from (select 1 from private.visitor_events where created_at >= now()-interval '24 hours' limit 25000) x) >= 25000
    or (select count(*) from (select 1 from private.visitor_events where session_token=(p_batch->>'sessionToken')::uuid limit 200) x) >= 200 then return false; end if;
  select * into previous from private.visitor_events where session_token=(p_batch->>'sessionToken')::uuid order by created_at, sequence limit 1;
  -- A session cannot switch attribution or test status between packets.
  if found and (previous.source <> p_batch->>'source' or previous.campaign_id <> p_batch->>'campaignId'
    or previous.is_test <> (p_batch->>'isTest')::boolean or previous.device <> p_batch->>'device') then return false; end if;
  for e in select value from jsonb_array_elements(p_batch->'events') loop
    qid := null;
    if e->>'type'='submit_success' then
      select q.id into qid from public.quote_requests q
      left join public.quote_workflows w on w.quote_request_id=q.id
      left join public.cutting_quote_requests c on c.quote_request_id=q.id
      where q.submission_token=(e->>'submissionToken')::uuid and q.source='website' and q.intake_state='ready'
        and q.created_at >= now()-interval '24 hours'
        and q.request_kind=case e->>'funnel' when 'callback' then 'furniture' else 'cutting' end
        and (e->>'funnel'<>'callback' or q.wants_callback is true)
        and (e->>'funnel'<>'cutting' or c.submission_state='ready')
        and coalesce(w.is_test,false)=(p_batch->>'isTest')::boolean;
      if qid is null then continue; end if;
    end if;
    insert into private.visitor_events(event_id,session_token,page_view_id,sequence,page,source,campaign_id,device,event,target,funnel,value,is_test,quote_request_id)
    values((e->>'id')::uuid,(p_batch->>'sessionToken')::uuid,(p_batch->>'pageViewId')::uuid,(e->>'sequence')::integer,
      p_batch->>'page',p_batch->>'source',p_batch->>'campaignId',p_batch->>'device',e->>'type',e->>'target',e->>'funnel',(e->>'value')::integer,(p_batch->>'isTest')::boolean,qid)
    on conflict(event_id) do nothing;
  end loop;
  return true;
end;
$fn$;
revoke all on function public.record_visitor_measurement(jsonb) from public, anon, authenticated, service_role;
grant execute on function public.record_visitor_measurement(jsonb) to service_role;

create function public.get_visitor_measurement_report(p_days integer default 7,p_device text default 'all',p_source text default 'all')
returns jsonb language plpgsql security invoker set search_path = '' as $fn$
declare result jsonb;
begin
  if p_days not in (1,7,14,30) or p_device not in ('all','mobile','desktop') or p_source not in ('all','direct','google_ads','google_organic','facebook','instagram','bing','referral','other_campaign') then
    raise exception 'Invalid filters' using errcode = '22023';
  end if;
  with e as materialized (
    select * from private.visitor_events
    where created_at >= ((date_trunc('day',now() at time zone 'Europe/Budapest') - ((p_days-1)*interval '1 day')) at time zone 'Europe/Budapest')
      and created_at >= now()-interval '30 days' and is_test=false
      and (p_device='all' or device=p_device) and (p_source='all' or source=p_source)
  ), sessions as (
    select distinct on(session_token) session_token,page,source,campaign_id,device,created_at from e where event='page_view' order by session_token,created_at,sequence
  ), last_pages as (
    select distinct on(session_token) session_token,page from e where event='page_view' order by session_token,created_at desc,sequence desc
  ), inactive as (
    select session_token from e group by session_token having max(created_at)<now()-interval '30 minutes'
  ), last_steps as (
    select distinct on(session_token) session_token,target from e where event='form_step' and funnel='cutting' order by session_token,created_at desc,sequence desc
  ), leads as (
    select distinct quote_request_id,session_token from e where event='submit_success'
  ), funnel_counts as (
    select f.funnel,st.stage,count(distinct x.session_token)::integer as sessions
    from (values('callback'),('cutting')) f(funnel)
    cross join (values('page_view'),('cta_click'),('form_view'),('form_start'),('submit_attempt'),('submit_success')) st(stage)
    left join e x on ((st.stage='page_view' and x.event='page_view' and
      ((f.funnel='callback' and x.page in ('/','/konyhabutor.html')) or (f.funnel='cutting' and x.page in ('/lapszabaszat.html','/lapszabaszat-ajanlatkeres.html'))))
      or (st.stage<>'page_view' and x.event=st.stage and (x.funnel=f.funnel or (x.event='cta_click' and x.target=f.funnel))))
    group by f.funnel,st.stage
  )
  select jsonb_build_object(
    'generated_at',clock_timestamp(),'days',p_days,'collection_started_at',(select min(created_at) from private.visitor_events where not is_test),
    'summary',jsonb_build_object('visits',(select count(*) from sessions),'page_views',(select count(*) from e where event='page_view'),
      'leads',(select count(distinct quote_request_id) from leads),'phone_clicks',(select count(distinct session_token) from e where event='cta_click' and target='phone'),
      'errors',(select count(distinct session_token) from e where event in ('validation_error','submit_error')),
      'orders',(select count(distinct l.quote_request_id) from leads l join public.quote_requests q on q.id=l.quote_request_id where q.status='ordered')),
    'funnels',coalesce((select jsonb_agg(to_jsonb(fc)) from funnel_counts fc),'[]'::jsonb),
    'sources',coalesce((select jsonb_agg(to_jsonb(r)) from (
      select s.source,s.campaign_id,count(*) as visits,count(*) filter(where exists(select 1 from leads l where l.session_token=s.session_token)) as leads
      from sessions s group by s.source,s.campaign_id order by count(*) desc) r),'[]'::jsonb),
    'pages',coalesce((select jsonb_agg(to_jsonb(r)) from (
      select v.page,count(distinct v.session_token) as visits,count(*) as page_views,
        (select count(*) from sessions s where s.page=v.page) as entries,
        (select count(*) from last_pages l join inactive i using(session_token) where l.page=v.page) as last_observed
      from e v where v.event='page_view' group by v.page order by count(*) desc) r),'[]'::jsonb),
    'errors',coalesce((select jsonb_agg(to_jsonb(r)) from (
      select event,target,funnel,page,device,count(distinct session_token) as sessions from e where event in ('validation_error','submit_error','resource_error')
      group by event,target,funnel,page,device order by count(distinct session_token) desc limit 30) r),'[]'::jsonb),
    'steps',coalesce((select jsonb_agg(to_jsonb(r)) from (
      select l.target,count(*) as sessions from last_steps l join inactive i using(session_token)
      where not exists(select 1 from e v where v.session_token=l.session_token and v.event='submit_success' and v.funnel='cutting') group by l.target order by count(*) desc) r),'[]'::jsonb),
    'engagement',coalesce((select jsonb_agg(to_jsonb(r)) from (
      select event,target,page,count(distinct session_token) as sessions from e where event in ('section_view','reference_view','scroll_depth','engaged','cta_click','details_open')
      group by event,target,page order by event,page,target) r),'[]'::jsonb),
    'daily',coalesce((select jsonb_agg(to_jsonb(r)) from (
      select (s.created_at at time zone 'Europe/Budapest')::date as day,count(*) as visits,
        count(*) filter(where exists(select 1 from leads l where l.session_token=s.session_token)) as leads
      from sessions s group by 1 order by 1) r),'[]'::jsonb)
  ) into result;
  return result;
end;
$fn$;
revoke all on function public.get_visitor_measurement_report(integer,text,text) from public,anon,authenticated,service_role;
grant execute on function public.get_visitor_measurement_report(integer,text,text) to service_role;
