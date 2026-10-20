-- Cash on delivery (COD) orders that came from an email.
--
-- The customer (or authorised staff) marks an email order as COD or NON_COD. For COD the order total is read from the original
-- email, saved here once it is verified, and the customer pays it through Stripe Checkout before the order can be edited.
-- Everything is additive and nullable: existing orders keep NULL in every column below and behave exactly as before (nothing is
-- guessed or migrated to Paid / Unpaid).

ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS payment_type TEXT;
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS payment_type_set_by UUID REFERENCES public.profiles(id) ON DELETE SET NULL;
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS payment_type_set_at TIMESTAMPTZ;

-- the total payable of the whole order, as read from the email (or typed by staff)
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS cod_amount NUMERIC(12,2);
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS cod_currency TEXT;
-- extracted: read from the email and consistent | needs_verification: missing or ambiguous, staff must enter it | verified / corrected: confirmed / changed by staff
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS cod_amount_status TEXT;
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS cod_amount_source TEXT;
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS cod_amount_note TEXT;
-- the email the amount was read from
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS cod_email_ref UUID REFERENCES public.inbox_emails(id) ON DELETE SET NULL;

ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS cod_payment_status TEXT;
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS cod_stripe_session_id TEXT;
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS cod_stripe_payment_intent TEXT;
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS cod_paid_at TIMESTAMPTZ;
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS cod_paid_minor BIGINT;

DO $$ BEGIN
  ALTER TABLE public.orders ADD CONSTRAINT orders_payment_type_check CHECK (payment_type IS NULL OR payment_type IN ('COD', 'NON_COD'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE public.orders ADD CONSTRAINT orders_cod_payment_status_check CHECK (cod_payment_status IS NULL OR cod_payment_status IN ('UNPAID', 'PENDING', 'PAID'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE public.orders ADD CONSTRAINT orders_cod_amount_status_check CHECK (cod_amount_status IS NULL OR cod_amount_status IN ('extracted', 'needs_verification', 'verified', 'corrected'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- one Stripe Checkout Session belongs to at most one order
CREATE UNIQUE INDEX IF NOT EXISTS orders_cod_session_idx ON public.orders (cod_stripe_session_id) WHERE cod_stripe_session_id IS NOT NULL;

-- who changed the COD amount, from what to what, and why (staff only)
CREATE TABLE IF NOT EXISTS public.cod_amount_audit (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  order_id UUID NOT NULL REFERENCES public.orders(id) ON DELETE CASCADE,
  old_amount NUMERIC(12,2),
  old_currency TEXT,
  new_amount NUMERIC(12,2) NOT NULL,
  new_currency TEXT NOT NULL,
  reason TEXT NOT NULL,
  changed_by UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS cod_amount_audit_order_idx ON public.cod_amount_audit (order_id, created_at DESC);

-- only the API (service role) reads or writes the audit history
ALTER TABLE public.cod_amount_audit ENABLE ROW LEVEL SECURITY;
