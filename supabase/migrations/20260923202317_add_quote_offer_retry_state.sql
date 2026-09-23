-- Read-only preflight for resuming the existing immutable email delivery.
-- The send/claim RPCs remain the final authority under their existing locks.
begin;

create or replace function public.get_quote_offer_retry_state(p_offer_id bigint)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_offer public.quote_offers%rowtype;
  v_request public.quote_requests%rowtype;
  v_delivery private.quote_offer_deliveries%rowtype;
  v_has_delivery boolean;
  v_reason text;
begin
  perform private.require_quote_delivery_admin();
  if p_offer_id is null or p_offer_id < 1 then
    raise exception 'invalid-offer' using errcode = '22023';
  end if;
  select * into v_offer from public.quote_offers where id = p_offer_id;
  if not found then raise exception 'offer-not-found' using errcode = 'P0002'; end if;
  select * into v_request from public.quote_requests where id = v_offer.quote_request_id;
  if not found then raise exception 'quote-request-not-found' using errcode = 'P0002'; end if;
  select * into v_delivery from private.quote_offer_deliveries where offer_id = p_offer_id;
  v_has_delivery := found;

  if v_offer.sent_at is not null or v_delivery.status = 'finalized' then
    v_reason := 'already_sent';
  elsif v_delivery.provider_message_id is not null or v_delivery.status = 'provider_accepted' then
    v_reason := 'provider_accepted';
  elsif v_offer.status <> 'draft' then
    v_reason := 'offer_locked';
  elsif not v_has_delivery then
    v_reason := 'not_started';
  elsif v_delivery.lease_expires_at > clock_timestamp() then
    v_reason := 'in_progress';
  elsif v_delivery.status not in ('preparing', 'ready', 'sending', 'retryable_error') then
    v_reason := case when v_delivery.status = 'expired' then 'expired' else 'needs_review' end;
  elsif v_request.status in ('ordered', 'closed') or exists (
    select 1 from public.quote_offers
    where quote_request_id = v_offer.quote_request_id and status = 'accepted'
  ) then
    v_reason := 'offer_locked';
  elsif v_offer.valid_until is null
    or v_offer.valid_until < (clock_timestamp() at time zone 'Europe/Budapest')::date then
    v_reason := 'expired';
  elsif v_delivery.first_provider_attempt_at is not null
    and v_delivery.first_provider_attempt_at <= clock_timestamp() - interval '23 hours 45 minutes' then
    v_reason := 'retry_window_expired';
  elsif v_offer.customer_snapshot is null
    or jsonb_typeof(v_offer.customer_snapshot) <> 'object'
    or (v_offer.customer_snapshot->>'customer_name') is distinct from v_request.customer_name
    or lower(btrim(coalesce(v_offer.customer_snapshot->>'email', '')))
      is distinct from lower(btrim(coalesce(v_request.email, '')))
    or btrim(coalesce(v_offer.customer_snapshot->>'phone', ''))
      is distinct from btrim(coalesce(v_request.phone, ''))
    or btrim(coalesce(v_offer.customer_snapshot->>'project_type', ''))
      is distinct from btrim(coalesce(v_request.project_type, ''))
    or (v_delivery.content_snapshot#>>'{customer,customer_name}') is distinct from v_request.customer_name
    or lower(btrim(coalesce(v_delivery.content_snapshot#>>'{customer,email}', '')))
      is distinct from lower(btrim(coalesce(v_request.email, '')))
    or lower(btrim(coalesce(v_delivery.content_snapshot#>>'{customer,email}', '')))
      is distinct from v_delivery.recipient_email
    or btrim(coalesce(v_delivery.content_snapshot#>>'{customer,phone}', ''))
      is distinct from btrim(coalesce(v_request.phone, ''))
    or btrim(coalesce(v_delivery.content_snapshot#>>'{customer,project_type}', ''))
      is distinct from btrim(coalesce(v_request.project_type, '')) then
    v_reason := 'customer_changed';
  elsif v_delivery.provider_payload is null and (
    v_delivery.status <> 'preparing' or v_delivery.attempt_count <> 0
    or v_delivery.first_provider_attempt_at is not null
  ) then
    v_reason := 'needs_review';
  elsif v_delivery.provider_payload is not null and v_delivery.payload_sha256 is distinct from
    encode(extensions.digest(convert_to(v_delivery.provider_payload, 'UTF8'), 'sha256'), 'hex') then
    v_reason := 'needs_review';
  else
    v_reason := 'retry_allowed';
  end if;

  return jsonb_build_object(
    'offer_id', v_offer.id,
    'offer_updated_at', v_offer.updated_at,
    'has_delivery', v_has_delivery,
    'delivery_state', coalesce(v_delivery.status, 'not_started'),
    'can_retry', v_reason = 'retry_allowed',
    'reason', v_reason,
    'recipient_email', v_delivery.recipient_email,
    'provider_delivery_status', v_delivery.provider_delivery_status,
    'sent_at', v_offer.sent_at
  );
end;
$function$;

revoke all on function public.get_quote_offer_retry_state(bigint) from public, anon, authenticated, service_role;
grant execute on function public.get_quote_offer_retry_state(bigint) to authenticated;
comment on function public.get_quote_offer_retry_state(bigint) is
  'Admin AAL2 read-only preflight. Exposes no message payload, provider idempotency key or lease token. Sending still rechecks all guards.';
notify pgrst, 'reload schema';
commit;
