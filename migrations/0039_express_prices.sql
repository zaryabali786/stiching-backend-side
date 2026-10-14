-- Express stitching / express shipping prices. The admin sets them (Settings > Express); an order keeps the price it was made with,
-- and the invoice charges them once as their own lines. Safe to run more than once.
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS express_stitching_price NUMERIC(12, 2);
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS express_shipping_price NUMERIC(12, 2);
ALTER TABLE public.invoice_lines DROP CONSTRAINT IF EXISTS invoice_lines_kind_check;
ALTER TABLE public.invoice_lines ADD CONSTRAINT invoice_lines_kind_check
  CHECK (kind IN ('stitching', 'accessory', 'accessory_stitching', 'shipping', 'duties', 'discount', 'other', 'express_stitching', 'express_shipping'));
NOTIFY pgrst, 'reload schema';
