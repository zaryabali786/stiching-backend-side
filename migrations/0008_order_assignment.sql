-- ==============================================================================
-- 0008_order_assignment.sql
-- Which partner receives a new customer order. Set by the admin (Settings > Orders):
--   auto    the active partner with the lowest load (open orders / daily capacity of its team) gets it
--   manual  the order stays unassigned (partner_id NULL) until the admin chooses a partner
-- The admin can always move an order to another partner before work on it starts.
-- Safe to run more than once.
-- ==============================================================================
CREATE TABLE IF NOT EXISTS public.platform_settings (
  key TEXT PRIMARY KEY,
  value JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_by UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE public.platform_settings ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "platform_settings_admin" ON public.platform_settings;
CREATE POLICY "platform_settings_admin" ON public.platform_settings FOR ALL USING (public.is_admin()) WITH CHECK (public.is_admin());

INSERT INTO public.platform_settings (key, value) VALUES ('order_assignment', '{"mode": "auto"}')
ON CONFLICT (key) DO NOTHING;

-- Partner with the lowest load among active partners that can receive parcels.
-- load = open orders / total daily capacity of its active team (at least 1); ties: fewer open orders, then the older partner.
CREATE OR REPLACE FUNCTION public.pick_partner_for_new_order()
RETURNS UUID AS $$
  SELECT p.id
    FROM public.partners p
    LEFT JOIN LATERAL (
      SELECT COUNT(*) AS open_orders
        FROM public.orders o
       WHERE o.partner_id = p.id
         AND o.status IN ('submitted', 'received', 'assigned', 'cutting', 'stitching', 'qc_passed', 'customer_approval')
    ) oo ON TRUE
    LEFT JOIN LATERAL (
      SELECT GREATEST(1, COALESCE(SUM(t.daily_capacity), 0)) AS capacity
        FROM public.team_members t
       WHERE t.partner_id = p.id AND t.is_active
    ) cap ON TRUE
   WHERE p.status = 'active' AND 'receiving.view' = ANY (p.permissions)
   ORDER BY oo.open_orders::NUMERIC / cap.capacity, oo.open_orders, p.created_at
   LIMIT 1;
$$ LANGUAGE sql STABLE SET search_path = public;

CREATE OR REPLACE FUNCTION public.assign_default_partner()
RETURNS TRIGGER AS $$
DECLARE
  v_mode TEXT;
BEGIN
  IF NEW.partner_id IS NULL THEN
    SELECT COALESCE(value->>'mode', 'auto') INTO v_mode FROM public.platform_settings WHERE key = 'order_assignment';
    v_mode := COALESCE(v_mode, 'auto');
    IF v_mode = 'auto' THEN
      NEW.partner_id := public.pick_partner_for_new_order();
      -- nobody can take it (none active / none with receiving): fall back to the default partner, else stay unassigned
      IF NEW.partner_id IS NULL THEN
        SELECT id INTO NEW.partner_id FROM public.partners WHERE is_default AND status = 'active' LIMIT 1;
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = public;
