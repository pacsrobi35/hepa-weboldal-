begin;

-- Only a proven pre-send failure can be retried. A timeout or stale 'sending'
-- may mean that Resend accepted the message, so it needs human review.
create or replace function public.claim_cutting_quote_notification(
  p_quote_request_id bigint
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $function$
declare
  v_status text;
  v_updated_at timestamptz;
  v_attempt_count integer;
  v_last_error text;
  v_sent_at timestamptz;
begin
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('cutting-notification-' || p_quote_request_id::text, 0)
  );

  insert into private.cutting_quote_notification_outbox (quote_request_id)
  select p_quote_request_id from public.cutting_quote_requests
  where quote_request_id = p_quote_request_id and submission_state = 'ready'
  on conflict (quote_request_id) do nothing;

  select status, updated_at, attempt_count, last_error
    into v_status, v_updated_at, v_attempt_count, v_last_error
  from private.cutting_quote_notification_outbox
  where quote_request_id = p_quote_request_id for update;

  if v_status is null then
    return jsonb_build_object('state', 'not-ready');
  end if;
  if v_status = 'sent' then
    return jsonb_build_object('state', 'sent');
  end if;

  select notification_sent_at into v_sent_at
  from public.quote_requests where id = p_quote_request_id;
  if v_sent_at is not null then
    return jsonb_build_object('state', 'sent');
  end if;

  if v_status = 'sending' then
    return jsonb_build_object('state',
      case when v_updated_at > clock_timestamp() - interval '5 minutes'
        then 'busy' else 'needs-review' end);
  end if;
  if v_status = 'retryable_error' and v_last_error is distinct from 'resend-api-key-missing' then
    return jsonb_build_object('state', 'needs-review');
  end if;

  update private.cutting_quote_notification_outbox
  set status = 'sending',
      attempt_count = least(attempt_count + 1, 100),
      last_error = null,
      updated_at = clock_timestamp()
  where quote_request_id = p_quote_request_id
  returning attempt_count into v_attempt_count;

  return jsonb_build_object('state', 'send', 'attempt', v_attempt_count);
end;
$function$;

-- Edge function calls this with its secret key only after validating a live
-- AAL2 admin membership. The function itself cannot be called by browsers.
create function public.claim_admin_intake_notification_retry(p_quote_id bigint)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $function$
declare
  v_kind text;
  v_status text;
  v_error text;
begin
  if p_quote_id is null or p_quote_id < 1 then
    return jsonb_build_object('state', 'not-eligible');
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('cutting-notification-' || p_quote_id::text, 0)
  );

  select request_kind into v_kind from public.quote_requests
  where id = p_quote_id and source = 'website' and intake_state = 'ready'
    and notification_error = 'resend-api-key-missing'
    and notification_sent_at is null;
  if v_kind is null then
    return jsonb_build_object('state', 'not-eligible');
  end if;

  if v_kind = 'furniture' then
    update public.quote_requests
    set notification_error = 'admin-notification-send-claimed'
    where id = p_quote_id and notification_error = 'resend-api-key-missing'
      and notification_sent_at is null;
    if found then
      return jsonb_build_object('state', 'send', 'kind', v_kind);
    end if;
  elsif v_kind = 'cutting' then
    select status, last_error into v_status, v_error
    from private.cutting_quote_notification_outbox
    where quote_request_id = p_quote_id for update;
    if v_status = 'retryable_error' and v_error = 'resend-api-key-missing' then
      update private.cutting_quote_notification_outbox
      set status = 'sending', last_error = null,
          attempt_count = least(attempt_count + 1, 100),
          updated_at = clock_timestamp()
      where quote_request_id = p_quote_id;
      update public.quote_requests
      set notification_error = 'admin-notification-send-claimed'
      where id = p_quote_id;
      return jsonb_build_object('state', 'send', 'kind', v_kind);
    end if;
  end if;

  return jsonb_build_object('state', 'not-eligible');
end;
$function$;

create function public.complete_admin_furniture_notification_retry(
  p_quote_id bigint,
  p_sent boolean,
  p_provider_message_id text default null,
  p_error text default null
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $function$
begin
  if p_sent and nullif(btrim(coalesce(p_provider_message_id, '')), '') is null then
    raise exception 'provider-message-id-required' using errcode = '22023';
  end if;

  update public.quote_requests
  set notification_sent_at = case when p_sent then clock_timestamp() else null end,
      notification_error = case when p_sent then null
        else left(coalesce(nullif(btrim(p_error), ''), 'notification-result-uncertain'), 500)
        end
  where id = p_quote_id and source = 'website' and request_kind = 'furniture'
    and intake_state = 'ready'
    and notification_error = 'admin-notification-send-claimed'
    and notification_sent_at is null;

  return jsonb_build_object('state', case when found then 'recorded' else 'not-eligible' end);
end;
$function$;

revoke all on function public.claim_admin_intake_notification_retry(bigint)
  from public, anon, authenticated, service_role;
revoke all on function public.complete_admin_furniture_notification_retry(bigint, boolean, text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.claim_admin_intake_notification_retry(bigint) to service_role;
grant execute on function public.complete_admin_furniture_notification_retry(bigint, boolean, text, text) to service_role;

notify pgrst, 'reload schema';

commit;
