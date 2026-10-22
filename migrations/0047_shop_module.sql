-- ==============================================================================
-- 0047: Shop module (multi-brand ecommerce + dropshipping).
-- Additive only: no existing table is changed. Safe to run more than once.
-- Money: the customer pays the PLATFORM once (Stripe); each brand gets its own order in its own Shopify store (pending payment, never
-- marked paid there); the brand's share is settled later. Commission terms are copied onto each brand order when it is placed.
-- ==============================================================================

-- 1. Per brand store: may it sell in the Shop, the commercial terms, and the health of the catalog / order integration
CREATE TABLE IF NOT EXISTS public.shop_brand_settings (
  store_id UUID PRIMARY KEY REFERENCES public.shopify_stores(id) ON DELETE CASCADE,
  approved BOOLEAN NOT NULL DEFAULT FALSE,
  commission_model TEXT NOT NULL DEFAULT 'percent' CHECK (commission_model IN ('percent', 'fixed')),
  commission_rate NUMERIC(6, 3) NOT NULL DEFAULT 0 CHECK (commission_rate >= 0 AND commission_rate <= 100),
  commission_fixed NUMERIC(12, 2) NOT NULL DEFAULT 0 CHECK (commission_fixed >= 0),
  shipping_flat NUMERIC(12, 2) NOT NULL DEFAULT 0 CHECK (shipping_flat >= 0),
  currency TEXT,
  catalog_status TEXT NOT NULL DEFAULT 'never' CHECK (catalog_status IN ('never', 'syncing', 'ok', 'error')),
  catalog_synced_at TIMESTAMPTZ,
  catalog_error TEXT,
  inventory_known BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 2. The synchronized catalog (a snapshot of the brand's Shopify products; refreshed by sync + products webhooks)
CREATE TABLE IF NOT EXISTS public.shop_products (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  store_id UUID NOT NULL REFERENCES public.shopify_stores(id) ON DELETE CASCADE,
  shopify_product_id TEXT NOT NULL,
  handle TEXT,
  title TEXT NOT NULL,
  description TEXT,
  vendor TEXT,
  category TEXT,
  collections JSONB NOT NULL DEFAULT '[]'::jsonb,
  tags JSONB NOT NULL DEFAULT '[]'::jsonb,
  image_url TEXT,
  images JSONB NOT NULL DEFAULT '[]'::jsonb,
  options JSONB NOT NULL DEFAULT '[]'::jsonb,
  price_min NUMERIC(12, 2),
  price_max NUMERIC(12, 2),
  currency TEXT,
  in_stock BOOLEAN NOT NULL DEFAULT TRUE,
  -- the product is for sale in the brand's store (active and published); false rows stay for history but are never shown or bought
  sellable BOOLEAN NOT NULL DEFAULT TRUE,
  shopify_status TEXT,
  -- hidden by an administrator from OUR Shop only (nothing changes in the brand's store)
  hidden BOOLEAN NOT NULL DEFAULT FALSE,
  shopify_updated_at TIMESTAMPTZ,
  synced_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (store_id, shopify_product_id)
);
CREATE INDEX IF NOT EXISTS shop_products_browse_idx ON public.shop_products (sellable, hidden, store_id);
CREATE INDEX IF NOT EXISTS shop_products_title_idx ON public.shop_products (lower(title));

CREATE TABLE IF NOT EXISTS public.shop_variants (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  product_id UUID NOT NULL REFERENCES public.shop_products(id) ON DELETE CASCADE,
  shopify_variant_id TEXT NOT NULL,
  title TEXT,
  sku TEXT,
  options JSONB NOT NULL DEFAULT '{}'::jsonb,
  price NUMERIC(12, 2) NOT NULL,
  compare_at_price NUMERIC(12, 2),
  inventory_quantity INT,
  inventory_policy TEXT,
  in_stock BOOLEAN NOT NULL DEFAULT TRUE,
  image_url TEXT,
  position INT NOT NULL DEFAULT 0,
  UNIQUE (product_id, shopify_variant_id)
);
CREATE INDEX IF NOT EXISTS shop_variants_shopify_idx ON public.shop_variants (shopify_variant_id);

-- 3. The cart (kept on the server so it follows the customer between devices)
CREATE TABLE IF NOT EXISTS public.shop_cart_items (
  customer_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  variant_id UUID NOT NULL REFERENCES public.shop_variants(id) ON DELETE CASCADE,
  quantity INT NOT NULL CHECK (quantity > 0),
  unit_price_seen NUMERIC(12, 2),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (customer_id, variant_id)
);

-- 4. The parent order (one payment, one customer) ...
CREATE SEQUENCE IF NOT EXISTS public.shop_order_seq START 1001;
CREATE TABLE IF NOT EXISTS public.shop_orders (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  reference TEXT NOT NULL UNIQUE,
  customer_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
  email TEXT,
  status TEXT NOT NULL DEFAULT 'pending_payment',
  payment_status TEXT NOT NULL DEFAULT 'unpaid' CHECK (payment_status IN ('unpaid', 'paid', 'failed', 'refunded', 'partially_refunded')),
  currency TEXT NOT NULL,
  subtotal NUMERIC(12, 2) NOT NULL,
  shipping_total NUMERIC(12, 2) NOT NULL DEFAULT 0,
  tax_total NUMERIC(12, 2) NOT NULL DEFAULT 0,
  discount_total NUMERIC(12, 2) NOT NULL DEFAULT 0,
  total NUMERIC(12, 2) NOT NULL,
  refunded_total NUMERIC(12, 2) NOT NULL DEFAULT 0,
  address JSONB NOT NULL,
  payment_intent_id TEXT UNIQUE,
  paid_at TIMESTAMPTZ,
  cancelled_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS shop_orders_customer_idx ON public.shop_orders (customer_id, created_at DESC);

-- 5. ... and one child order per brand (its own Shopify order, its own fulfilment, its own commission snapshot). One per brand per parent.
CREATE TABLE IF NOT EXISTS public.shop_brand_orders (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  shop_order_id UUID NOT NULL REFERENCES public.shop_orders(id) ON DELETE CASCADE,
  store_id UUID NOT NULL REFERENCES public.shopify_stores(id) ON DELETE RESTRICT,
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'creating', 'created', 'failed', 'cancelled')),
  last_error TEXT,
  shopify_order_id TEXT,
  shopify_order_name TEXT,
  financial_status TEXT,
  fulfillment_status TEXT NOT NULL DEFAULT 'unfulfilled' CHECK (fulfillment_status IN ('unfulfilled', 'partial', 'dispatched', 'delivered')),
  delivery_verified BOOLEAN NOT NULL DEFAULT FALSE,
  tracking JSONB NOT NULL DEFAULT '[]'::jsonb,
  subtotal NUMERIC(12, 2) NOT NULL,
  shipping NUMERIC(12, 2) NOT NULL DEFAULT 0,
  total NUMERIC(12, 2) NOT NULL,
  -- the commercial terms AT THE TIME OF PURCHASE (a later change of the brand's settings never alters this order)
  commission_model TEXT NOT NULL,
  commission_rate NUMERIC(6, 3) NOT NULL DEFAULT 0,
  commission_fixed NUMERIC(12, 2) NOT NULL DEFAULT 0,
  commission_amount NUMERIC(12, 2) NOT NULL DEFAULT 0,
  brand_payable NUMERIC(12, 2) NOT NULL DEFAULT 0,
  commission_status TEXT NOT NULL DEFAULT 'estimated' CHECK (commission_status IN ('estimated', 'pending', 'settled', 'reversed', 'disputed')),
  dispute_note TEXT,
  refunded_amount NUMERIC(12, 2) NOT NULL DEFAULT 0,
  settlement_id UUID,
  settled_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (shop_order_id, store_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS shop_brand_orders_shopify_idx ON public.shop_brand_orders (store_id, shopify_order_id) WHERE shopify_order_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS shop_brand_orders_state_idx ON public.shop_brand_orders (state, commission_status);

-- 6. Line items (a snapshot: title, variant and price as the customer saw and paid them)
CREATE TABLE IF NOT EXISTS public.shop_order_items (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  shop_order_id UUID NOT NULL REFERENCES public.shop_orders(id) ON DELETE CASCADE,
  brand_order_id UUID NOT NULL REFERENCES public.shop_brand_orders(id) ON DELETE CASCADE,
  product_id UUID REFERENCES public.shop_products(id) ON DELETE SET NULL,
  variant_id UUID REFERENCES public.shop_variants(id) ON DELETE SET NULL,
  shopify_product_id TEXT,
  shopify_variant_id TEXT NOT NULL,
  title TEXT NOT NULL,
  variant_title TEXT,
  sku TEXT,
  image_url TEXT,
  quantity INT NOT NULL CHECK (quantity > 0),
  unit_price NUMERIC(12, 2) NOT NULL,
  line_total NUMERIC(12, 2) NOT NULL
);
CREATE INDEX IF NOT EXISTS shop_order_items_order_idx ON public.shop_order_items (shop_order_id);

-- 7. Settlements: money the platform paid a brand for a set of its brand orders
CREATE TABLE IF NOT EXISTS public.shop_settlements (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  store_id UUID NOT NULL REFERENCES public.shopify_stores(id) ON DELETE RESTRICT,
  amount NUMERIC(12, 2) NOT NULL,
  currency TEXT NOT NULL,
  reference TEXT NOT NULL,
  note TEXT,
  created_by UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  settled_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 8. History of an order (status changes, Shopify events, admin actions)
CREATE TABLE IF NOT EXISTS public.shop_order_events (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  shop_order_id UUID NOT NULL REFERENCES public.shop_orders(id) ON DELETE CASCADE,
  brand_order_id UUID REFERENCES public.shop_brand_orders(id) ON DELETE CASCADE,
  text TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS shop_order_events_order_idx ON public.shop_order_events (shop_order_id, created_at);

-- 9. Payments (one row per Stripe PaymentIntent; the unique reference keeps a repeated event from adding a second row) and refunds
CREATE TABLE IF NOT EXISTS public.shop_payments (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  shop_order_id UUID NOT NULL REFERENCES public.shop_orders(id) ON DELETE CASCADE,
  provider_ref TEXT NOT NULL UNIQUE,
  amount NUMERIC(12, 2) NOT NULL,
  currency TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'succeeded', 'failed', 'canceled')),
  failure_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS public.shop_refunds (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  brand_order_id UUID NOT NULL REFERENCES public.shop_brand_orders(id) ON DELETE CASCADE,
  shopify_refund_id TEXT NOT NULL,
  amount NUMERIC(12, 2) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (brand_order_id, shopify_refund_id)
);

ALTER TABLE public.shop_brand_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.shop_products ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.shop_variants ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.shop_cart_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.shop_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.shop_brand_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.shop_order_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.shop_settlements ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.shop_order_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.shop_payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.shop_refunds ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.next_shop_order_ref() RETURNS TEXT AS $$
  SELECT 'SH-' || nextval('public.shop_order_seq')::text
$$ LANGUAGE sql;
