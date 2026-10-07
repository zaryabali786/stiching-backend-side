-- ==============================================================================
-- Stitching Platform - Full Production Database Schema
-- Matches PROJECT_BRIEF.md specifications
-- Run in Supabase SQL Editor (safe to run multiple times)
-- ==============================================================================

-- 1. EXTENSIONS & SEQUENCES
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

CREATE SEQUENCE IF NOT EXISTS customer_code_seq START WITH 10001;
CREATE SEQUENCE IF NOT EXISTS order_ref_seq START WITH 1001;

-- 2. PROFILES TABLE
CREATE TABLE IF NOT EXISTS public.profiles (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email TEXT UNIQUE NOT NULL,
  full_name TEXT,
  phone TEXT,
  country TEXT,
  city TEXT,
  address TEXT,
  role TEXT DEFAULT 'customer' CHECK (role IN ('customer', 'partner_staff', 'admin')),
  customer_code TEXT UNIQUE,
  avatar_url TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Function to generate customer code STX-10001
CREATE OR REPLACE FUNCTION public.generate_customer_code()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.customer_code IS NULL THEN
    NEW.customer_code := 'STX-' || nextval('customer_code_seq')::TEXT;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_generate_customer_code ON public.profiles;
CREATE TRIGGER trg_generate_customer_code
  BEFORE INSERT ON public.profiles
  FOR EACH ROW
  EXECUTE FUNCTION public.generate_customer_code();

-- Auth trigger to create profile
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO public.profiles (id, email, full_name, role, phone, country, city, address)
  VALUES (
    NEW.id,
    NEW.email,
    COALESCE(NEW.raw_user_meta_data->>'full_name', ''),
    COALESCE(NEW.raw_user_meta_data->>'role', 'customer'),
    COALESCE(NEW.raw_user_meta_data->>'phone', ''),
    COALESCE(NEW.raw_user_meta_data->>'country', ''),
    COALESCE(NEW.raw_user_meta_data->>'city', ''),
    COALESCE(NEW.raw_user_meta_data->>'address', '')
  )
  ON CONFLICT (id) DO UPDATE SET
    email = EXCLUDED.email,
    full_name = EXCLUDED.full_name,
    phone = EXCLUDED.phone,
    updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- 3. SIZE CHARTS TABLE
CREATE TABLE IF NOT EXISTS public.size_charts (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  measurements JSONB NOT NULL DEFAULT '{}'::jsonb,
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 4. ORDERS TABLE
CREATE TABLE IF NOT EXISTS public.orders (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  reference TEXT UNIQUE,
  customer_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
  brand TEXT,
  brand_order_number TEXT,
  tracking_number TEXT,
  status TEXT DEFAULT 'submitted' CHECK (
    status IN (
      'submitted', 'received', 'assigned', 'cutting', 'stitching',
      'qc_passed', 'customer_approval', 'packed', 'invoice_issued',
      'awaiting_payment', 'paid', 'at_admin_warehouse', 'partner_dispatch',
      'shipped', 'delivered', 'cancelled'
    )
  ),
  has_issue BOOLEAN DEFAULT FALSE,
  customer_notes TEXT,
  admin_notes TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Function to generate order reference SA-1001
CREATE OR REPLACE FUNCTION public.generate_order_reference()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.reference IS NULL THEN
    NEW.reference := 'SA-' || nextval('order_ref_seq')::TEXT;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_generate_order_ref ON public.orders;
CREATE TRIGGER trg_generate_order_ref
  BEFORE INSERT ON public.orders
  FOR EACH ROW
  EXECUTE FUNCTION public.generate_order_reference();

-- 5. ORDER UNITS TABLE
CREATE TABLE IF NOT EXISTS public.order_units (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  order_id UUID NOT NULL REFERENCES public.orders(id) ON DELETE CASCADE,
  unit_title TEXT NOT NULL,
  stitching_type TEXT,
  size_chart_id UUID REFERENCES public.size_charts(id) ON DELETE SET NULL,
  product_link TEXT,
  notes TEXT,
  status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'received', 'issue')),
  issue_note TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 6. ORDER EVENTS TABLE (Audit & Tracking Timeline)
CREATE TABLE IF NOT EXISTS public.order_events (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  order_id UUID NOT NULL REFERENCES public.orders(id) ON DELETE CASCADE,
  status TEXT NOT NULL,
  note TEXT,
  created_by UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Trigger to record status changes into order_events automatically
CREATE OR REPLACE FUNCTION public.log_order_status_event()
RETURNS TRIGGER AS $$
BEGIN
  IF (TG_OP = 'INSERT') OR (OLD.status IS DISTINCT FROM NEW.status) THEN
    INSERT INTO public.order_events (order_id, status, note, created_by)
    VALUES (NEW.id, NEW.status, 'Status updated to ' || NEW.status, auth.uid());
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS trg_log_order_status ON public.orders;
CREATE TRIGGER trg_log_order_status
  AFTER INSERT OR UPDATE ON public.orders
  FOR EACH ROW
  EXECUTE FUNCTION public.log_order_status_event();

-- 7. TEAM MEMBERS TABLE (Ishaal Stitching Masters & Tailors)
CREATE TABLE IF NOT EXISTS public.team_members (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('master', 'tailor')),
  master_id UUID REFERENCES public.team_members(id) ON DELETE SET NULL,
  daily_capacity INTEGER NOT NULL DEFAULT 5,
  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 8. MARK_UNIT FUNCTION (Staff only)
-- Sets unit state to 'received' or 'issue'.
-- When all units in the order are received/issue, moves order to 'received'.
-- Sets has_issue = true if any unit has an issue.
CREATE OR REPLACE FUNCTION public.mark_unit(
  p_unit_id UUID,
  p_state TEXT,
  p_note TEXT DEFAULT NULL
)
RETURNS JSONB AS $$
DECLARE
  v_order_id UUID;
  v_caller_role TEXT;
  v_pending_count INT;
  v_issue_count INT;
BEGIN
  -- Verify caller is staff (partner_staff or admin)
  SELECT role INTO v_caller_role FROM public.profiles WHERE id = auth.uid();
  IF v_caller_role NOT IN ('partner_staff', 'admin') THEN
    RAISE EXCEPTION 'Access denied. Only staff can mark units.';
  END IF;

  -- Validate state
  IF p_state NOT IN ('received', 'issue') THEN
    RAISE EXCEPTION 'Invalid state. Must be received or issue.';
  END IF;

  -- Update unit
  UPDATE public.order_units
  SET status = p_state,
      issue_note = CASE WHEN p_state = 'issue' THEN p_note ELSE issue_note END,
      updated_at = NOW()
  WHERE id = p_unit_id
  RETURNING order_id INTO v_order_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Unit not found.';
  END IF;

  -- Check remaining pending units and issue units for this order
  SELECT COUNT(*) FILTER (WHERE status = 'pending'),
         COUNT(*) FILTER (WHERE status = 'issue')
  INTO v_pending_count, v_issue_count
  FROM public.order_units
  WHERE order_id = v_order_id;

  -- If any unit has issue, flag order
  IF v_issue_count > 0 THEN
    UPDATE public.orders SET has_issue = TRUE WHERE id = v_order_id;
  END IF;

  -- If no units are pending, mark order as received
  IF v_pending_count = 0 THEN
    UPDATE public.orders
    SET status = 'received',
        updated_at = NOW()
    WHERE id = v_order_id AND status = 'submitted';
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'unit_id', p_unit_id,
    'order_id', v_order_id,
    'new_status', p_state,
    'pending_remaining', v_pending_count
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 9. ROW LEVEL SECURITY (RLS) POLICIES
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.size_charts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.order_units ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.order_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.team_members ENABLE ROW LEVEL SECURITY;

-- Helper function to check if current user is staff
CREATE OR REPLACE FUNCTION public.is_staff()
RETURNS BOOLEAN AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.profiles
    WHERE id = auth.uid() AND role IN ('partner_staff', 'admin')
  );
$$ LANGUAGE sql SECURITY DEFINER STABLE;

-- Profiles Policies
DROP POLICY IF EXISTS "profiles_select_own" ON public.profiles;
CREATE POLICY "profiles_select_own" ON public.profiles
  FOR SELECT USING (auth.uid() = id OR public.is_staff());

DROP POLICY IF EXISTS "profiles_update_own" ON public.profiles;
CREATE POLICY "profiles_update_own" ON public.profiles
  FOR UPDATE USING (auth.uid() = id)
  WITH CHECK (
    -- User cannot change their own role unless admin
    (role = (SELECT role FROM public.profiles WHERE id = auth.uid()))
    OR (SELECT role FROM public.profiles WHERE id = auth.uid()) = 'admin'
  );

-- Size Charts Policies
DROP POLICY IF EXISTS "size_charts_customer" ON public.size_charts;
CREATE POLICY "size_charts_customer" ON public.size_charts
  FOR ALL USING (auth.uid() = user_id OR public.is_staff());

-- Orders Policies
DROP POLICY IF EXISTS "orders_select" ON public.orders;
CREATE POLICY "orders_select" ON public.orders
  FOR SELECT USING (auth.uid() = customer_id OR public.is_staff());

DROP POLICY IF EXISTS "orders_insert_customer" ON public.orders;
CREATE POLICY "orders_insert_customer" ON public.orders
  FOR INSERT WITH CHECK (auth.uid() = customer_id);

DROP POLICY IF EXISTS "orders_update" ON public.orders;
CREATE POLICY "orders_update" ON public.orders
  FOR UPDATE USING (
    (auth.uid() = customer_id AND status = 'submitted')
    OR public.is_staff()
  );

-- Order Units Policies
DROP POLICY IF EXISTS "order_units_select" ON public.order_units;
CREATE POLICY "order_units_select" ON public.order_units
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM public.orders o
      WHERE o.id = order_units.order_id
        AND (o.customer_id = auth.uid() OR public.is_staff())
    )
  );

DROP POLICY IF EXISTS "order_units_customer_edit" ON public.order_units;
CREATE POLICY "order_units_customer_edit" ON public.order_units
  FOR ALL USING (
    EXISTS (
      SELECT 1 FROM public.orders o
      WHERE o.id = order_units.order_id
        AND o.customer_id = auth.uid()
        AND o.status = 'submitted'
    )
    OR public.is_staff()
  );

-- Order Events Policies
DROP POLICY IF EXISTS "order_events_select" ON public.order_events;
CREATE POLICY "order_events_select" ON public.order_events
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM public.orders o
      WHERE o.id = order_events.order_id
        AND (o.customer_id = auth.uid() OR public.is_staff())
    )
  );

-- Team Members Policies
DROP POLICY IF EXISTS "team_members_staff" ON public.team_members;
CREATE POLICY "team_members_staff" ON public.team_members
  FOR ALL USING (public.is_staff());

-- 10. INDEXES
CREATE INDEX IF NOT EXISTS events_order_idx ON public.order_events (order_id, created_at);
CREATE INDEX IF NOT EXISTS orders_customer_idx ON public.orders (customer_id);
CREATE INDEX IF NOT EXISTS orders_status_idx ON public.orders (status);
CREATE INDEX IF NOT EXISTS units_order_idx ON public.order_units (order_id);
CREATE INDEX IF NOT EXISTS charts_user_idx ON public.size_charts (user_id);
CREATE INDEX IF NOT EXISTS team_master_idx ON public.team_members (master_id);
