-- Optional, consent-gated website funnel stages, without customer field contents,
-- attribution, IP addresses, URLs with query strings, or submission identifiers.
create schema if not exists private;

create table private.lead_funnel_events (
  session_token uuid not null
    check (session_token::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
  event text not null
    check (event in ('cta_click', 'form_view', 'form_start', 'submit_attempt', 'submit_success')),
  funnel text not null check (funnel in ('callback', 'cutting')),
  page text not null
    check (page in ('/', '/index.html', '/konyhabutor.html', '/lapszabaszat.html', '/lapszabaszat-ajanlatkeres.html')),
  device text not null check (device in ('mobile', 'desktop')),
  created_at timestamptz not null default now(),
  is_test boolean not null default false,
  primary key (session_token, funnel, event)
);

create index lead_funnel_events_created_at_idx
  on private.lead_funnel_events (created_at);
alter table private.lead_funnel_events enable row level security;
alter table private.lead_funnel_events force row level security;

revoke all on private.lead_funnel_events from public, anon, authenticated, service_role;
grant usage on schema private to service_role;
grant select, insert, delete on private.lead_funnel_events to service_role;

comment on table private.lead_funnel_events is
  'Consent-gated 30-day lead funnel stages. Private and service-role-only; never stores form contents, IP or marketing identifiers. Purged in bounded batches on incoming events.';

create function public.record_lead_funnel_event(
  p_session_token uuid,
  p_event text,
  p_funnel text,
  p_page text,
  p_device text,
  p_submission_token uuid default null
)
returns boolean
language plpgsql
security invoker
set search_path = ''
as $function$
declare
  v_rows integer;
begin
  if p_session_token is null
    or p_session_token::text !~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    or p_event is null or p_event not in ('cta_click', 'form_view', 'form_start', 'submit_attempt', 'submit_success')
    or p_funnel is null or p_funnel not in ('callback', 'cutting')
    or p_page is null or p_page not in ('/', '/index.html', '/konyhabutor.html', '/lapszabaszat.html', '/lapszabaszat-ajanlatkeres.html')
    or p_device is null or p_device not in ('mobile', 'desktop')
    or (p_event <> 'submit_success' and p_submission_token is not null)
    or (p_event = 'submit_success' and (
      p_submission_token is null
      or p_submission_token::text !~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    )) then
    raise exception 'Invalid funnel event' using errcode = '22023';
  end if;

  -- Serialize the very small collector's writes so the project-wide abuse limit
  -- remains bounded even when many anonymous sessions arrive concurrently.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('hepa-lead-funnel-daily-limit', 0)
  );

  -- Bounded, indexed cleanup avoids a new scheduler and keeps collection cheap.
  -- Reports must filter created_at >= now() - interval '30 days'. During an idle
  -- period expired rows remain private until the next event triggers cleanup.
  with expired as (
    select session_token, funnel, event
    from private.lead_funnel_events
    where created_at < now() - interval '30 days'
    order by created_at
    limit 1000
  )
  delete from private.lead_funnel_events e
  using expired x
  where e.session_token = x.session_token and e.funnel = x.funnel and e.event = x.event;

  -- A browser-reported success is counted only after the actual website inquiry
  -- reached ready state. The transient token is used for verification, not stored.
  if p_event = 'submit_success' and not exists (
    select 1
    from public.quote_requests q
    left join public.quote_workflows w on w.quote_request_id = q.id
    left join public.cutting_quote_requests c on c.quote_request_id = q.id
    where q.submission_token = p_submission_token
      and q.source = 'website'
      and q.intake_state = 'ready'
      and q.request_kind = case p_funnel when 'callback' then 'furniture' else 'cutting' end
      and (p_funnel <> 'callback' or q.wants_callback is true)
      and not coalesce(w.is_test, false)
      and (p_funnel <> 'cutting' or c.submission_state = 'ready')
  ) then
    return false;
  end if;

  if exists (
    select 1 from private.lead_funnel_events
    where session_token = p_session_token and funnel = p_funnel and event = p_event
  ) then
    return false;
  end if;

  -- A rolling 24-hour ceiling is far above normal local-business traffic but
  -- prevents unbounded growth. No IP address, fingerprint or identifier blacklist.
  if (select count(*) from (
    select 1 from private.lead_funnel_events
    where created_at >= now() - interval '24 hours'
    limit 10000
  ) recent) >= 10000 then
    return false;
  end if;

  insert into private.lead_funnel_events (session_token, event, funnel, page, device)
  values (p_session_token, p_event, p_funnel, p_page, p_device)
  on conflict (session_token, funnel, event) do nothing;
  get diagnostics v_rows = row_count;
  return v_rows > 0;
end;
$function$;

revoke all on function public.record_lead_funnel_event(uuid, text, text, text, text, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.record_lead_funnel_event(uuid, text, text, text, text, uuid)
  to service_role;
