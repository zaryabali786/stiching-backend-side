-- ==============================================================================
-- 0014_central_orders_email_matching.sql
--   1. Every new order starts at the admin's central location (partner_id NULL); the admin chooses the partner later.
--   2. Follow-up emails (shipping / tracking) are matched to the customer's existing order by its order number:
--      the inbox email remembers the order it updated, or that it needs a manual look.
--   3. Courier name read from an email is kept on the order even when it is not in the courier list.
--   4. Guard against duplicates: one email-created order per (customer, brand order number).
-- Safe to run more than once.
-- ==============================================================================

-- 1. CENTRAL LOCATION FIRST ----------------------------------------------------
-- New orders wait for the admin to choose a partner (Settings > Orders is set to "manual").
INSERT INTO public.platform_settings (key, value) VALUES ('order_assignment', '{"mode": "manual"}')
ON CONFLICT (key) DO UPDATE SET value = '{"mode": "manual"}'::jsonb, updated_at = NOW();

-- 2. EMAIL <-> ORDER MATCHING --------------------------------------------------
ALTER TABLE public.inbox_emails ADD COLUMN IF NOT EXISTS order_id UUID REFERENCES public.orders(id) ON DELETE SET NULL;
-- none    = nothing to match (newsletter, first order confirmation that made a draft ...)
-- matched = the courier / tracking in this email were saved on order_id
-- review  = the order number was missing or matched more than one order: nothing was changed, a person must look
ALTER TABLE public.inbox_emails ADD COLUMN IF NOT EXISTS match_status TEXT NOT NULL DEFAULT 'none';
ALTER TABLE public.inbox_emails ADD COLUMN IF NOT EXISTS match_note TEXT;
DO $$ BEGIN
  ALTER TABLE public.inbox_emails ADD CONSTRAINT inbox_emails_match_status_check CHECK (match_status IN ('none', 'matched', 'review'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS inbox_emails_order_idx ON public.inbox_emails (order_id) WHERE order_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS inbox_emails_review_idx ON public.inbox_emails (customer_id) WHERE match_status = 'review';

-- 3. COURIER NAME FROM AN EMAIL --------------------------------------------------
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS courier_name TEXT;
-- when the courier / tracking last came from an email (an older email never overwrites a newer one)
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS shipping_updated_at TIMESTAMPTZ;

-- 4. NO DUPLICATES ---------------------------------------------------------------
-- Looking an order up by its number must find at most one email-created order per customer.
DO $$ BEGIN
  CREATE UNIQUE INDEX IF NOT EXISTS orders_email_order_number_idx
    ON public.orders (customer_id, lower(btrim(brand_order_number)))
    WHERE import_source = 'email' AND brand_order_number IS NOT NULL AND btrim(brand_order_number) <> '' AND status <> 'cancelled';
EXCEPTION WHEN unique_violation THEN
  RAISE NOTICE 'orders_email_order_number_idx not created: duplicate email orders already exist. Clean them up and run this file again.';
END $$;
