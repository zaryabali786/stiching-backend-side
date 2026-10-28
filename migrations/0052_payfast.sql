-- ==============================================================================
-- 0052: PayFast (Pakistan) payments. Orders delivered inside Pakistan are paid with PayFast (PKR),
-- orders delivered abroad keep using Stripe. One row per PayFast attempt (basket id): the amount we
-- expect is stored HERE, on the server, so what PayFast reports can be compared against it.
-- Additive. Safe to run more than once.
-- ==============================================================================

CREATE TABLE IF NOT EXISTS public.payfast_payments (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  basket_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('cod', 'invoice')),
  order_id UUID NOT NULL REFERENCES public.orders(id) ON DELETE CASCADE,
  invoice_id UUID REFERENCES public.invoices(id) ON DELETE SET NULL,
  -- what the customer must pay (PKR); never taken from the app or from PayFast's callback
  amount NUMERIC(12, 2) NOT NULL,
  currency TEXT NOT NULL DEFAULT 'PKR',
  -- pending: waiting | paid: verified and applied | failed: PayFast says it failed
  -- amount_mismatch: money moved but not the expected amount (not applied, an admin is told)
  -- duplicate: the order was already paid | invalid: callback with a wrong signature / unknown state
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'paid', 'failed', 'amount_mismatch', 'duplicate', 'invalid')),
  transaction_id TEXT,
  err_code TEXT,
  err_msg TEXT,
  paid_amount NUMERIC(12, 2),
  verified_by TEXT,
  raw JSONB,
  created_by UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  paid_at TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS payfast_payments_basket_idx ON public.payfast_payments (basket_id);
-- a PayFast transaction id can only ever settle one basket
CREATE UNIQUE INDEX IF NOT EXISTS payfast_payments_txn_idx ON public.payfast_payments (transaction_id) WHERE transaction_id IS NOT NULL AND status = 'paid';
CREATE INDEX IF NOT EXISTS payfast_payments_order_idx ON public.payfast_payments (order_id, created_at DESC);
ALTER TABLE public.payfast_payments ENABLE ROW LEVEL SECURITY;
