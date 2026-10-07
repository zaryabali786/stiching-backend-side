-- ==============================================================================
-- 0005_partners_rbac.sql
-- 1. Order status can only move forward once an order is paid (shipped/delivered can never
--    fall back to "Packed"), enforced by a trigger as well as by the API.
-- 2. Hierarchy: Admin -> Partners -> the partner's own users (master tailor, tailor, staff, ...).
--    Each partner has its own login, a module/permission ceiling set by the admin, and its own
--    orders, production board, team, transfers and parcels. Partner users get permissions from
--    their partner (never more than the partner has).
-- 3. Existing single-partner data is moved into a default partner, nothing is deleted.
-- Safe to run more than once.
-- ==============================================================================

-- ------------------------------------------------------------------------------
-- 1. ORDER STATUS GUARD
-- ------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.order_status_rank(p_status TEXT)
RETURNS INTEGER AS $$
  SELECT CASE p_status
    WHEN 'submitted' THEN 0 WHEN 'received' THEN 1 WHEN 'assigned' THEN 2 WHEN 'cutting' THEN 3
    WHEN 'stitching' THEN 4 WHEN 'qc_passed' THEN 5 WHEN 'customer_approval' THEN 6 WHEN 'packed' THEN 7
    WHEN 'invoice_issued' THEN 8 WHEN 'awaiting_payment' THEN 9 WHEN 'paid' THEN 10
    WHEN 'at_admin_warehouse' THEN 11 WHEN 'partner_dispatch' THEN 11
    WHEN 'shipped' THEN 12 WHEN 'delivered' THEN 13
    ELSE NULL END;
$$ LANGUAGE sql IMMUTABLE;

CREATE OR REPLACE FUNCTION public.guard_order_status()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.status IS NOT DISTINCT FROM OLD.status THEN
    RETURN NEW;
  END IF;
  IF OLD.status IN ('delivered', 'cancelled') THEN
    RAISE EXCEPTION 'Order % is already %, its status cannot change.', OLD.reference, OLD.status USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.status = 'cancelled' THEN
    IF public.order_status_rank(OLD.status) >= 12 THEN
      RAISE EXCEPTION 'Order % is already %, it cannot be cancelled.', OLD.reference, OLD.status USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  -- from "paid" onwards the status only moves forward
  IF public.order_status_rank(OLD.status) >= 10 AND public.order_status_rank(NEW.status) < public.order_status_rank(OLD.status) THEN
    RAISE EXCEPTION 'Order % is already %, its status cannot go back to %.', OLD.reference, OLD.status, NEW.status USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_guard_order_status ON public.orders;
CREATE TRIGGER trg_guard_order_status
  BEFORE UPDATE OF status ON public.orders
  FOR EACH ROW EXECUTE FUNCTION public.guard_order_status();

-- Articles of orders that were shipped / delivered before this migration end their own timeline in
-- "Shipped" / "Delivered" instead of "Packed".
INSERT INTO public.order_unit_events (order_id, unit_id, status, note, created_at)
SELECT o.id, u.id, 'shipped', NULL, COALESCE(o.shipped_at, o.updated_at)
FROM public.orders o JOIN public.order_units u ON u.order_id = o.id
WHERE o.status IN ('shipped', 'delivered')
  AND NOT EXISTS (SELECT 1 FROM public.order_unit_events e WHERE e.unit_id = u.id AND e.status = 'shipped');
INSERT INTO public.order_unit_events (order_id, unit_id, status, note, created_at)
SELECT o.id, u.id, 'delivered', NULL, COALESCE(o.delivered_at, o.updated_at)
FROM public.orders o JOIN public.order_units u ON u.order_id = o.id
WHERE o.status = 'delivered'
  AND NOT EXISTS (SELECT 1 FROM public.order_unit_events e WHERE e.unit_id = u.id AND e.status = 'delivered');

-- ------------------------------------------------------------------------------
-- 2. PARTNERS
-- ------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.partners (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name TEXT NOT NULL CHECK (char_length(btrim(name)) BETWEEN 2 AND 100),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  -- the modules/actions the admin lets this partner use, e.g. {production.view,production.update};
  -- the partner's users can only ever get a subset of these
  permissions TEXT[] NOT NULL DEFAULT '{}',
  -- receives new customer orders until the admin assigns an order to another partner
  is_default BOOLEAN NOT NULL DEFAULT FALSE,
  created_by UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS partners_name_lower_idx ON public.partners (lower(btrim(name)));
CREATE UNIQUE INDEX IF NOT EXISTS partners_one_default_idx ON public.partners (is_default) WHERE is_default;

DROP TRIGGER IF EXISTS trg_partners_updated ON public.partners;
CREATE TRIGGER trg_partners_updated BEFORE UPDATE ON public.partners FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- ------------------------------------------------------------------------------
-- 3. PROFILES: which partner, owner or member, and the permissions granted
-- ------------------------------------------------------------------------------
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS partner_id UUID REFERENCES public.partners(id) ON DELETE RESTRICT;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS partner_role TEXT;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS permissions TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS job_title TEXT;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS created_by UUID REFERENCES public.profiles(id) ON DELETE SET NULL;
-- set when an admin / partner created the login with a temporary password: the user must choose their own on first sign-in
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS must_change_password BOOLEAN NOT NULL DEFAULT FALSE;

DO $$ BEGIN
  ALTER TABLE public.profiles ADD CONSTRAINT profiles_partner_role_check
    CHECK (partner_role IS NULL OR partner_role IN ('owner', 'member'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS profiles_partner_idx ON public.profiles (partner_id) WHERE partner_id IS NOT NULL;
-- one owner login per partner
CREATE UNIQUE INDEX IF NOT EXISTS profiles_one_owner_per_partner_idx ON public.profiles (partner_id) WHERE partner_role = 'owner';

-- ------------------------------------------------------------------------------
-- 4. TENANT OWNERSHIP of partner data
-- ------------------------------------------------------------------------------
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS partner_id UUID REFERENCES public.partners(id) ON DELETE RESTRICT;
ALTER TABLE public.job_cards ADD COLUMN IF NOT EXISTS partner_id UUID REFERENCES public.partners(id) ON DELETE RESTRICT;
ALTER TABLE public.team_members ADD COLUMN IF NOT EXISTS partner_id UUID REFERENCES public.partners(id) ON DELETE RESTRICT;
ALTER TABLE public.transfers ADD COLUMN IF NOT EXISTS partner_id UUID REFERENCES public.partners(id) ON DELETE RESTRICT;
ALTER TABLE public.unmatched_parcels ADD COLUMN IF NOT EXISTS partner_id UUID REFERENCES public.partners(id) ON DELETE RESTRICT;
CREATE INDEX IF NOT EXISTS orders_partner_idx ON public.orders (partner_id, status);
CREATE INDEX IF NOT EXISTS job_cards_partner_idx ON public.job_cards (partner_id, stage);
CREATE INDEX IF NOT EXISTS team_members_partner_idx ON public.team_members (partner_id);
CREATE INDEX IF NOT EXISTS transfers_partner_idx ON public.transfers (partner_id, status);
CREATE INDEX IF NOT EXISTS unmatched_parcels_partner_idx ON public.unmatched_parcels (partner_id);

-- ------------------------------------------------------------------------------
-- 5. BACKFILL: the existing single partner becomes the default partner; its staff join it
--    (earliest account is the owner, everybody keeps full access so nothing stops working)
-- ------------------------------------------------------------------------------
DO $$
DECLARE
  v_partner UUID;
  v_owner UUID;
  v_all TEXT[] := ARRAY[
    'overview.view', 'receiving.view', 'receiving.update', 'production.view', 'production.update',
    'quality.view', 'quality.update', 'warehouse.view', 'warehouse.update', 'teams.view', 'teams.update',
    'earnings.view', 'messages.view', 'messages.update', 'catalogue.view', 'catalogue.update',
    'users.view', 'users.create', 'users.update'
  ];
BEGIN
  SELECT id INTO v_partner FROM public.partners WHERE is_default LIMIT 1;
  IF v_partner IS NULL AND NOT EXISTS (SELECT 1 FROM public.partners) THEN
    INSERT INTO public.partners (name, permissions, is_default) VALUES ('Ishaal Stitching', v_all, TRUE) RETURNING id INTO v_partner;
  END IF;
  IF v_partner IS NULL THEN
    SELECT id INTO v_partner FROM public.partners ORDER BY created_at LIMIT 1;
  END IF;

  UPDATE public.profiles
     SET partner_id = v_partner, partner_role = 'member', permissions = v_all
   WHERE role = 'partner_staff' AND partner_id IS NULL;

  IF NOT EXISTS (SELECT 1 FROM public.profiles WHERE partner_id = v_partner AND partner_role = 'owner') THEN
    SELECT id INTO v_owner FROM public.profiles WHERE partner_id = v_partner AND role = 'partner_staff' ORDER BY created_at LIMIT 1;
    IF v_owner IS NOT NULL THEN
      UPDATE public.profiles SET partner_role = 'owner' WHERE id = v_owner;
    END IF;
  END IF;

  UPDATE public.orders SET partner_id = v_partner WHERE partner_id IS NULL;
  UPDATE public.team_members SET partner_id = v_partner WHERE partner_id IS NULL;
  UPDATE public.transfers SET partner_id = v_partner WHERE partner_id IS NULL;
  UPDATE public.unmatched_parcels SET partner_id = v_partner WHERE partner_id IS NULL;
  UPDATE public.job_cards c SET partner_id = o.partner_id FROM public.orders o WHERE c.order_id = o.id AND c.partner_id IS NULL;
END $$;

-- A partner login always belongs to a partner
DO $$ BEGIN
  ALTER TABLE public.profiles ADD CONSTRAINT profiles_partner_staff_has_partner_check
    CHECK (role <> 'partner_staff' OR partner_id IS NOT NULL);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- New customer orders go to the default partner until the admin assigns them elsewhere
CREATE OR REPLACE FUNCTION public.assign_default_partner()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.partner_id IS NULL THEN
    SELECT id INTO NEW.partner_id FROM public.partners WHERE is_default AND status = 'active' LIMIT 1;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_orders_default_partner ON public.orders;
CREATE TRIGGER trg_orders_default_partner BEFORE INSERT ON public.orders
  FOR EACH ROW EXECUTE FUNCTION public.assign_default_partner();

-- Job cards belong to the partner of their order
CREATE OR REPLACE FUNCTION public.create_job_card_for_unit()
RETURNS TRIGGER AS $$
DECLARE
  v_order public.orders%ROWTYPE;
  v_pos DOUBLE PRECISION;
BEGIN
  IF NEW.status = 'received' AND (TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM 'received') THEN
    SELECT * INTO v_order FROM public.orders WHERE id = NEW.order_id;
    SELECT COALESCE(MAX(position), 0) + 1024 INTO v_pos FROM public.job_cards WHERE stage = 'to_assign' AND partner_id IS NOT DISTINCT FROM v_order.partner_id;
    INSERT INTO public.job_cards (order_id, unit_id, stage, position, priority, due_date, order_reference, customer_code, unit_title, partner_id)
    VALUES (NEW.order_id, NEW.id, 'to_assign', v_pos, v_order.priority, v_order.due_date,
            v_order.reference, v_order.customer_code, NEW.unit_title, v_order.partner_id)
    ON CONFLICT (unit_id) DO NOTHING;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- When the admin moves an order to another partner its tickets follow
CREATE OR REPLACE FUNCTION public.sync_job_card_partner()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.partner_id IS DISTINCT FROM OLD.partner_id THEN
    UPDATE public.job_cards SET partner_id = NEW.partner_id WHERE order_id = NEW.id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

DROP TRIGGER IF EXISTS trg_orders_sync_card_partner ON public.orders;
CREATE TRIGGER trg_orders_sync_card_partner AFTER UPDATE OF partner_id ON public.orders
  FOR EACH ROW EXECUTE FUNCTION public.sync_job_card_partner();

-- ------------------------------------------------------------------------------
-- 6. PRIVILEGE GUARD: nobody can grant themselves access by editing their own profile row
--    (the API runs with the service role, auth.uid() is NULL there and does its own checks)
-- ------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.guard_profile_privileges()
RETURNS TRIGGER AS $$
BEGIN
  IF auth.uid() IS NOT NULL AND NOT public.is_admin() AND (
       NEW.partner_id IS DISTINCT FROM OLD.partner_id
    OR NEW.partner_role IS DISTINCT FROM OLD.partner_role
    OR NEW.permissions IS DISTINCT FROM OLD.permissions
    OR NEW.is_active IS DISTINCT FROM OLD.is_active
    OR NEW.requested_role IS DISTINCT FROM OLD.requested_role
    OR NEW.must_change_password IS DISTINCT FROM OLD.must_change_password
  ) THEN
    RAISE EXCEPTION 'Only an admin can change access settings.' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

DROP TRIGGER IF EXISTS trg_guard_profile_privileges ON public.profiles;
CREATE TRIGGER trg_guard_profile_privileges BEFORE UPDATE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.guard_profile_privileges();

-- ------------------------------------------------------------------------------
-- 7. ROW LEVEL SECURITY: partner staff only reach rows of their own partner
--    (the API uses the service role and scopes every query itself; this protects direct database access)
-- ------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.is_staff()
RETURNS BOOLEAN AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.profiles
    WHERE id = auth.uid() AND is_active AND role IN ('partner_staff', 'admin')
  );
$$ LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public;

CREATE OR REPLACE FUNCTION public.my_partner_id()
RETURNS UUID AS $$
  SELECT partner_id FROM public.profiles WHERE id = auth.uid() AND is_active AND role = 'partner_staff';
$$ LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public;

-- true for an admin, or for a partner user looking at a row of their own partner
CREATE OR REPLACE FUNCTION public.staff_can_access_partner(p_partner UUID)
RETURNS BOOLEAN AS $$
  SELECT public.is_admin() OR (p_partner IS NOT NULL AND p_partner = public.my_partner_id());
$$ LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public;

CREATE OR REPLACE FUNCTION public.staff_can_see_order(p_order UUID)
RETURNS BOOLEAN AS $$
  SELECT EXISTS (SELECT 1 FROM public.orders o WHERE o.id = p_order AND public.staff_can_access_partner(o.partner_id));
$$ LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public;

ALTER TABLE public.partners ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "partners_admin_all" ON public.partners;
CREATE POLICY "partners_admin_all" ON public.partners FOR ALL USING (public.is_admin()) WITH CHECK (public.is_admin());
DROP POLICY IF EXISTS "partners_own_select" ON public.partners;
CREATE POLICY "partners_own_select" ON public.partners FOR SELECT USING (id = public.my_partner_id());

DROP POLICY IF EXISTS "profiles_select_own" ON public.profiles;
CREATE POLICY "profiles_select_own" ON public.profiles
  FOR SELECT USING (auth.uid() = id OR public.is_admin() OR (partner_id IS NOT NULL AND partner_id = public.my_partner_id()));

DROP POLICY IF EXISTS "size_charts_customer" ON public.size_charts;
CREATE POLICY "size_charts_customer" ON public.size_charts
  FOR ALL USING (auth.uid() = user_id OR public.is_admin());

DROP POLICY IF EXISTS "orders_select" ON public.orders;
CREATE POLICY "orders_select" ON public.orders
  FOR SELECT USING (auth.uid() = customer_id OR public.staff_can_access_partner(partner_id));

DROP POLICY IF EXISTS "orders_update" ON public.orders;
CREATE POLICY "orders_update" ON public.orders
  FOR UPDATE USING (
    (auth.uid() = customer_id AND status = 'submitted')
    OR public.staff_can_access_partner(partner_id)
  );

DROP POLICY IF EXISTS "order_units_select" ON public.order_units;
CREATE POLICY "order_units_select" ON public.order_units
  FOR SELECT USING (
    EXISTS (SELECT 1 FROM public.orders o WHERE o.id = order_units.order_id AND o.customer_id = auth.uid())
    OR public.staff_can_see_order(order_id)
  );

DROP POLICY IF EXISTS "order_units_customer_edit" ON public.order_units;
CREATE POLICY "order_units_customer_edit" ON public.order_units
  FOR ALL USING (
    EXISTS (SELECT 1 FROM public.orders o WHERE o.id = order_units.order_id AND o.customer_id = auth.uid() AND o.status = 'submitted')
    OR public.staff_can_see_order(order_id)
  );

DROP POLICY IF EXISTS "order_events_select" ON public.order_events;
CREATE POLICY "order_events_select" ON public.order_events
  FOR SELECT USING (
    EXISTS (SELECT 1 FROM public.orders o WHERE o.id = order_events.order_id AND o.customer_id = auth.uid())
    OR public.staff_can_see_order(order_id)
  );

DROP POLICY IF EXISTS "team_members_staff" ON public.team_members;
CREATE POLICY "team_members_staff" ON public.team_members FOR ALL USING (public.staff_can_access_partner(partner_id)) WITH CHECK (public.staff_can_access_partner(partner_id));

DROP POLICY IF EXISTS "job_cards_staff" ON public.job_cards;
CREATE POLICY "job_cards_staff" ON public.job_cards FOR ALL USING (public.staff_can_access_partner(partner_id)) WITH CHECK (public.staff_can_access_partner(partner_id));

DROP POLICY IF EXISTS "job_card_comments_staff" ON public.job_card_comments;
CREATE POLICY "job_card_comments_staff" ON public.job_card_comments FOR ALL
  USING (EXISTS (SELECT 1 FROM public.job_cards c WHERE c.id = job_card_comments.job_card_id AND public.staff_can_access_partner(c.partner_id)))
  WITH CHECK (EXISTS (SELECT 1 FROM public.job_cards c WHERE c.id = job_card_comments.job_card_id AND public.staff_can_access_partner(c.partner_id)));

DROP POLICY IF EXISTS "transfers_staff" ON public.transfers;
CREATE POLICY "transfers_staff" ON public.transfers FOR ALL USING (public.staff_can_access_partner(partner_id)) WITH CHECK (public.staff_can_access_partner(partner_id));

DROP POLICY IF EXISTS "unmatched_parcels_staff" ON public.unmatched_parcels;
CREATE POLICY "unmatched_parcels_staff" ON public.unmatched_parcels FOR ALL USING (public.staff_can_access_partner(partner_id)) WITH CHECK (public.staff_can_access_partner(partner_id));

DROP POLICY IF EXISTS "invoices_select" ON public.invoices;
CREATE POLICY "invoices_select" ON public.invoices FOR SELECT USING (
  public.staff_can_see_order(order_id)
  OR (status IN ('issued', 'paid') AND EXISTS (SELECT 1 FROM public.orders o WHERE o.id = invoices.order_id AND o.customer_id = auth.uid()))
);

DROP POLICY IF EXISTS "invoice_lines_select" ON public.invoice_lines;
CREATE POLICY "invoice_lines_select" ON public.invoice_lines FOR SELECT USING (
  EXISTS (SELECT 1 FROM public.invoices i WHERE i.id = invoice_lines.invoice_id AND public.staff_can_see_order(i.order_id))
  OR EXISTS (
    SELECT 1 FROM public.invoices i JOIN public.orders o ON o.id = i.order_id
    WHERE i.id = invoice_lines.invoice_id AND i.status IN ('issued', 'paid') AND o.customer_id = auth.uid()
  )
);

DROP POLICY IF EXISTS "payments_select" ON public.payments;
CREATE POLICY "payments_select" ON public.payments FOR SELECT USING (
  public.staff_can_see_order(order_id)
  OR EXISTS (SELECT 1 FROM public.orders o WHERE o.id = payments.order_id AND o.customer_id = auth.uid())
);

DROP POLICY IF EXISTS "shipments_select" ON public.shipments;
CREATE POLICY "shipments_select" ON public.shipments FOR SELECT USING (
  public.staff_can_see_order(order_id)
  OR EXISTS (SELECT 1 FROM public.orders o WHERE o.id = shipments.order_id AND o.customer_id = auth.uid())
);
DROP POLICY IF EXISTS "shipments_staff_write" ON public.shipments;
CREATE POLICY "shipments_staff_write" ON public.shipments FOR ALL USING (public.staff_can_see_order(order_id)) WITH CHECK (public.staff_can_see_order(order_id));

DROP POLICY IF EXISTS "order_unit_articles_staff" ON public.order_unit_articles;
CREATE POLICY "order_unit_articles_staff" ON public.order_unit_articles FOR ALL
  USING (EXISTS (SELECT 1 FROM public.order_units u WHERE u.id = order_unit_articles.unit_id AND public.staff_can_see_order(u.order_id)))
  WITH CHECK (EXISTS (SELECT 1 FROM public.order_units u WHERE u.id = order_unit_articles.unit_id AND public.staff_can_see_order(u.order_id)));

DROP POLICY IF EXISTS "order_unit_events_staff" ON public.order_unit_events;
CREATE POLICY "order_unit_events_staff" ON public.order_unit_events FOR ALL USING (public.staff_can_see_order(order_id)) WITH CHECK (public.staff_can_see_order(order_id));

DROP POLICY IF EXISTS "order_messages_staff_select" ON public.order_messages;
CREATE POLICY "order_messages_staff_select" ON public.order_messages FOR SELECT USING (public.staff_can_see_order(order_id));

-- Last line marker: if you can see this in the SQL editor, the whole file was pasted.
CREATE INDEX IF NOT EXISTS orders_status_updated_idx ON public.orders (status, updated_at DESC);
