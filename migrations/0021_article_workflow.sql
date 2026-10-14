-- ==============================================================================
-- 0021_article_workflow.sql
-- Article-level traceability:
--   1. every article (order_units) has its own review state (the customer approves / rejects it after it is received),
--      its own return / correction / resubmission tracking
--   2. a new production stage "pressing" between quality check and packing
--   3. one receipt row per QR scan (who received which article, for which stage, when)
--   4. staff types for the new roles: qa, pressing, packing
--   5. a job card (production ticket) is created only for an article that is released: received, and (when the
--      customer has to review it) approved, and its order is no longer a draft
-- Safe to run more than once.
-- ==============================================================================

-- 1. ARTICLE REVIEW + RETURN --------------------------------------------------------------------------------------
ALTER TABLE public.order_units ADD COLUMN IF NOT EXISTS review_status TEXT NOT NULL DEFAULT 'none';
-- none = no customer review needed · pending = waiting for the customer · approved · rejected
DO $$ BEGIN
  ALTER TABLE public.order_units ADD CONSTRAINT order_units_review_status_check CHECK (review_status IN ('none', 'pending', 'approved', 'rejected'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
ALTER TABLE public.order_units ADD COLUMN IF NOT EXISTS review_note TEXT;
ALTER TABLE public.order_units ADD COLUMN IF NOT EXISTS review_media JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE public.order_units ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMPTZ;
ALTER TABLE public.order_units ADD COLUMN IF NOT EXISTS reviewed_by UUID REFERENCES public.profiles(id) ON DELETE SET NULL;

-- none -> requested (customer asks to send it back) -> sent_back (team returned it) -> resubmitted (corrected / replacement
-- article is back and waits for the customer again)
ALTER TABLE public.order_units ADD COLUMN IF NOT EXISTS return_status TEXT NOT NULL DEFAULT 'none';
DO $$ BEGIN
  ALTER TABLE public.order_units ADD CONSTRAINT order_units_return_status_check CHECK (return_status IN ('none', 'requested', 'sent_back', 'resubmitted'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
ALTER TABLE public.order_units ADD COLUMN IF NOT EXISTS return_note TEXT;
ALTER TABLE public.order_units ADD COLUMN IF NOT EXISTS return_courier TEXT;
ALTER TABLE public.order_units ADD COLUMN IF NOT EXISTS return_tracking TEXT;
ALTER TABLE public.order_units ADD COLUMN IF NOT EXISTS return_updated_at TIMESTAMPTZ;
ALTER TABLE public.order_units ADD COLUMN IF NOT EXISTS resubmit_count INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS order_units_review_idx ON public.order_units (order_id, review_status) WHERE review_status <> 'none';

-- orders whose parcel was already received in the old flow: their articles carry the order's review state
UPDATE public.order_units u
   SET review_status = CASE o.parcel_review WHEN 'pending' THEN 'pending' WHEN 'approved' THEN 'approved' ELSE 'none' END
  FROM public.orders o
 WHERE o.id = u.order_id AND o.parcel_review IN ('pending', 'approved') AND u.review_status = 'none' AND u.status = 'received';

-- 2. PRESSING STAGE ------------------------------------------------------------------------------------------------
ALTER TABLE public.job_cards DROP CONSTRAINT IF EXISTS job_cards_stage_check;
ALTER TABLE public.job_cards ADD CONSTRAINT job_cards_stage_check CHECK (stage IN ('to_assign', 'cutting', 'stitching', 'qc', 'pressing', 'packed'));
ALTER TABLE public.job_cards ADD COLUMN IF NOT EXISTS pressing_at TIMESTAMPTZ;

-- 3. RECEIPTS (one row per scan that moved an article into a stage) -------------------------------------------------
CREATE TABLE IF NOT EXISTS public.unit_stage_receipts (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  order_id UUID NOT NULL REFERENCES public.orders(id) ON DELETE CASCADE,
  unit_id UUID NOT NULL REFERENCES public.order_units(id) ON DELETE CASCADE,
  card_id UUID REFERENCES public.job_cards(id) ON DELETE SET NULL,
  partner_id UUID REFERENCES public.partners(id) ON DELETE SET NULL,
  stage TEXT NOT NULL CHECK (stage IN ('cutting', 'stitching', 'qc', 'pressing', 'packed')),
  -- the role the person acted as: master | tailor | qa | pressing | packing | supervisor
  role TEXT NOT NULL,
  user_id UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  user_name TEXT,
  team_member_id UUID REFERENCES public.team_members(id) ON DELETE SET NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS unit_stage_receipts_unit_idx ON public.unit_stage_receipts (unit_id, received_at DESC);
CREATE INDEX IF NOT EXISTS unit_stage_receipts_order_idx ON public.unit_stage_receipts (order_id, received_at DESC);
CREATE INDEX IF NOT EXISTS unit_stage_receipts_partner_idx ON public.unit_stage_receipts (partner_id, received_at DESC);
ALTER TABLE public.unit_stage_receipts ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "unit_stage_receipts_staff_select" ON public.unit_stage_receipts;
CREATE POLICY "unit_stage_receipts_staff_select" ON public.unit_stage_receipts FOR SELECT USING (public.staff_can_see_order(order_id));

-- 4. STAFF TYPES ----------------------------------------------------------------------------------------------------
ALTER TABLE public.profiles DROP CONSTRAINT IF EXISTS profiles_staff_type_check;
ALTER TABLE public.profiles ADD CONSTRAINT profiles_staff_type_check
  CHECK (staff_type IS NULL OR staff_type IN ('master', 'tailor', 'qa', 'pressing', 'packing', 'staff'));

-- 5. JOB CARDS ONLY FOR RELEASED ARTICLES ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.create_job_card_for_unit()
RETURNS TRIGGER AS $$
DECLARE
  v_order public.orders%ROWTYPE;
  v_pos DOUBLE PRECISION;
BEGIN
  IF NEW.status = 'received' AND NEW.review_status IN ('none', 'approved') THEN
    SELECT * INTO v_order FROM public.orders WHERE id = NEW.order_id;
    -- a draft is still the customer's: its articles join production when the customer submits it
    IF v_order.status IN ('draft', 'cancelled') THEN
      RETURN NEW;
    END IF;
    SELECT COALESCE(MAX(position), 0) + 1024 INTO v_pos FROM public.job_cards WHERE stage = 'to_assign' AND partner_id IS NOT DISTINCT FROM v_order.partner_id;
    INSERT INTO public.job_cards (order_id, unit_id, stage, position, priority, due_date, order_reference, customer_code, unit_title, partner_id)
    VALUES (NEW.order_id, NEW.id, 'to_assign', v_pos, v_order.priority, v_order.due_date,
            v_order.reference, v_order.customer_code, NEW.unit_title, v_order.partner_id)
    ON CONFLICT (unit_id) DO NOTHING;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

DROP TRIGGER IF EXISTS trg_create_job_card ON public.order_units;
CREATE TRIGGER trg_create_job_card
  AFTER INSERT OR UPDATE OF status, review_status ON public.order_units
  FOR EACH ROW EXECUTE FUNCTION public.create_job_card_for_unit();

NOTIFY pgrst, 'reload schema';
