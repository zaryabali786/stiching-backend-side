-- ==============================================================================
-- 0022_order_sources_returns.sql
-- One parcel-review workflow for every kind of order:
--   website   a purchase made on a brand's website (product links / invoice import)
--   customer  the customer ships their own fabric / parcel to us ("direct from customer")
--   email     an order made from an email in the customer's shopping inbox
-- After the parcel is received the customer approves or rejects each article. A rejection records where the parcel goes
-- back to (the brand or the customer). Website and email orders then finish their articles / sizes / notes before the
-- approved articles enter production; a customer's own order goes straight to production once approved.
-- Safe to run more than once.
-- ==============================================================================

ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS order_source TEXT;
UPDATE public.orders
   SET order_source = CASE
     WHEN import_source = 'email' THEN 'email'
     WHEN import_source IN ('link', 'invoice') THEN 'website'
     WHEN courier_id IS NOT NULL OR tracking_number IS NOT NULL OR brand_order_number IS NOT NULL THEN 'website'
     ELSE 'customer' END
 WHERE order_source IS NULL;
ALTER TABLE public.orders ALTER COLUMN order_source SET DEFAULT 'customer';
ALTER TABLE public.orders ALTER COLUMN order_source SET NOT NULL;
DO $$ BEGIN
  ALTER TABLE public.orders ADD CONSTRAINT orders_order_source_check CHECK (order_source IN ('website', 'customer', 'email'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- when the customer finished the articles / sizes / notes step (website and email orders)
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS details_completed_at TIMESTAMPTZ;
-- orders already past the draft stage have their details: nothing changes for them
UPDATE public.orders SET details_completed_at = COALESCE(received_at, created_at) WHERE status <> 'draft' AND details_completed_at IS NULL;

-- where a rejected article is sent back to
ALTER TABLE public.order_units ADD COLUMN IF NOT EXISTS return_to TEXT;
DO $$ BEGIN
  ALTER TABLE public.order_units ADD CONSTRAINT order_units_return_to_check CHECK (return_to IS NULL OR return_to IN ('brand', 'customer'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- A production ticket only exists for an article that is released: received, approved by the customer when a review
-- applies, its order is not a draft, and (website / email orders) the customer finished the details step.
CREATE OR REPLACE FUNCTION public.create_job_card_for_unit()
RETURNS TRIGGER AS $$
DECLARE
  v_order public.orders%ROWTYPE;
  v_pos DOUBLE PRECISION;
BEGIN
  IF NEW.status = 'received' AND NEW.review_status IN ('none', 'approved') THEN
    SELECT * INTO v_order FROM public.orders WHERE id = NEW.order_id;
    IF v_order.status IN ('draft', 'cancelled') THEN
      RETURN NEW;
    END IF;
    IF v_order.order_source <> 'customer' AND v_order.details_completed_at IS NULL THEN
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

NOTIFY pgrst, 'reload schema';
