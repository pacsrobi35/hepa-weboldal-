-- A requested callback is its own obligation. Finishing it must not remove
-- an unrelated next action; a scheduled callback action is finished together.
create or replace function private.complete_quote_callback_impl(
  p_quote_request_id bigint,
  p_expected_workflow_updated_at timestamptz default null
)
returns bigint
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_quote public.quote_requests%rowtype;
  v_workflow public.quote_workflows%rowtype;
  v_user_id uuid;
  v_activity_id bigint;
  v_scheduled_callback boolean;
begin
  v_user_id := private.require_quote_delivery_admin();
  if p_quote_request_id is null or p_quote_request_id < 1 then
    raise exception 'Érvénytelen megkeresés.' using errcode = '22023';
  end if;

  -- Lock the parent before the workflow, matching all other CRM mutations.
  select * into v_quote from public.quote_requests
    where id = p_quote_request_id for update;
  if not found then
    raise exception 'Az ügy nem található.' using errcode = 'P0002';
  end if;
  if v_quote.status = 'closed' then
    raise exception 'Lezárt ügyön nincs aktív visszahívás.' using errcode = '22023';
  end if;

  select * into v_workflow from public.quote_workflows
    where quote_request_id = p_quote_request_id for update;
  if v_workflow.updated_at is distinct from p_expected_workflow_updated_at then
    raise exception 'A munkalap időközben módosult. Frissítsd az oldalt.'
      using errcode = '40001';
  end if;

  v_scheduled_callback := v_workflow.next_action is not null
    and v_workflow.next_action_kind = 'callback';
  if (not v_quote.wants_callback or v_workflow.callback_completed_at is not null)
      and not v_scheduled_callback then
    raise exception 'Nincs elintézésre váró visszahívás.' using errcode = '22023';
  end if;

  if v_workflow.quote_request_id is null then
    insert into public.quote_workflows(
      quote_request_id, callback_completed_at, updated_at
    ) values (
      p_quote_request_id, clock_timestamp(), clock_timestamp()
    );
  else
    update public.quote_workflows
      set callback_completed_at = case
            when v_quote.wants_callback then clock_timestamp()
            else callback_completed_at end,
          next_action = case when v_scheduled_callback then null else next_action end,
          next_action_date = case when v_scheduled_callback then null else next_action_date end,
          next_action_time = case when v_scheduled_callback then null else next_action_time end,
          next_action_kind = case when v_scheduled_callback then null else next_action_kind end,
          updated_at = clock_timestamp()
      where quote_request_id = p_quote_request_id;
  end if;

  insert into public.quote_activities(quote_request_id, body, created_by)
    values (
      p_quote_request_id,
      case when v_scheduled_callback then 'A beütemezett visszahívás elintézve.'
        else 'Az ügyfél által kért visszahívás elintézve.' end,
      v_user_id
    )
    returning id into v_activity_id;
  return v_activity_id;
end;
$function$;

revoke all on function private.complete_quote_callback_impl(bigint, timestamptz)
  from public, anon;
grant usage on schema private to authenticated;
grant execute on function private.complete_quote_callback_impl(bigint, timestamptz)
  to authenticated;

create or replace function public.complete_quote_callback(
  p_quote_request_id bigint,
  p_expected_workflow_updated_at timestamptz default null
)
returns bigint
language sql
security invoker
set search_path = ''
as $$
  select private.complete_quote_callback_impl(
    p_quote_request_id, p_expected_workflow_updated_at
  );
$$;

revoke all on function public.complete_quote_callback(bigint, timestamptz)
  from public, anon;
grant execute on function public.complete_quote_callback(bigint, timestamptz)
  to authenticated;
