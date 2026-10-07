-- ==============================================================================
-- 0002_platform.sql
-- Production board (job cards), price list, shipping rates, invoices, payments,
-- transfers, shipments, notifications, unmatched parcels.
-- Run AFTER 0001_init.sql. Safe to run more than once.
-- ==============================================================================

-- ------------------------------------------------------------------------------
-- 1. PROFILES: staff sign-up requests, active flag, address fields
-- ------------------------------------------------------------------------------
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS requested_role TEXT;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS postal_code TEXT;

ALTER TABLE public.profiles DROP CONSTRAINT IF EXISTS profiles_requested_role_check;
ALTER TABLE public.profiles ADD CONSTRAINT profiles_requested_role_check
  CHECK (requested_role IS NULL OR requested_role IN ('partner_staff', 'admin'));

-- New users ALWAYS start as 'customer'. A role in sign-up metadata is only stored
-- as a request; an admin approves it. This prevents self-promotion at sign-up.
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER AS $$
DECLARE
  v_requested TEXT := NEW.raw_user_meta_data->>'requested_role';
BEGIN
  IF v_requested NOT IN ('partner_staff', 'admin') THEN
    v_requested := NULL;
  END IF;

  INSERT INTO public.profiles (id, email, full_name, role, requested_role, phone, country, city, address)
  VALUES (
    NEW.id,
    NEW.email,
    COALESCE(NEW.raw_user_meta_data->>'full_name', ''),
    'customer',
    v_requested,
    COALESCE(NEW.raw_user_meta_data->>'phone', ''),
    COALESCE(NEW.raw_user_meta_data->>'country', ''),
    COALESCE(NEW.raw_user_meta_data->>'city', ''),
    COALESCE(NEW.raw_user_meta_data->>'address', '')
  )
  ON CONFLICT (id) DO UPDATE SET
    email = EXCLUDED.email,
    updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION public.is_admin()
RETURNS BOOLEAN AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.profiles
    WHERE id = auth.uid() AND role = 'admin'
  );
$$ LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public;

-- Block role changes unless the caller is an admin. The backend uses the
-- service role (auth.uid() IS NULL) and performs its own admin check.
CREATE OR REPLACE FUNCTION public.guard_profile_role()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.role IS DISTINCT FROM OLD.role
     AND auth.uid() IS NOT NULL
     AND NOT public.is_admin() THEN
    RAISE EXCEPTION 'Only an admin can change roles.';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

DROP TRIGGER IF EXISTS trg_guard_profile_role ON public.profiles;
CREATE TRIGGER trg_guard_profile_role
  BEFORE UPDATE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.guard_profile_role();

-- ------------------------------------------------------------------------------
-- 2. ORDERS & UNITS: destination, scheduling, routing, denormalised search fields
-- ------------------------------------------------------------------------------
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS customer_name TEXT;
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS customer_code TEXT;
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS destination_country TEXT;
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS destination_city TEXT;
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS destination_address TEXT;
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS shipping_service TEXT NOT NULL DEFAULT 'express';
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS priority TEXT NOT NULL DEFAULT 'normal';
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS due_date DATE;
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS weight_kg NUMERIC(6, 2);
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS partner_route TEXT;
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS transfer_id UUID;
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS approval_photos JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS change_request TEXT;
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS received_at TIMESTAMPTZ;
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS packed_at TIMESTAMPTZ;
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS paid_at TIMESTAMPTZ;
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS shipped_at TIMESTAMPTZ;
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS delivered_at TIMESTAMPTZ;

ALTER TABLE public.orders DROP CONSTRAINT IF EXISTS orders_priority_check;
ALTER TABLE public.orders ADD CONSTRAINT orders_priority_check CHECK (priority IN ('normal', 'rush'));
ALTER TABLE public.orders DROP CONSTRAINT IF EXISTS orders_shipping_service_check;
ALTER TABLE public.orders ADD CONSTRAINT orders_shipping_service_check CHECK (shipping_service IN ('express', 'standard'));
ALTER TABLE public.orders DROP CONSTRAINT IF EXISTS orders_partner_route_check;
ALTER TABLE public.orders ADD CONSTRAINT orders_partner_route_check
  CHECK (partner_route IS NULL OR partner_route IN ('admin_warehouse', 'direct_dispatch'));

ALTER TABLE public.size_charts ADD COLUMN IF NOT EXISTS person_name TEXT;
ALTER TABLE public.size_charts ADD COLUMN IF NOT EXISTS variation TEXT;
ALTER TABLE public.size_charts ADD COLUMN IF NOT EXISTS fit_feedback TEXT;

ALTER TABLE public.order_units ADD COLUMN IF NOT EXISTS quantity INTEGER NOT NULL DEFAULT 1;
ALTER TABLE public.order_units ADD COLUMN IF NOT EXISTS line_no INTEGER NOT NULL DEFAULT 1;
ALTER TABLE public.order_units ADD COLUMN IF NOT EXISTS issue_type TEXT;
ALTER TABLE public.order_units ADD COLUMN IF NOT EXISTS issue_media JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE public.order_units ADD COLUMN IF NOT EXISTS received_at TIMESTAMPTZ;
-- Design choices per article, e.g. {"neckline":"Round","sleeves":"3/4","trouser":"Straight"}
ALTER TABLE public.order_units ADD COLUMN IF NOT EXISTS design JSONB NOT NULL DEFAULT '{}'::jsonb;
-- Reference photos uploaded by the customer: [{ "url": "...", "type": "image" }]
ALTER TABLE public.order_units ADD COLUMN IF NOT EXISTS reference_images JSONB NOT NULL DEFAULT '[]'::jsonb;

-- ------------------------------------------------------------------------------
-- 3. JOB CARDS (production board: one card per received unit)
-- ------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.job_cards (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  order_id UUID NOT NULL REFERENCES public.orders(id) ON DELETE CASCADE,
  unit_id UUID NOT NULL UNIQUE REFERENCES public.order_units(id) ON DELETE CASCADE,
  stage TEXT NOT NULL DEFAULT 'to_assign'
    CHECK (stage IN ('to_assign', 'cutting', 'stitching', 'qc', 'packed')),
  position DOUBLE PRECISION NOT NULL DEFAULT 0,
  master_id UUID REFERENCES public.team_members(id) ON DELETE SET NULL,
  tailor_id UUID REFERENCES public.team_members(id) ON DELETE SET NULL,
  priority TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('normal', 'rush')),
  due_date DATE,
  -- denormalised for board search
  order_reference TEXT,
  customer_code TEXT,
  unit_title TEXT,
  qc_passed BOOLEAN NOT NULL DEFAULT FALSE,
  qc_notes TEXT,
  qc_checklist JSONB NOT NULL DEFAULT '{}'::jsonb,
  cutting_at TIMESTAMPTZ,
  stitching_at TIMESTAMPTZ,
  qc_at TIMESTAMPTZ,
  packed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE public.job_cards ADD COLUMN IF NOT EXISTS qc_checklist JSONB NOT NULL DEFAULT '{}'::jsonb;

CREATE INDEX IF NOT EXISTS job_cards_stage_pos_idx ON public.job_cards (stage, position);
CREATE INDEX IF NOT EXISTS job_cards_order_idx ON public.job_cards (order_id);
CREATE INDEX IF NOT EXISTS job_cards_master_idx ON public.job_cards (master_id);
CREATE INDEX IF NOT EXISTS job_cards_tailor_idx ON public.job_cards (tailor_id);

CREATE TABLE IF NOT EXISTS public.job_card_comments (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  job_card_id UUID NOT NULL REFERENCES public.job_cards(id) ON DELETE CASCADE,
  author_id UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  author_name TEXT,
  body TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
ALTER TABLE public.job_card_comments ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'comment';
ALTER TABLE public.job_card_comments DROP CONSTRAINT IF EXISTS job_card_comments_kind_check;
ALTER TABLE public.job_card_comments ADD CONSTRAINT job_card_comments_kind_check CHECK (kind IN ('comment', 'activity'));
CREATE INDEX IF NOT EXISTS job_card_comments_card_idx ON public.job_card_comments (job_card_id, created_at);

-- When a unit is marked received, create its job card at the bottom of "To assign".
CREATE OR REPLACE FUNCTION public.create_job_card_for_unit()
RETURNS TRIGGER AS $$
DECLARE
  v_order public.orders%ROWTYPE;
  v_pos DOUBLE PRECISION;
BEGIN
  IF NEW.status = 'received' AND (TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM 'received') THEN
    SELECT * INTO v_order FROM public.orders WHERE id = NEW.order_id;
    SELECT COALESCE(MAX(position), 0) + 1024 INTO v_pos FROM public.job_cards WHERE stage = 'to_assign';
    INSERT INTO public.job_cards (order_id, unit_id, stage, position, priority, due_date, order_reference, customer_code, unit_title)
    VALUES (NEW.order_id, NEW.id, 'to_assign', v_pos, v_order.priority, v_order.due_date,
            v_order.reference, v_order.customer_code, NEW.unit_title)
    ON CONFLICT (unit_id) DO NOTHING;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

DROP TRIGGER IF EXISTS trg_create_job_card ON public.order_units;
CREATE TRIGGER trg_create_job_card
  AFTER INSERT OR UPDATE OF status ON public.order_units
  FOR EACH ROW EXECUTE FUNCTION public.create_job_card_for_unit();

-- ------------------------------------------------------------------------------
-- 4. PRICE LIST & SHIPPING RATES
-- ------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.price_items (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  category TEXT NOT NULL DEFAULT 'stitching'
    CHECK (category IN ('stitching', 'accessory', 'accessory_stitching', 'finishing', 'other')),
  name TEXT NOT NULL,
  unit TEXT NOT NULL DEFAULT 'per article',
  partner_cost NUMERIC(12, 2) NOT NULL DEFAULT 0,
  customer_price NUMERIC(12, 2) NOT NULL DEFAULT 0,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS price_items_category_idx ON public.price_items (category, name);

CREATE TABLE IF NOT EXISTS public.shipping_rates (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  courier TEXT NOT NULL,
  zone TEXT NOT NULL,
  countries TEXT[] NOT NULL DEFAULT '{}',
  service TEXT NOT NULL DEFAULT 'express' CHECK (service IN ('express', 'standard')),
  transit_time TEXT,
  max_weight_kg NUMERIC(6, 2) NOT NULL DEFAULT 1.5,
  base_rate NUMERIC(12, 2) NOT NULL DEFAULT 0,
  per_extra_kg NUMERIC(12, 2) NOT NULL DEFAULT 0,
  ddp_available BOOLEAN NOT NULL DEFAULT FALSE,
  ddp_fee NUMERIC(12, 2) NOT NULL DEFAULT 0,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ------------------------------------------------------------------------------
-- 5. INVOICES, INVOICE LINES, PAYMENTS
-- ------------------------------------------------------------------------------
CREATE SEQUENCE IF NOT EXISTS invoice_number_seq START WITH 1001;

CREATE TABLE IF NOT EXISTS public.invoices (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  order_id UUID NOT NULL UNIQUE REFERENCES public.orders(id) ON DELETE CASCADE,
  number TEXT UNIQUE,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'issued', 'paid', 'void')),
  currency TEXT NOT NULL DEFAULT 'PKR',
  fx_rate NUMERIC(12, 4) NOT NULL DEFAULT 1,
  subtotal_pkr NUMERIC(12, 2) NOT NULL DEFAULT 0,
  discount_pkr NUMERIC(12, 2) NOT NULL DEFAULT 0,
  total_pkr NUMERIC(12, 2) NOT NULL DEFAULT 0,
  total_foreign NUMERIC(12, 2) NOT NULL DEFAULT 0,
  partner_total_pkr NUMERIC(12, 2) NOT NULL DEFAULT 0,
  notes TEXT,
  issued_at TIMESTAMPTZ,
  paid_at TIMESTAMPTZ,
  created_by UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE OR REPLACE FUNCTION public.generate_invoice_number()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.number IS NULL THEN
    NEW.number := 'INV-' || nextval('invoice_number_seq')::TEXT;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_generate_invoice_number ON public.invoices;
CREATE TRIGGER trg_generate_invoice_number
  BEFORE INSERT ON public.invoices
  FOR EACH ROW EXECUTE FUNCTION public.generate_invoice_number();

CREATE TABLE IF NOT EXISTS public.invoice_lines (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  invoice_id UUID NOT NULL REFERENCES public.invoices(id) ON DELETE CASCADE,
  kind TEXT NOT NULL DEFAULT 'stitching'
    CHECK (kind IN ('stitching', 'accessory', 'accessory_stitching', 'shipping', 'duties', 'discount', 'other')),
  label TEXT NOT NULL,
  description TEXT,
  unit_id UUID REFERENCES public.order_units(id) ON DELETE SET NULL,
  price_item_id UUID REFERENCES public.price_items(id) ON DELETE SET NULL,
  quantity NUMERIC(10, 2) NOT NULL DEFAULT 1,
  customer_amount NUMERIC(12, 2) NOT NULL DEFAULT 0,
  partner_amount NUMERIC(12, 2) NOT NULL DEFAULT 0,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS invoice_lines_invoice_idx ON public.invoice_lines (invoice_id, sort_order);

CREATE TABLE IF NOT EXISTS public.payments (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  invoice_id UUID NOT NULL REFERENCES public.invoices(id) ON DELETE CASCADE,
  order_id UUID NOT NULL REFERENCES public.orders(id) ON DELETE CASCADE,
  amount_pkr NUMERIC(12, 2) NOT NULL,
  amount_foreign NUMERIC(12, 2),
  currency TEXT NOT NULL DEFAULT 'PKR',
  method TEXT NOT NULL DEFAULT 'card' CHECK (method IN ('card', 'bank_transfer', 'manual')),
  provider_ref TEXT,
  status TEXT NOT NULL DEFAULT 'succeeded' CHECK (status IN ('pending', 'succeeded', 'failed')),
  created_by UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS payments_order_idx ON public.payments (order_id);

-- ------------------------------------------------------------------------------
-- 6. TRANSFERS (partner warehouse -> admin warehouse) & SHIPMENTS
-- ------------------------------------------------------------------------------
CREATE SEQUENCE IF NOT EXISTS transfer_code_seq START WITH 101;

CREATE TABLE IF NOT EXISTS public.transfers (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  code TEXT UNIQUE,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'in_transit', 'received')),
  notes TEXT,
  created_by UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  dispatched_at TIMESTAMPTZ,
  received_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE OR REPLACE FUNCTION public.generate_transfer_code()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.code IS NULL THEN
    NEW.code := 'TR-' || nextval('transfer_code_seq')::TEXT;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_generate_transfer_code ON public.transfers;
CREATE TRIGGER trg_generate_transfer_code
  BEFORE INSERT ON public.transfers
  FOR EACH ROW EXECUTE FUNCTION public.generate_transfer_code();

ALTER TABLE public.orders DROP CONSTRAINT IF EXISTS orders_transfer_id_fkey;
ALTER TABLE public.orders ADD CONSTRAINT orders_transfer_id_fkey
  FOREIGN KEY (transfer_id) REFERENCES public.transfers(id) ON DELETE SET NULL;

CREATE TABLE IF NOT EXISTS public.shipments (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  order_id UUID NOT NULL UNIQUE REFERENCES public.orders(id) ON DELETE CASCADE,
  shipped_from TEXT NOT NULL DEFAULT 'admin_warehouse' CHECK (shipped_from IN ('admin_warehouse', 'partner')),
  status TEXT NOT NULL DEFAULT 'needs_label'
    CHECK (status IN ('needs_label', 'labelled', 'handed_to_courier', 'delivered')),
  shipping_rate_id UUID REFERENCES public.shipping_rates(id) ON DELETE SET NULL,
  courier TEXT,
  service TEXT,
  tracking_number TEXT,
  rate_pkr NUMERIC(12, 2),
  weight_kg NUMERIC(6, 2),
  dimensions TEXT,
  label_printed_at TIMESTAMPTZ,
  handed_at TIMESTAMPTZ,
  delivered_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS shipments_status_idx ON public.shipments (status);

-- ------------------------------------------------------------------------------
-- 7. NOTIFICATIONS (one row per recipient)
-- ------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.notifications (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  type TEXT NOT NULL DEFAULT 'update',
  title TEXT NOT NULL,
  body TEXT,
  link TEXT,
  order_id UUID REFERENCES public.orders(id) ON DELETE CASCADE,
  read_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS notifications_user_idx ON public.notifications (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS notifications_unread_idx ON public.notifications (user_id) WHERE read_at IS NULL;

-- ------------------------------------------------------------------------------
-- 8. UNMATCHED PARCELS (arrived without a matching customer code)
-- ------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.unmatched_parcels (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  label_text TEXT,
  brand TEXT,
  tracking_number TEXT,
  notes TEXT,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'matched', 'returned')),
  matched_order_id UUID REFERENCES public.orders(id) ON DELETE SET NULL,
  created_by UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ------------------------------------------------------------------------------
-- 9. STORAGE BUCKET for issue evidence & QC photos
-- ------------------------------------------------------------------------------
INSERT INTO storage.buckets (id, name, public)
VALUES ('evidence', 'evidence', TRUE)
ON CONFLICT (id) DO NOTHING;

-- ------------------------------------------------------------------------------
-- 10. ROW LEVEL SECURITY
-- ------------------------------------------------------------------------------
ALTER TABLE public.job_cards ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.job_card_comments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.price_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.shipping_rates ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.invoices ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.invoice_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.transfers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.shipments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.unmatched_parcels ENABLE ROW LEVEL SECURITY;

-- Staff-only tables
DROP POLICY IF EXISTS "job_cards_staff" ON public.job_cards;
CREATE POLICY "job_cards_staff" ON public.job_cards FOR ALL USING (public.is_staff()) WITH CHECK (public.is_staff());

DROP POLICY IF EXISTS "job_card_comments_staff" ON public.job_card_comments;
CREATE POLICY "job_card_comments_staff" ON public.job_card_comments FOR ALL USING (public.is_staff()) WITH CHECK (public.is_staff());

DROP POLICY IF EXISTS "transfers_staff" ON public.transfers;
CREATE POLICY "transfers_staff" ON public.transfers FOR ALL USING (public.is_staff()) WITH CHECK (public.is_staff());

DROP POLICY IF EXISTS "unmatched_parcels_staff" ON public.unmatched_parcels;
CREATE POLICY "unmatched_parcels_staff" ON public.unmatched_parcels FOR ALL USING (public.is_staff()) WITH CHECK (public.is_staff());

-- Price list & shipping rates: everyone signed in can read, only admin can write
DROP POLICY IF EXISTS "price_items_read" ON public.price_items;
CREATE POLICY "price_items_read" ON public.price_items FOR SELECT USING (auth.uid() IS NOT NULL);
DROP POLICY IF EXISTS "price_items_admin_write" ON public.price_items;
CREATE POLICY "price_items_admin_write" ON public.price_items FOR ALL USING (public.is_admin()) WITH CHECK (public.is_admin());

DROP POLICY IF EXISTS "shipping_rates_read" ON public.shipping_rates;
CREATE POLICY "shipping_rates_read" ON public.shipping_rates FOR SELECT USING (auth.uid() IS NOT NULL);
DROP POLICY IF EXISTS "shipping_rates_admin_write" ON public.shipping_rates;
CREATE POLICY "shipping_rates_admin_write" ON public.shipping_rates FOR ALL USING (public.is_admin()) WITH CHECK (public.is_admin());

-- Invoices: customer reads own issued/paid invoices, admin manages, partner staff reads
DROP POLICY IF EXISTS "invoices_select" ON public.invoices;
CREATE POLICY "invoices_select" ON public.invoices FOR SELECT USING (
  public.is_staff()
  OR (status IN ('issued', 'paid') AND EXISTS (
    SELECT 1 FROM public.orders o WHERE o.id = invoices.order_id AND o.customer_id = auth.uid()
  ))
);
DROP POLICY IF EXISTS "invoices_admin_write" ON public.invoices;
CREATE POLICY "invoices_admin_write" ON public.invoices FOR ALL USING (public.is_admin()) WITH CHECK (public.is_admin());

DROP POLICY IF EXISTS "invoice_lines_select" ON public.invoice_lines;
CREATE POLICY "invoice_lines_select" ON public.invoice_lines FOR SELECT USING (
  public.is_staff()
  OR EXISTS (
    SELECT 1 FROM public.invoices i JOIN public.orders o ON o.id = i.order_id
    WHERE i.id = invoice_lines.invoice_id AND i.status IN ('issued', 'paid') AND o.customer_id = auth.uid()
  )
);
DROP POLICY IF EXISTS "invoice_lines_admin_write" ON public.invoice_lines;
CREATE POLICY "invoice_lines_admin_write" ON public.invoice_lines FOR ALL USING (public.is_admin()) WITH CHECK (public.is_admin());

DROP POLICY IF EXISTS "payments_select" ON public.payments;
CREATE POLICY "payments_select" ON public.payments FOR SELECT USING (
  public.is_staff()
  OR EXISTS (SELECT 1 FROM public.orders o WHERE o.id = payments.order_id AND o.customer_id = auth.uid())
);
DROP POLICY IF EXISTS "payments_admin_write" ON public.payments;
CREATE POLICY "payments_admin_write" ON public.payments FOR ALL USING (public.is_admin()) WITH CHECK (public.is_admin());

DROP POLICY IF EXISTS "shipments_select" ON public.shipments;
CREATE POLICY "shipments_select" ON public.shipments FOR SELECT USING (
  public.is_staff()
  OR EXISTS (SELECT 1 FROM public.orders o WHERE o.id = shipments.order_id AND o.customer_id = auth.uid())
);
DROP POLICY IF EXISTS "shipments_staff_write" ON public.shipments;
CREATE POLICY "shipments_staff_write" ON public.shipments FOR ALL USING (public.is_staff()) WITH CHECK (public.is_staff());

-- Notifications: each user sees and marks only their own
DROP POLICY IF EXISTS "notifications_own_select" ON public.notifications;
CREATE POLICY "notifications_own_select" ON public.notifications FOR SELECT USING (auth.uid() = user_id);
DROP POLICY IF EXISTS "notifications_own_update" ON public.notifications;
CREATE POLICY "notifications_own_update" ON public.notifications FOR UPDATE USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

-- ------------------------------------------------------------------------------
-- 11. EXTRA INDEXES for search, filters and pagination
-- ------------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS orders_created_idx ON public.orders (created_at DESC);
CREATE INDEX IF NOT EXISTS orders_reference_idx ON public.orders (reference);
CREATE INDEX IF NOT EXISTS orders_customer_code_idx ON public.orders (customer_code);
CREATE INDEX IF NOT EXISTS profiles_role_idx ON public.profiles (role);
CREATE INDEX IF NOT EXISTS profiles_customer_code_idx ON public.profiles (customer_code);

-- Last line marker: if you can see this in the SQL editor, the whole file was pasted.
CREATE INDEX IF NOT EXISTS job_cards_due_idx ON public.job_cards (due_date);
