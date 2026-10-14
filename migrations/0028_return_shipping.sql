-- ==============================================================================
-- 0028_return_shipping.sql
-- Where a rejected article is sent back to when the customer asks for a return to themselves: name, phone, address, city,
-- country. It starts from the customer's delivery address and the customer can change it for this return.
-- Safe to run more than once.
-- ==============================================================================

alter table public.order_units add column if not exists return_shipping jsonb;

notify pgrst, 'reload schema';
