-- ==============================================================================
-- 0017_parcel_receiving_media.sql
-- Receiving for orders that come "direct from a website" (email drafts):
--   * every article gets a permanent code (<order reference>-<n>) shown as a QR code
--   * the receiver uploads photos / a video of the whole parcel and of each article
--   * a draft stays a draft when its parcel arrives; the customer reviews the media and approves,
--     then adds sizes and details and submits (the order then continues as "received")
-- Safe to run more than once.
-- ==============================================================================

ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS parcel_media JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS parcel_received_at TIMESTAMPTZ;
-- none = nothing to review · pending = waiting for the customer · approved
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS parcel_review TEXT NOT NULL DEFAULT 'none';
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS parcel_review_at TIMESTAMPTZ;
DO $$ BEGIN
  ALTER TABLE public.orders ADD CONSTRAINT orders_parcel_review_check CHECK (parcel_review IN ('none', 'pending', 'approved'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE public.order_units ADD COLUMN IF NOT EXISTS code TEXT;
ALTER TABLE public.order_units ADD COLUMN IF NOT EXISTS receive_media JSONB NOT NULL DEFAULT '[]'::jsonb;

-- The code never changes once given, even if the articles are re-ordered or one is removed.
CREATE OR REPLACE FUNCTION public.set_unit_code()
RETURNS TRIGGER AS $$
DECLARE
  v_ref TEXT;
  v_next INTEGER;
BEGIN
  IF NEW.code IS NULL THEN
    SELECT reference INTO v_ref FROM public.orders WHERE id = NEW.order_id;
    SELECT COALESCE(MAX(substring(code FROM '-(\d+)$')::int), 0) + 1 INTO v_next FROM public.order_units WHERE order_id = NEW.order_id AND code IS NOT NULL;
    NEW.code := COALESCE(v_ref, 'ORD') || '-' || v_next;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = public;

DROP TRIGGER IF EXISTS trg_order_units_code ON public.order_units;
CREATE TRIGGER trg_order_units_code BEFORE INSERT ON public.order_units
  FOR EACH ROW EXECUTE FUNCTION public.set_unit_code();

-- Backfill existing articles in their line order.
UPDATE public.order_units u
SET code = o.reference || '-' || n.rn
FROM public.orders o, (
  SELECT id, ROW_NUMBER() OVER (PARTITION BY order_id ORDER BY line_no, created_at) AS rn FROM public.order_units
) n
WHERE u.id = n.id AND o.id = u.order_id AND u.code IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS order_units_code_idx ON public.order_units (code) WHERE code IS NOT NULL;
