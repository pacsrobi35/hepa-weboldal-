create extension if not exists pg_cron with schema pg_catalog;

grant usage on schema cron to postgres;
grant all privileges on all tables in schema cron to postgres;

create or replace function public.consume_quote_submission_limit(
  p_fingerprint_hash text,
  p_max_attempts integer default 5,
  p_window_seconds integer default 600
)
returns boolean
language plpgsql
security invoker
set search_path = ''
as $function$
declare
  v_attempt_count integer;
begin
  if p_fingerprint_hash !~ '^[0-9a-f]{64}$'
     or p_max_attempts not between 1 and 100
     or p_window_seconds not between 60 and 86400 then
    raise exception 'invalid rate limit arguments';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_fingerprint_hash, 0)
  );

  select count(*)
    into v_attempt_count
    from public.quote_submission_attempts
   where fingerprint_hash = p_fingerprint_hash
     and created_at >= pg_catalog.now()
       - pg_catalog.make_interval(secs => p_window_seconds);

  if v_attempt_count >= p_max_attempts then
    return false;
  end if;

  insert into public.quote_submission_attempts (fingerprint_hash)
  values (p_fingerprint_hash);

  return true;
end;
$function$;

revoke all on function public.consume_quote_submission_limit(text, integer, integer)
  from public, anon, authenticated;
grant execute on function public.consume_quote_submission_limit(text, integer, integer)
  to service_role;

select cron.schedule(
  'cleanup-quote-submission-attempts',
  '17 * * * *',
  $$delete from public.quote_submission_attempts
      where created_at < now() - interval '24 hours'$$
);
