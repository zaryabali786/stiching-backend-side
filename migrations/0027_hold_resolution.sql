-- ==============================================================================
-- 0027_hold_resolution.sql
-- Hold articles are corrected and come back:
--   held_at           when the customer put the article on hold
--   hold_received_at  when the partner confirmed the corrected article ("Receive Corrected Article")
--   hold_received_by  who confirmed it
--   hold_resolved_at  when the customer approved the corrected article: the hold is resolved (<ref>-RESOLVED)
-- Orders are shown in groups (<ref>, <ref>-HOLD, <ref>-RETURN, <ref>-RESOLVED) derived from these article states;
-- no order or article is duplicated. Safe to run more than once.
-- ==============================================================================

alter table public.order_units add column if not exists held_at timestamptz;
alter table public.order_units add column if not exists hold_received_at timestamptz;
alter table public.order_units add column if not exists hold_received_by uuid references public.profiles(id) on delete set null;
alter table public.order_units add column if not exists hold_resolved_at timestamptz;

-- articles already on hold before this migration
update public.order_units set held_at = coalesce(return_updated_at, reviewed_at, now()) where return_status = 'held' and held_at is null;

create index if not exists order_units_hold_idx on public.order_units (order_id) where held_at is not null;

notify pgrst, 'reload schema';
