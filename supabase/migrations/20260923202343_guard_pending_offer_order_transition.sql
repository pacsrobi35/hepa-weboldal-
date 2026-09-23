begin;

create or replace function private.guard_pending_offer_order_transition()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  -- A direct order can have an optional offer, but deciding that offer relies
  -- on the parent still being ordered. Resolve it before leaving that state.
  if old.status = 'ordered'
     and new.status is distinct from 'ordered'
     and exists (
       select 1
       from public.quote_offers offer
       where offer.quote_request_id = new.id
         and offer.status = 'sent'
     ) then
    raise exception 'pending-optional-offer-requires-decision' using errcode = '55000';
  end if;

  -- A communicated offer must be accepted through decide_quote_offer so the
  -- offer decision, status transition and agreed-total copy stay atomic.
  -- An already ordered case may still keep a sent, optional offer pending.
  -- Reopening a completed job also restores an existing order rather than
  -- creating a new one, so an optional offer must not block that transition.
  if new.status = 'ordered'
     and old.status is distinct from 'ordered'
     and not (old.status = 'closed' and old.close_reason = 'completed')
     and exists (
       select 1
       from public.quote_offers offer
       where offer.quote_request_id = new.id
         and offer.status = 'sent'
     ) then
    raise exception 'pending-offer-requires-acceptance' using errcode = '55000';
  end if;

  return new;
end;
$$;

revoke all on function private.guard_pending_offer_order_transition()
from public, anon, authenticated, service_role;

drop trigger if exists quote_requests_validate_pending_offer_order
on public.quote_requests;

create trigger quote_requests_validate_pending_offer_order
before update of status on public.quote_requests
for each row
execute function private.guard_pending_offer_order_transition();

comment on function private.guard_pending_offer_order_transition() is
  'Guards pending offer decisions around ordered status and preserves the atomic acceptance path.';

commit;
