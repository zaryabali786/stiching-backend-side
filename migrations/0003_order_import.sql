-- ==============================================================================
-- 0003_order_import.sql
-- Four ways to create an order: manual, uploaded brand invoice, product links,
-- forwarded brand email. Imports are read into a draft (order_imports.extracted)
-- that prefills the order form; the customer reviews it before submitting.
-- Safe to run more than once.
-- ==============================================================================

-- ------------------------------------------------------------------------------
-- 1. Orders / articles: where the order came from + brand prices
-- ------------------------------------------------------------------------------
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS import_source TEXT NOT NULL DEFAULT 'manual';
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS import_id UUID;
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS brand_order_total NUMERIC(12,2);
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS brand_order_currency TEXT;
-- { path, name, type } in the private "documents" bucket (served via signed URLs)
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS brand_invoice JSONB;

DO $$ BEGIN
  ALTER TABLE public.orders ADD CONSTRAINT orders_import_source_check
    CHECK (import_source IN ('manual', 'invoice', 'link', 'email'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE public.order_units ADD COLUMN IF NOT EXISTS unit_price NUMERIC(12,2);
ALTER TABLE public.order_units ADD COLUMN IF NOT EXISTS currency TEXT;
ALTER TABLE public.order_units ADD COLUMN IF NOT EXISTS product_image_url TEXT;
ALTER TABLE public.order_units ADD COLUMN IF NOT EXISTS brand_sku TEXT;

-- ------------------------------------------------------------------------------
-- 2. Per-customer secret for the forwarding address  orders+<token>@<domain>
--    (random, not the guessable STX code, so nobody can push mail into another account)
-- ------------------------------------------------------------------------------
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS inbound_email_token TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS profiles_inbound_email_token_idx
  ON public.profiles (inbound_email_token) WHERE inbound_email_token IS NOT NULL;

-- ------------------------------------------------------------------------------
-- 3. Import drafts
-- ------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.order_imports (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  customer_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  source TEXT NOT NULL CHECK (source IN ('invoice', 'link', 'email')),
  status TEXT NOT NULL DEFAULT 'processing' CHECK (status IN ('processing', 'ready', 'failed', 'used')),
  -- invoice: { path, name, type } in the private "documents" bucket
  file JSONB,
  links TEXT[],
  email_from TEXT,
  email_subject TEXT,
  email_received_at TIMESTAMPTZ,
  -- email attachments kept for staff: [{ path, name, type }]
  attachments JSONB NOT NULL DEFAULT '[]'::jsonb,
  -- { brand, order_number, currency, total, items: [{ title, quantity, unit_price, url, image_url, sku, notes }] }
  extracted JSONB,
  -- 'ai' | 'page' | 'basic' — how the details were read
  extracted_by TEXT,
  error TEXT,
  order_id UUID REFERENCES public.orders(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS order_imports_customer_idx ON public.order_imports (customer_id, created_at DESC);
CREATE INDEX IF NOT EXISTS order_imports_open_idx ON public.order_imports (customer_id, source) WHERE status <> 'used';

ALTER TABLE public.order_imports ENABLE ROW LEVEL SECURITY;

-- Customers read their own drafts; all writes go through the backend (service role)
DROP POLICY IF EXISTS "order_imports_own_select" ON public.order_imports;
CREATE POLICY "order_imports_own_select" ON public.order_imports FOR SELECT USING (auth.uid() = customer_id);
DROP POLICY IF EXISTS "order_imports_admin" ON public.order_imports;
CREATE POLICY "order_imports_admin" ON public.order_imports FOR ALL USING (public.is_admin()) WITH CHECK (public.is_admin());

-- ------------------------------------------------------------------------------
-- 4. Private bucket for brand invoices and forwarded-email attachments
-- ------------------------------------------------------------------------------
INSERT INTO storage.buckets (id, name, public)
VALUES ('documents', 'documents', FALSE)
ON CONFLICT (id) DO UPDATE SET public = FALSE;

-- Last line marker: if you can see this in the SQL editor, the whole file was pasted.
CREATE INDEX IF NOT EXISTS orders_import_source_idx ON public.orders (import_source);
