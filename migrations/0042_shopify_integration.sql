-- Shopify brand stores: "Customise stitching with Stitch&Ship".
--
-- A brand installs the Stitch&Ship Shopify app; orders placed with the stitching option reach us by webhook and become a draft
-- order for the customer (matched by the email on the Shopify order). Everything here is additive: existing orders and screens are
-- untouched, and the new order columns stay NULL for every order that did not come from Shopify.

-- 1. The connected stores (the access token is stored ENCRYPTED, never in clear text)
CREATE TABLE IF NOT EXISTS public.shopify_stores (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  shop_domain TEXT NOT NULL UNIQUE,
  access_token_enc TEXT,
  scopes TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'active', 'uninstalled')),
  brand_id UUID REFERENCES public.brands(id) ON DELETE SET NULL,
  -- store options, for example { "cod_gateway_names": ["Cash on Delivery (COD)"] }
  settings JSONB NOT NULL DEFAULT '{}'::jsonb,
  installed_at TIMESTAMPTZ,
  uninstalled_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 2. One row per Shopify order we took in (the unique key makes a repeated notification harmless)
CREATE TABLE IF NOT EXISTS public.shopify_orders (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  store_id UUID NOT NULL REFERENCES public.shopify_stores(id) ON DELETE CASCADE,
  shopify_order_id TEXT NOT NULL,
  shopify_order_name TEXT,
  order_id UUID REFERENCES public.orders(id) ON DELETE SET NULL,
  customer_email TEXT,
  ref_code TEXT,
  -- received | draft_created | failed | cancelled
  state TEXT NOT NULL DEFAULT 'received',
  -- address_ok | address_mismatch | unknown
  address_state TEXT NOT NULL DEFAULT 'unknown',
  -- none | held | released | failed
  hold_state TEXT NOT NULL DEFAULT 'none',
  hold_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  -- the order as Shopify sent it, kept only while the order still needs work (it holds personal data and is cleared when done)
  payload JSONB,
  -- when the customer was sent the "add your sizes" email
  notified_at TIMESTAMPTZ,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (store_id, shopify_order_id)
);
CREATE INDEX IF NOT EXISTS shopify_orders_state_idx ON public.shopify_orders (state, address_state);
CREATE INDEX IF NOT EXISTS shopify_orders_order_idx ON public.shopify_orders (order_id);

-- 3. Every webhook delivery we saw (Shopify's own delivery id: a retry of the same delivery is processed once)
CREATE TABLE IF NOT EXISTS public.shopify_webhook_events (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  webhook_id TEXT NOT NULL UNIQUE,
  topic TEXT NOT NULL,
  shop_domain TEXT,
  payload JSONB,
  attempts INT NOT NULL DEFAULT 0,
  processed_at TIMESTAMPTZ,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS shopify_webhook_events_open_idx ON public.shopify_webhook_events (created_at) WHERE processed_at IS NULL;

-- 4. Sign-in with a one-time code (the email on the Shopify order is the customer's login)
CREATE TABLE IF NOT EXISTS public.login_codes (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  email TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  -- code: the 6 digits the customer types | link: the long token inside an email button
  kind TEXT NOT NULL DEFAULT 'code' CHECK (kind IN ('code', 'link')),
  expires_at TIMESTAMPTZ NOT NULL,
  attempts INT NOT NULL DEFAULT 0,
  consumed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS login_codes_email_idx ON public.login_codes (email, created_at DESC);

-- 5. The order itself: where it came from and the reference that proves the address was ours
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS external_source TEXT;
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS shopify_store_id UUID REFERENCES public.shopify_stores(id) ON DELETE SET NULL;
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS shopify_order_id TEXT;
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS shopify_ref TEXT;
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS stitching_mode TEXT;
CREATE INDEX IF NOT EXISTS orders_shopify_ref_idx ON public.orders (shopify_ref) WHERE shopify_ref IS NOT NULL;
CREATE INDEX IF NOT EXISTS orders_shopify_order_idx ON public.orders (shopify_store_id, shopify_order_id) WHERE shopify_order_id IS NOT NULL;

-- only the API (service role) reads or writes these tables
ALTER TABLE public.shopify_stores ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.shopify_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.shopify_webhook_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.login_codes ENABLE ROW LEVEL SECURITY;
