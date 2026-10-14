-- ==============================================================================
-- 0026_article_hold.sql
-- When the customer rejects an article they can either ask for it to be RETURNED (notes + photos + where to) or put it
-- on HOLD (one short text). A held article stays rejected with return_status = 'held' until the customer decides.
-- Safe to run more than once.
-- ==============================================================================

alter table public.order_units drop constraint if exists order_units_return_status_check;
alter table public.order_units add constraint order_units_return_status_check
  check (return_status in ('none', 'requested', 'sent_back', 'resubmitted', 'held'));

notify pgrst, 'reload schema';
