-- ==============================================================================
-- 0020_default_partner_assignment.sql
-- New orders go automatically to the partner the admin marked as DEFAULT (Partners > Make default).
--   mode 'default'  every new / submitted order gets the default partner (when it is active)
--   mode 'auto'     the least busy partner (as before)      mode 'manual'  the order waits for the admin
-- Orders still waiting at the central location (no partner yet) are given the default partner now.
-- Safe to run more than once.
-- ==============================================================================

INSERT INTO public.platform_settings (key, value) VALUES ('order_assignment', '{"mode": "default"}')
ON CONFLICT (key) DO UPDATE SET value = '{"mode": "default"}'::jsonb, updated_at = NOW();

CREATE OR REPLACE FUNCTION public.assign_default_partner()
RETURNS TRIGGER AS $$
DECLARE
  v_mode TEXT;
BEGIN
  IF NEW.partner_id IS NULL AND NEW.status <> 'draft' AND (TG_OP = 'INSERT' OR OLD.status = 'draft') THEN
    SELECT COALESCE(value->>'mode', 'auto') INTO v_mode FROM public.platform_settings WHERE key = 'order_assignment';
    v_mode := COALESCE(v_mode, 'auto');
    IF v_mode = 'default' THEN
      SELECT id INTO NEW.partner_id FROM public.partners WHERE is_default AND status = 'active' LIMIT 1;
    ELSIF v_mode = 'auto' THEN
      NEW.partner_id := public.pick_partner_for_new_order();
      IF NEW.partner_id IS NULL THEN
        SELECT id INTO NEW.partner_id FROM public.partners WHERE is_default AND status = 'active' LIMIT 1;
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = public;

-- Open orders that never got a partner (they were waiting at the central location)
UPDATE public.orders
   SET partner_id = (SELECT id FROM public.partners WHERE is_default AND status = 'active' LIMIT 1)
 WHERE partner_id IS NULL
   AND status NOT IN ('draft', 'cancelled', 'delivered')
   AND EXISTS (SELECT 1 FROM public.partners WHERE is_default AND status = 'active');
