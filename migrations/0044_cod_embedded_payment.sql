-- ==============================================================================
-- 0044: COD paid inside the app (Stripe Payment Element) and the real Shopify payment status.
-- Additive and nullable: existing orders are untouched. Safe to run more than once.
-- ==============================================================================

-- what Shopify itself says about the brand order's payment (never assumed): its financial status, what is paid, what is still owed
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS shopify_financial_status TEXT;
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS shopify_amount_paid NUMERIC(12,2);
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS shopify_outstanding NUMERIC(12,2);
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS shopify_payment_checked_at TIMESTAMPTZ;

-- the payment history of COD orders: one row per Stripe PaymentIntent (the unique reference keeps a repeated event from adding a second row)
CREATE TABLE IF NOT EXISTS public.cod_payments (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  order_id UUID NOT NULL REFERENCES public.orders(id) ON DELETE CASCADE,
  provider TEXT NOT NULL DEFAULT 'stripe',
  provider_ref TEXT NOT NULL,
  amount NUMERIC(12, 2) NOT NULL,
  currency TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'succeeded', 'failed', 'canceled')),
  failure_message TEXT,
  created_by UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS cod_payments_provider_ref_idx ON public.cod_payments (provider_ref);
CREATE INDEX IF NOT EXISTS cod_payments_order_idx ON public.cod_payments (order_id);
ALTER TABLE public.cod_payments ENABLE ROW LEVEL SECURITY;
