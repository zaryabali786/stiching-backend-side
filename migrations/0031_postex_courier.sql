-- ==============================================================================
-- 0031_postex_courier.sql
-- PostEx as a courier in Catalogue > Couriers (the Warehouse books and tracks parcels with the courier of this name).
-- Safe to run more than once.
-- ==============================================================================
insert into public.couriers (name) values ('PostEx') on conflict do nothing;
