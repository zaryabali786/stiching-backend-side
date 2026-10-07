-- ==============================================================================
-- 0009_invoice_shipping.sql
-- The shipping item chosen from the shipping price list when an invoice was built. The price itself is copied onto the
-- invoice's shipping line (invoice_lines.customer_amount), so later price-list changes never alter an existing invoice;
-- this column only remembers which rate was selected (it is cleared if the rate is ever deleted).
-- Safe to run more than once.
-- ==============================================================================
ALTER TABLE public.invoices ADD COLUMN IF NOT EXISTS shipping_rate_id UUID REFERENCES public.shipping_rates(id) ON DELETE SET NULL;
