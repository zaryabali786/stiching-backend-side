-- ==============================================================================
-- 0045: the price split of a Shopify order that mixes Stitch&Ship (clothing) lines and normal lines.
-- Shopify keeps one order and one payment; this table records, for each group of lines, what it is worth and how much of the real
-- payment covers it. It never moves money and never writes to Shopify. Additive. Safe to run more than once.
-- ==============================================================================
CREATE TABLE IF NOT EXISTS public.shopify_order_splits (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  -- one row per original order and group: a repeated webhook updates the row, it never adds one
  split_key TEXT NOT NULL,
  shopify_order_row_id UUID NOT NULL REFERENCES public.shopify_orders(id) ON DELETE CASCADE,
  store_id UUID REFERENCES public.shopify_stores(id) ON DELETE SET NULL,
  shopify_order_id TEXT NOT NULL,
  shopify_order_name TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('stitchship', 'normal')),
  -- the Stitch&Ship group points at the customer's order in this app; the normal group is a record only (the brand ships it from Shopify)
  order_id UUID REFERENCES public.orders(id) ON DELETE SET NULL,
  line_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  lines JSONB NOT NULL DEFAULT '[]'::jsonb,
  subtotal NUMERIC(12, 2) NOT NULL DEFAULT 0,
  discounts NUMERIC(12, 2) NOT NULL DEFAULT 0,
  taxes NUMERIC(12, 2) NOT NULL DEFAULT 0,
  shipping NUMERIC(12, 2) NOT NULL DEFAULT 0,
  shipping_tax NUMERIC(12, 2) NOT NULL DEFAULT 0,
  total NUMERIC(12, 2) NOT NULL DEFAULT 0,
  currency TEXT,
  -- the group's share of the ONE real payment; NULL when Shopify's payment could not be read
  amount_paid NUMERIC(12, 2),
  outstanding NUMERIC(12, 2),
  refunded NUMERIC(12, 2) NOT NULL DEFAULT 0,
  -- unpaid | partially_paid | paid | paid_unverified | partially_refunded | refunded | verification_pending | cancelled
  payment_status TEXT NOT NULL DEFAULT 'verification_pending',
  payment_verified BOOLEAN NOT NULL DEFAULT FALSE,
  payment_source TEXT,
  financial_status TEXT,
  -- false when the groups do not add up to Shopify's total (a tip, duties): the difference is in `unallocated`
  reconciled BOOLEAN NOT NULL DEFAULT TRUE,
  unallocated NUMERIC(12, 2) NOT NULL DEFAULT 0,
  taxes_included BOOLEAN NOT NULL DEFAULT FALSE,
  -- the address this group uses: kind, name, city, country, whether it is the atelier (the street stays in Shopify)
  address JSONB,
  tag TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS shopify_order_splits_key_idx ON public.shopify_order_splits (split_key);
CREATE INDEX IF NOT EXISTS shopify_order_splits_row_idx ON public.shopify_order_splits (shopify_order_row_id);
CREATE INDEX IF NOT EXISTS shopify_order_splits_order_idx ON public.shopify_order_splits (order_id);
ALTER TABLE public.shopify_order_splits ENABLE ROW LEVEL SECURITY;
