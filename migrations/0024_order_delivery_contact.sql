-- ==============================================================================
-- 0024_order_delivery_contact.sql
-- The delivery address and phone given when an order is submitted belong to THAT order only (the customer's profile
-- is not changed). The address columns exist already; this adds the phone number for the order.
-- Safe to run more than once.
-- ==============================================================================

alter table public.orders add column if not exists destination_phone text;
