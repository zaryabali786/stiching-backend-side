-- ==============================================================================
-- 0025_express_stitching.sql
-- Express stitching: the customer can ask for the order to be stitched faster. The admin decides how many days it takes
-- (express_days); the due date follows from it. Safe to run more than once.
-- ==============================================================================

alter table public.orders add column if not exists express_stitching boolean not null default false;
alter table public.orders add column if not exists express_days integer check (express_days is null or express_days between 1 and 90);
