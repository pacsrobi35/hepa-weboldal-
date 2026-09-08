-- Restrict direct API roles to the minimum privileges required by the live HEPA flows.
revoke all privileges on table
  public.profiles,
  public.admin_users,
  public.quote_requests,
  public.quote_request_files,
  public.quote_submission_attempts,
  public.quote_offers,
  public.quote_offer_items,
  public.reference_images
from public, anon, authenticated, service_role;

grant select (
  id,
  category,
  storage_path,
  alt_text,
  sort_order,
  is_published,
  created_at
) on public.reference_images to anon;

grant select on public.admin_users to authenticated;
grant select, insert, update on public.profiles to authenticated;
grant select on public.quote_requests to authenticated;
grant update (status, updated_at) on public.quote_requests to authenticated;
grant select on public.quote_request_files to authenticated;
grant select, insert, update, delete on public.quote_offers to authenticated;
grant select, insert, update, delete on public.quote_offer_items to authenticated;
grant select, insert, update, delete on public.reference_images to authenticated;

grant select, insert, update, delete on table
  public.profiles,
  public.admin_users,
  public.quote_requests,
  public.quote_request_files,
  public.quote_offers,
  public.quote_offer_items,
  public.reference_images
to service_role;
grant select, insert, delete on public.quote_submission_attempts to service_role;

revoke all privileges on sequence
  public.quote_requests_id_seq,
  public.quote_request_files_id_seq,
  public.quote_submission_attempts_id_seq,
  public.quote_offers_id_seq,
  public.quote_offer_items_id_seq,
  public.quote_offer_number_seq,
  public.reference_images_id_seq
from public, anon, authenticated, service_role;

grant usage on sequence
  public.quote_offers_id_seq,
  public.quote_offer_items_id_seq,
  public.quote_offer_number_seq,
  public.reference_images_id_seq
to authenticated;

grant usage on sequence
  public.quote_requests_id_seq,
  public.quote_request_files_id_seq,
  public.quote_submission_attempts_id_seq,
  public.quote_offers_id_seq,
  public.quote_offer_items_id_seq,
  public.quote_offer_number_seq,
  public.reference_images_id_seq
to service_role;

revoke all on function public.consume_quote_submission_limit(text, integer, integer)
  from public, anon, authenticated, service_role;
revoke all on function public.save_quote_offer(
  bigint, text, numeric, numeric, date, text, text, text, jsonb, bigint
) from public, anon, authenticated, service_role;
revoke all on function public.mark_quote_offer_sent(bigint, text, text)
  from public, anon, authenticated, service_role;

grant execute on function public.consume_quote_submission_limit(text, integer, integer)
  to service_role;
grant execute on function public.save_quote_offer(
  bigint, text, numeric, numeric, date, text, text, text, jsonb, bigint
) to authenticated;
grant execute on function public.mark_quote_offer_sent(bigint, text, text)
  to authenticated;

-- Future public-schema objects must opt into API access explicitly.
alter default privileges for role postgres in schema public
  revoke all on tables from public, anon, authenticated, service_role;
alter default privileges for role postgres in schema public
  revoke all on sequences from public, anon, authenticated, service_role;
alter default privileges for role postgres in schema public
  revoke all on functions from public, anon, authenticated, service_role;
