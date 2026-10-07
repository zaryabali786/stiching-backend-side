-- ==============================================================================
-- 0011_draft_orders.sql
-- Orders made automatically from an email in the customer's Inbox start as a DRAFT:
-- the customer sees them (marked "Draft · from mail") and completes courier / sizes,
-- then submits. Until then no partner or admin sees them and nobody is notified.
-- Safe to run more than once.
-- ==============================================================================

-- 1. the new status
ALTER TABLE public.orders DROP CONSTRAINT IF EXISTS orders_status_check;
ALTER TABLE public.orders ADD CONSTRAINT orders_status_check CHECK (
  status IN (
    'draft', 'submitted', 'received', 'assigned', 'cutting', 'stitching',
    'qc_passed', 'customer_approval', 'packed', 'invoice_issued',
    'awaiting_payment', 'paid', 'at_admin_warehouse', 'partner_dispatch',
    'shipped', 'delivered', 'cancelled'
  )
);

-- a draft ranks before everything (the forward-only guard only matters from "paid" on)
CREATE OR REPLACE FUNCTION public.order_status_rank(p_status TEXT)
RETURNS INTEGER AS $$
  SELECT CASE p_status
    WHEN 'draft' THEN -1
    WHEN 'submitted' THEN 0 WHEN 'received' THEN 1 WHEN 'assigned' THEN 2 WHEN 'cutting' THEN 3
    WHEN 'stitching' THEN 4 WHEN 'qc_passed' THEN 5 WHEN 'customer_approval' THEN 6 WHEN 'packed' THEN 7
    WHEN 'invoice_issued' THEN 8 WHEN 'awaiting_payment' THEN 9 WHEN 'paid' THEN 10
    WHEN 'at_admin_warehouse' THEN 11 WHEN 'partner_dispatch' THEN 11
    WHEN 'shipped' THEN 12 WHEN 'delivered' THEN 13
    ELSE NULL END;
$$ LANGUAGE sql IMMUTABLE;

-- 2. a draft belongs to no partner. The partner is chosen (per the admin's Settings > Orders)
--    at the moment the customer submits the draft, exactly as for a normally created order.
CREATE OR REPLACE FUNCTION public.assign_default_partner()
RETURNS TRIGGER AS $$
DECLARE
  v_mode TEXT;
BEGIN
  IF NEW.partner_id IS NULL AND NEW.status <> 'draft' AND (TG_OP = 'INSERT' OR OLD.status = 'draft') THEN
    SELECT COALESCE(value->>'mode', 'auto') INTO v_mode FROM public.platform_settings WHERE key = 'order_assignment';
    v_mode := COALESCE(v_mode, 'auto');
    IF v_mode = 'auto' THEN
      NEW.partner_id := public.pick_partner_for_new_order();
      IF NEW.partner_id IS NULL THEN
        SELECT id INTO NEW.partner_id FROM public.partners WHERE is_default AND status = 'active' LIMIT 1;
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = public;

DROP TRIGGER IF EXISTS trg_orders_default_partner ON public.orders;
CREATE TRIGGER trg_orders_default_partner BEFORE INSERT OR UPDATE OF status ON public.orders
  FOR EACH ROW EXECUTE FUNCTION public.assign_default_partner();
