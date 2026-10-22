-- ==============================================================================
-- 0046: splitting a mixed Shopify order in Shopify itself (a new order for the Stitch&Ship lines, the lines taken off the original).
-- The progress of every split is kept here, step by step, so a retry carries on where it stopped and never makes a second order.
-- Additive. Safe to run more than once. Run AFTER 0045.
-- ==============================================================================
-- the reference this group is known by: for the Stitch&Ship group the NEW Shopify order's number, for the normal group the original order's
ALTER TABLE public.shopify_order_splits ADD COLUMN IF NOT EXISTS reference TEXT;
-- the order number the whole thing came from
ALTER TABLE public.shopify_order_splits ADD COLUMN IF NOT EXISTS original_order_name TEXT;
-- the customer's order in this app that the Stitch&Ship group became (its reference, e.g. SA-1108)
ALTER TABLE public.shopify_order_splits ADD COLUMN IF NOT EXISTS internal_reference TEXT;
-- where this group's items are delivered: the atelier for the Stitch&Ship group, the customer's own address for the normal group
ALTER TABLE public.shopify_order_splits ADD COLUMN IF NOT EXISTS ship_to JSONB;
-- the new Shopify order made for the Stitch&Ship group
ALTER TABLE public.shopify_order_splits ADD COLUMN IF NOT EXISTS split_order_id TEXT;
ALTER TABLE public.shopify_order_splits ADD COLUMN IF NOT EXISTS split_order_name TEXT;
-- the last step that finished: pending | order_created | original_edited | done | child_total_mismatch; the error of the step that failed
ALTER TABLE public.shopify_order_splits ADD COLUMN IF NOT EXISTS split_state TEXT;
ALTER TABLE public.shopify_order_splits ADD COLUMN IF NOT EXISTS split_error TEXT;
-- what the original order totals after the stitching lines were taken off it, and how much of its payment now belongs to the new order
ALTER TABLE public.shopify_order_splits ADD COLUMN IF NOT EXISTS original_total_after NUMERIC(12, 2);
ALTER TABLE public.shopify_order_splits ADD COLUMN IF NOT EXISTS overpaid_on_original NUMERIC(12, 2);
CREATE INDEX IF NOT EXISTS shopify_order_splits_new_order_idx ON public.shopify_order_splits (split_order_id);
