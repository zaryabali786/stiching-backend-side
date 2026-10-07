-- V360: run ONLY this if migrations 0001-0003 were already applied (it carries 0004 + 0005 + 0006 + 0007 + 0008 + 0009 + 0010 + 0011). Safe to run more than once.
-- ==============================================================================
-- 0004_catalogue_chat.sql
-- 1. Managed catalogues: brands, couriers, article types + articles (neckline, sleeves,
--    trouser, collar, ... created from the partner portal, nothing hardcoded)
-- 2. Order fields: brand_id, courier_id, international_shipping, per-article selections
-- 3. Order conversations: text + voice messages (realtime over Socket.IO, persisted here)
-- Safe to run more than once.
-- ==============================================================================

-- Shared updated_at trigger
CREATE OR REPLACE FUNCTION public.touch_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at := NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ------------------------------------------------------------------------------
-- 1. BRANDS and COURIERS
-- ------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.brands (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name TEXT NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 80),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  created_by UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS brands_name_lower_idx ON public.brands (lower(btrim(name)));
CREATE INDEX IF NOT EXISTS brands_status_name_idx ON public.brands (status, lower(name));

CREATE TABLE IF NOT EXISTS public.couriers (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name TEXT NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 80),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  -- customers must enter a tracking number when they pick this courier
  requires_tracking BOOLEAN NOT NULL DEFAULT TRUE,
  created_by UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS couriers_name_lower_idx ON public.couriers (lower(btrim(name)));
CREATE INDEX IF NOT EXISTS couriers_status_name_idx ON public.couriers (status, lower(name));

DROP TRIGGER IF EXISTS trg_brands_updated ON public.brands;
CREATE TRIGGER trg_brands_updated BEFORE UPDATE ON public.brands FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();
DROP TRIGGER IF EXISTS trg_couriers_updated ON public.couriers;
CREATE TRIGGER trg_couriers_updated BEFORE UPDATE ON public.couriers FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- ------------------------------------------------------------------------------
-- 2. ARTICLE TYPES and ARTICLES (generic: Neckline, Sleeves, Trouser, Collar, ...)
-- ------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.article_types (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name TEXT NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 60),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS article_types_name_lower_idx ON public.article_types (lower(btrim(name)));
CREATE INDEX IF NOT EXISTS article_types_order_idx ON public.article_types (status, sort_order, lower(name));

CREATE TABLE IF NOT EXISTS public.articles (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  article_type_id UUID NOT NULL REFERENCES public.article_types(id) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 100),
  image_url TEXT,
  image_path TEXT,
  -- internal / business use only: never returned to customers
  price NUMERIC(12,2) CHECK (price IS NULL OR price >= 0),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS articles_type_name_lower_idx ON public.articles (article_type_id, lower(btrim(name)));
CREATE INDEX IF NOT EXISTS articles_type_status_idx ON public.articles (article_type_id, status, sort_order, lower(name));

DROP TRIGGER IF EXISTS trg_article_types_updated ON public.article_types;
CREATE TRIGGER trg_article_types_updated BEFORE UPDATE ON public.article_types FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();
DROP TRIGGER IF EXISTS trg_articles_updated ON public.articles;
CREATE TRIGGER trg_articles_updated BEFORE UPDATE ON public.articles FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- What a customer picked for each piece of an order (one article per type per piece).
-- RESTRICT: articles in use are deactivated by the API, never hard-deleted.
CREATE TABLE IF NOT EXISTS public.order_unit_articles (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  unit_id UUID NOT NULL REFERENCES public.order_units(id) ON DELETE CASCADE,
  article_type_id UUID NOT NULL REFERENCES public.article_types(id) ON DELETE RESTRICT,
  article_id UUID NOT NULL REFERENCES public.articles(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (unit_id, article_type_id)
);
CREATE INDEX IF NOT EXISTS order_unit_articles_unit_idx ON public.order_unit_articles (unit_id);
CREATE INDEX IF NOT EXISTS order_unit_articles_article_idx ON public.order_unit_articles (article_id);

-- ------------------------------------------------------------------------------
-- 3. ORDER fields
-- ------------------------------------------------------------------------------
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS brand_id UUID REFERENCES public.brands(id) ON DELETE SET NULL;
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS courier_id UUID REFERENCES public.couriers(id) ON DELETE SET NULL;
-- shipping_service ('express' | 'standard') is derived: international => express, otherwise standard
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS international_shipping BOOLEAN;
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS last_message_at TIMESTAMPTZ;
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS last_message_preview TEXT;
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS last_message_role TEXT;
CREATE INDEX IF NOT EXISTS orders_brand_id_idx ON public.orders (brand_id);
CREATE INDEX IF NOT EXISTS orders_courier_id_idx ON public.orders (courier_id);
CREATE INDEX IF NOT EXISTS orders_last_message_idx ON public.orders (last_message_at DESC) WHERE last_message_at IS NOT NULL;

-- ------------------------------------------------------------------------------
-- 3b. SIZE CHARTS: nearest standard size, and a frozen copy of the chart on each order piece
-- ------------------------------------------------------------------------------
ALTER TABLE public.size_charts ADD COLUMN IF NOT EXISTS nearest_size TEXT;
DO $$ BEGIN
  ALTER TABLE public.size_charts ADD CONSTRAINT size_charts_nearest_size_check
    CHECK (nearest_size IS NULL OR nearest_size IN ('XS', 'S', 'M', 'L', 'XL'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
ALTER TABLE public.order_units ADD COLUMN IF NOT EXISTS size_snapshot JSONB;

-- Voice notes next to every text note: { path, mime, duration, size } in the private "documents" bucket
ALTER TABLE public.order_units ADD COLUMN IF NOT EXISTS notes_audio JSONB;          -- customer's note for the tailor on a piece
ALTER TABLE public.order_units ADD COLUMN IF NOT EXISTS issue_audio JSONB;          -- receiving issue note
ALTER TABLE public.size_charts ADD COLUMN IF NOT EXISTS notes_audio JSONB;          -- note on a size chart
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS change_request_audio JSONB;      -- customer's requested changes
ALTER TABLE public.job_card_comments ADD COLUMN IF NOT EXISTS notes_audio JSONB;    -- a comment recorded by voice
ALTER TABLE public.job_cards ADD COLUMN IF NOT EXISTS qc_notes_audio JSONB;         -- "needs fixing" note from QC

-- Pieces ordered before this migration get their chart copied now (best effort)
UPDATE public.order_units u
   SET size_snapshot = jsonb_build_object(
     'id', c.id, 'name', c.name, 'person_name', c.person_name, 'variation', c.variation,
     'nearest_size', c.nearest_size, 'measurements', c.measurements, 'notes', c.notes, 'notes_audio', c.notes_audio, 'fit_feedback', c.fit_feedback)
  FROM public.size_charts c
 WHERE u.size_chart_id = c.id AND u.size_snapshot IS NULL;

-- ------------------------------------------------------------------------------
-- 3c. APPROVAL PER PIECE: each production ticket (job card) has its own photos, status and change request
-- ------------------------------------------------------------------------------
ALTER TABLE public.job_cards ADD COLUMN IF NOT EXISTS approval_status TEXT NOT NULL DEFAULT 'none';
ALTER TABLE public.job_cards ADD COLUMN IF NOT EXISTS approval_photos JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE public.job_cards ADD COLUMN IF NOT EXISTS approval_requested_at TIMESTAMPTZ;
ALTER TABLE public.job_cards ADD COLUMN IF NOT EXISTS approval_decided_at TIMESTAMPTZ;
ALTER TABLE public.job_cards ADD COLUMN IF NOT EXISTS change_request TEXT;
ALTER TABLE public.job_cards ADD COLUMN IF NOT EXISTS change_request_audio JSONB;
DO $$ BEGIN
  ALTER TABLE public.job_cards ADD CONSTRAINT job_cards_approval_status_check
    CHECK (approval_status IN ('none', 'pending', 'approved', 'changes_requested'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS job_cards_approval_idx ON public.job_cards (order_id) WHERE approval_status = 'pending';

-- Orders that are waiting for approval right now (one photo set for the whole order) become pending per piece
UPDATE public.job_cards c
   SET approval_status = 'pending',
       approval_photos = o.approval_photos,
       approval_requested_at = NOW()
  FROM public.orders o
 WHERE c.order_id = o.id AND o.status = 'customer_approval'
   AND c.approval_status = 'none' AND c.qc_passed = TRUE;

-- ------------------------------------------------------------------------------
-- 4. ORDER MESSAGES (customer <-> partner conversation per order; text + voice)
-- ------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.order_messages (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  order_id UUID NOT NULL REFERENCES public.orders(id) ON DELETE CASCADE,
  sender_id UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  sender_role TEXT NOT NULL CHECK (sender_role IN ('customer', 'partner_staff', 'admin')),
  kind TEXT NOT NULL CHECK (kind IN ('text', 'voice')),
  body TEXT CHECK (body IS NULL OR char_length(body) <= 4000),
  -- voice: { path, mime, duration (seconds), size } in the private "documents" bucket
  audio JSONB,
  -- lets a client safely retry a send without creating duplicates
  client_msg_id TEXT,
  -- set when the other side has opened the conversation
  read_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT order_messages_content_check CHECK (
    (kind = 'text' AND body IS NOT NULL AND char_length(btrim(body)) > 0)
    OR (kind = 'voice' AND audio IS NOT NULL)
  )
);
CREATE INDEX IF NOT EXISTS order_messages_order_idx ON public.order_messages (order_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS order_messages_unread_idx ON public.order_messages (order_id, sender_role) WHERE read_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS order_messages_client_msg_idx
  ON public.order_messages (order_id, sender_id, client_msg_id) WHERE client_msg_id IS NOT NULL;

-- A conversation can be about one article of the order (unit_id) or about the order in general (NULL)
ALTER TABLE public.order_messages ADD COLUMN IF NOT EXISTS unit_id UUID REFERENCES public.order_units(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS order_messages_unit_idx ON public.order_messages (order_id, unit_id, created_at DESC);

-- Each article's own timeline (received, cutting, stitching, quality check, approval, packed, ...)
CREATE TABLE IF NOT EXISTS public.order_unit_events (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  order_id UUID NOT NULL REFERENCES public.orders(id) ON DELETE CASCADE,
  unit_id UUID NOT NULL REFERENCES public.order_units(id) ON DELETE CASCADE,
  status TEXT NOT NULL,
  note TEXT,
  created_by UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS order_unit_events_unit_idx ON public.order_unit_events (unit_id, created_at);
ALTER TABLE public.order_unit_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "order_unit_events_own_select" ON public.order_unit_events;
CREATE POLICY "order_unit_events_own_select" ON public.order_unit_events FOR SELECT USING (
  EXISTS (SELECT 1 FROM public.orders o WHERE o.id = order_unit_events.order_id AND o.customer_id = auth.uid())
);
DROP POLICY IF EXISTS "order_unit_events_staff" ON public.order_unit_events;
CREATE POLICY "order_unit_events_staff" ON public.order_unit_events FOR ALL USING (public.is_staff()) WITH CHECK (public.is_staff());

-- Keep orders.last_message_at current so the partner inbox can be listed and sorted cheaply
CREATE OR REPLACE FUNCTION public.bump_order_last_message()
RETURNS TRIGGER AS $$
BEGIN
  UPDATE public.orders
     SET last_message_at = NEW.created_at,
         last_message_role = NEW.sender_role,
         last_message_preview = CASE WHEN NEW.kind = 'voice' THEN 'Voice message' ELSE left(NEW.body, 120) END
   WHERE id = NEW.order_id;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_order_messages_bump ON public.order_messages;
CREATE TRIGGER trg_order_messages_bump AFTER INSERT ON public.order_messages
  FOR EACH ROW EXECUTE FUNCTION public.bump_order_last_message();

-- ------------------------------------------------------------------------------
-- 5. ROW LEVEL SECURITY (the API uses the service role; these protect direct access)
-- ------------------------------------------------------------------------------
ALTER TABLE public.brands ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.couriers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.article_types ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.articles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.order_unit_articles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.order_messages ENABLE ROW LEVEL SECURITY;

-- Catalogues: signed-in users read active rows; staff manage everything
DROP POLICY IF EXISTS "brands_read_active" ON public.brands;
CREATE POLICY "brands_read_active" ON public.brands FOR SELECT USING (auth.uid() IS NOT NULL AND (status = 'active' OR public.is_staff()));
DROP POLICY IF EXISTS "brands_staff_write" ON public.brands;
CREATE POLICY "brands_staff_write" ON public.brands FOR ALL USING (public.is_staff()) WITH CHECK (public.is_staff());

DROP POLICY IF EXISTS "couriers_read_active" ON public.couriers;
CREATE POLICY "couriers_read_active" ON public.couriers FOR SELECT USING (auth.uid() IS NOT NULL AND (status = 'active' OR public.is_staff()));
DROP POLICY IF EXISTS "couriers_staff_write" ON public.couriers;
CREATE POLICY "couriers_staff_write" ON public.couriers FOR ALL USING (public.is_staff()) WITH CHECK (public.is_staff());

DROP POLICY IF EXISTS "article_types_read_active" ON public.article_types;
CREATE POLICY "article_types_read_active" ON public.article_types FOR SELECT USING (auth.uid() IS NOT NULL AND (status = 'active' OR public.is_staff()));
DROP POLICY IF EXISTS "article_types_staff_write" ON public.article_types;
CREATE POLICY "article_types_staff_write" ON public.article_types FOR ALL USING (public.is_staff()) WITH CHECK (public.is_staff());

-- Articles carry an internal price, so only staff can read the table directly; customers go through the API
DROP POLICY IF EXISTS "articles_staff_all" ON public.articles;
CREATE POLICY "articles_staff_all" ON public.articles FOR ALL USING (public.is_staff()) WITH CHECK (public.is_staff());

-- Selections: the order's customer reads their own; staff manage
DROP POLICY IF EXISTS "order_unit_articles_own_select" ON public.order_unit_articles;
CREATE POLICY "order_unit_articles_own_select" ON public.order_unit_articles FOR SELECT USING (
  EXISTS (
    SELECT 1 FROM public.order_units u JOIN public.orders o ON o.id = u.order_id
    WHERE u.id = order_unit_articles.unit_id AND o.customer_id = auth.uid()
  )
);
DROP POLICY IF EXISTS "order_unit_articles_staff" ON public.order_unit_articles;
CREATE POLICY "order_unit_articles_staff" ON public.order_unit_articles FOR ALL USING (public.is_staff()) WITH CHECK (public.is_staff());

-- Messages: the order's customer and staff read; every write goes through the API
DROP POLICY IF EXISTS "order_messages_customer_select" ON public.order_messages;
CREATE POLICY "order_messages_customer_select" ON public.order_messages FOR SELECT USING (
  EXISTS (SELECT 1 FROM public.orders o WHERE o.id = order_messages.order_id AND o.customer_id = auth.uid())
);
DROP POLICY IF EXISTS "order_messages_staff_select" ON public.order_messages;
CREATE POLICY "order_messages_staff_select" ON public.order_messages FOR SELECT USING (public.is_staff());

-- ------------------------------------------------------------------------------
-- 6. DEFAULT CATALOGUE (what used to be hardcoded in the order form). Editable from the partner portal.
-- ------------------------------------------------------------------------------
INSERT INTO public.brands (name) VALUES
  ('Sapphire'), ('Izel Apparel'), ('Khaadi'), ('Gul Ahmed'), ('Alkaram')
ON CONFLICT DO NOTHING;

INSERT INTO public.couriers (name) VALUES
  ('TCS'), ('Leopards'), ('M&P'), ('Pakistan Post'), ('DHL'), ('FedEx')
ON CONFLICT DO NOTHING;

INSERT INTO public.article_types (name, sort_order) VALUES
  ('Neckline', 10), ('Sleeves', 20), ('Trouser', 30)
ON CONFLICT DO NOTHING;

INSERT INTO public.articles (article_type_id, name, sort_order)
SELECT t.id, v.name, v.sort_order
FROM (VALUES
  ('Neckline', 'Round', 10), ('Neckline', 'V-neck', 20), ('Neckline', 'Boat', 30), ('Neckline', 'Square', 40),
  ('Sleeves', 'Full', 10), ('Sleeves', '3/4', 20), ('Sleeves', 'Short', 30),
  ('Trouser', 'Straight', 10), ('Trouser', 'Shalwar', 20), ('Trouser', 'Cigarette', 30)
) AS v(type_name, name, sort_order)
JOIN public.article_types t ON lower(btrim(t.name)) = lower(v.type_name)
ON CONFLICT DO NOTHING;

-- Link existing orders to the brand catalogue by name (new brands used before this migration are added)
INSERT INTO public.brands (name)
SELECT DISTINCT btrim(o.brand) FROM public.orders o
WHERE o.brand IS NOT NULL AND btrim(o.brand) <> ''
ON CONFLICT DO NOTHING;

UPDATE public.orders o SET brand_id = b.id
FROM public.brands b
WHERE o.brand_id IS NULL AND o.brand IS NOT NULL AND lower(btrim(o.brand)) = lower(btrim(b.name));

-- One payments row per Stripe PaymentIntent (the webhook and the confirm call may both try to record it)
CREATE UNIQUE INDEX IF NOT EXISTS payments_provider_ref_pi_idx ON public.payments (provider_ref) WHERE provider_ref LIKE 'pi\_%';

-- Articles carry the money: what the customer pays and what the partner is paid (margin = difference, computed).
-- Both are internal: customers never receive them. The old single `price` becomes the customer price.
ALTER TABLE public.articles ADD COLUMN IF NOT EXISTS customer_price NUMERIC(12,2) CHECK (customer_price IS NULL OR customer_price >= 0);
ALTER TABLE public.articles ADD COLUMN IF NOT EXISTS partner_cost NUMERIC(12,2) CHECK (partner_cost IS NULL OR partner_cost >= 0);
UPDATE public.articles SET customer_price = price WHERE customer_price IS NULL AND price IS NOT NULL;

-- Stitching / accessory style items now live in Partner > Articles, not in the admin price list.
-- Used rows are switched off (invoice history keeps pointing at them), unused rows are removed.
UPDATE public.price_items SET is_active = false
WHERE category IN ('stitching', 'accessory', 'accessory_stitching', 'finishing')
  AND id IN (SELECT price_item_id FROM public.invoice_lines WHERE price_item_id IS NOT NULL);
DELETE FROM public.price_items
WHERE category IN ('stitching', 'accessory', 'accessory_stitching', 'finishing')
  AND id NOT IN (SELECT price_item_id FROM public.invoice_lines WHERE price_item_id IS NOT NULL);

-- Last line marker: if you can see this in the SQL editor, the whole file was pasted.
CREATE INDEX IF NOT EXISTS order_messages_sender_idx ON public.order_messages (sender_id);


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


-- ==============================================================================
-- 0006_staff_type.sql
-- A partner's users are typed: master, tailor or other staff. The type is shown in the portals and lets the
-- partner start from sensible default permissions; what a user may actually do is still profiles.permissions
-- (always within the partner's own modules). Safe to run more than once.
-- ==============================================================================
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS staff_type TEXT;

DO $$ BEGIN
  ALTER TABLE public.profiles ADD CONSTRAINT profiles_staff_type_check
    CHECK (staff_type IS NULL OR staff_type IN ('master', 'tailor', 'staff'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- existing partner users: derive the type from the job title they were given
UPDATE public.profiles
   SET staff_type = CASE
         WHEN job_title ILIKE '%master%' THEN 'master'
         WHEN job_title ILIKE '%tailor%' THEN 'tailor'
         ELSE 'staff'
       END
 WHERE role = 'partner_staff' AND partner_role = 'member' AND staff_type IS NULL;

CREATE INDEX IF NOT EXISTS profiles_partner_type_idx ON public.profiles (partner_id, staff_type) WHERE partner_id IS NOT NULL;


-- ==============================================================================
-- 0007_team_member_login.sql
-- A master or tailor on the production board (team_members) can have their own login (profiles).
-- The link is team_members.user_id: one login per team member, one team member per login.
-- Safe to run more than once.
-- ==============================================================================
ALTER TABLE public.team_members ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES public.profiles(id) ON DELETE SET NULL;
CREATE UNIQUE INDEX IF NOT EXISTS team_members_user_idx ON public.team_members (user_id) WHERE user_id IS NOT NULL;


-- ==============================================================================
-- 0008_order_assignment.sql
-- Which partner receives a new customer order. Set by the admin (Settings > Orders):
--   auto    the active partner with the lowest load (open orders / daily capacity of its team) gets it
--   manual  the order stays unassigned (partner_id NULL) until the admin chooses a partner
-- The admin can always move an order to another partner before work on it starts.
-- Safe to run more than once.
-- ==============================================================================
CREATE TABLE IF NOT EXISTS public.platform_settings (
  key TEXT PRIMARY KEY,
  value JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_by UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE public.platform_settings ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "platform_settings_admin" ON public.platform_settings;
CREATE POLICY "platform_settings_admin" ON public.platform_settings FOR ALL USING (public.is_admin()) WITH CHECK (public.is_admin());

INSERT INTO public.platform_settings (key, value) VALUES ('order_assignment', '{"mode": "auto"}')
ON CONFLICT (key) DO NOTHING;

-- Partner with the lowest load among active partners that can receive parcels.
-- load = open orders / total daily capacity of its active team (at least 1); ties: fewer open orders, then the older partner.
CREATE OR REPLACE FUNCTION public.pick_partner_for_new_order()
RETURNS UUID AS $$
  SELECT p.id
    FROM public.partners p
    LEFT JOIN LATERAL (
      SELECT COUNT(*) AS open_orders
        FROM public.orders o
       WHERE o.partner_id = p.id
         AND o.status IN ('submitted', 'received', 'assigned', 'cutting', 'stitching', 'qc_passed', 'customer_approval')
    ) oo ON TRUE
    LEFT JOIN LATERAL (
      SELECT GREATEST(1, COALESCE(SUM(t.daily_capacity), 0)) AS capacity
        FROM public.team_members t
       WHERE t.partner_id = p.id AND t.is_active
    ) cap ON TRUE
   WHERE p.status = 'active' AND 'receiving.view' = ANY (p.permissions)
   ORDER BY oo.open_orders::NUMERIC / cap.capacity, oo.open_orders, p.created_at
   LIMIT 1;
$$ LANGUAGE sql STABLE SET search_path = public;

CREATE OR REPLACE FUNCTION public.assign_default_partner()
RETURNS TRIGGER AS $$
DECLARE
  v_mode TEXT;
BEGIN
  IF NEW.partner_id IS NULL THEN
    SELECT COALESCE(value->>'mode', 'auto') INTO v_mode FROM public.platform_settings WHERE key = 'order_assignment';
    v_mode := COALESCE(v_mode, 'auto');
    IF v_mode = 'auto' THEN
      NEW.partner_id := public.pick_partner_for_new_order();
      -- nobody can take it (none active / none with receiving): fall back to the default partner, else stay unassigned
      IF NEW.partner_id IS NULL THEN
        SELECT id INTO NEW.partner_id FROM public.partners WHERE is_default AND status = 'active' LIMIT 1;
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = public;


-- ==============================================================================
-- 0009_invoice_shipping.sql
-- The shipping item chosen from the shipping price list when an invoice was built. The price itself is copied onto the
-- invoice's shipping line (invoice_lines.customer_amount), so later price-list changes never alter an existing invoice;
-- this column only remembers which rate was selected (it is cleared if the rate is ever deleted).
-- Safe to run more than once.
-- ==============================================================================
ALTER TABLE public.invoices ADD COLUMN IF NOT EXISTS shipping_rate_id UUID REFERENCES public.shipping_rates(id) ON DELETE SET NULL;


-- ==============================================================================
-- 0010_inbox.sql
-- Every customer has their own shopping address (profiles.inbound_email_token ->
-- <token>@<INBOUND_EMAIL_DOMAIN>). Every email that arrives there is kept here so
-- the customer can read it in the app (order confirmations, tracking updates,
-- verification codes ...). Order-like emails also get an order_imports draft.
-- Safe to run more than once.
-- ==============================================================================

CREATE TABLE IF NOT EXISTS public.inbox_emails (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  customer_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  -- the mail provider's id for the message: a retried delivery is stored only once
  message_id TEXT,
  email_from TEXT,
  email_to TEXT,
  subject TEXT,
  body_text TEXT,
  body_html TEXT,
  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  is_read BOOLEAN NOT NULL DEFAULT FALSE,
  -- draft read from this email when it looked like an order confirmation
  import_id UUID REFERENCES public.order_imports(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS inbox_emails_message_idx
  ON public.inbox_emails (customer_id, message_id) WHERE message_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS inbox_emails_customer_idx
  ON public.inbox_emails (customer_id, received_at DESC);
CREATE INDEX IF NOT EXISTS inbox_emails_unread_idx
  ON public.inbox_emails (customer_id) WHERE is_read = FALSE;

ALTER TABLE public.inbox_emails ENABLE ROW LEVEL SECURITY;

-- Customers read their own mail; all writes go through the backend (service role)
DROP POLICY IF EXISTS "inbox_emails_own_select" ON public.inbox_emails;
CREATE POLICY "inbox_emails_own_select" ON public.inbox_emails FOR SELECT USING (auth.uid() = customer_id);
DROP POLICY IF EXISTS "inbox_emails_admin" ON public.inbox_emails;
CREATE POLICY "inbox_emails_admin" ON public.inbox_emails FOR ALL USING (public.is_admin()) WITH CHECK (public.is_admin());


-- ==============================================================================
-- 0011_draft_orders.sql
-- Orders made automatically from an email in the customer's Inbox start as a DRAFT:
-- the customer sees them (marked "Draft · from mail") and completes courier / sizes,
-- then submits. Until then no partner or admin sees them and nobody is notified.
-- Safe to run more than once.
-- ==============================================================================

-- 1. the new status
ALTER TABLE public.orders DROP CONSTRAINT IF EXISTS orders_status_check;
ALTER TABLE public.orders ADD CONSTRAINT orders_status_check CHECK (
  status IN (
    'draft', 'submitted', 'received', 'assigned', 'cutting', 'stitching',
    'qc_passed', 'customer_approval', 'packed', 'invoice_issued',
    'awaiting_payment', 'paid', 'at_admin_warehouse', 'partner_dispatch',
    'shipped', 'delivered', 'cancelled'
  )
);

-- a draft ranks before everything (the forward-only guard only matters from "paid" on)
CREATE OR REPLACE FUNCTION public.order_status_rank(p_status TEXT)
RETURNS INTEGER AS $$
  SELECT CASE p_status
    WHEN 'draft' THEN -1
    WHEN 'submitted' THEN 0 WHEN 'received' THEN 1 WHEN 'assigned' THEN 2 WHEN 'cutting' THEN 3
    WHEN 'stitching' THEN 4 WHEN 'qc_passed' THEN 5 WHEN 'customer_approval' THEN 6 WHEN 'packed' THEN 7
    WHEN 'invoice_issued' THEN 8 WHEN 'awaiting_payment' THEN 9 WHEN 'paid' THEN 10
    WHEN 'at_admin_warehouse' THEN 11 WHEN 'partner_dispatch' THEN 11
    WHEN 'shipped' THEN 12 WHEN 'delivered' THEN 13
    ELSE NULL END;
$$ LANGUAGE sql IMMUTABLE;

-- 2. a draft belongs to no partner. The partner is chosen (per the admin's Settings > Orders)
--    at the moment the customer submits the draft, exactly as for a normally created order.
CREATE OR REPLACE FUNCTION public.assign_default_partner()
RETURNS TRIGGER AS $$
DECLARE
  v_mode TEXT;
BEGIN
  IF NEW.partner_id IS NULL AND NEW.status <> 'draft' AND (TG_OP = 'INSERT' OR OLD.status = 'draft') THEN
    SELECT COALESCE(value->>'mode', 'auto') INTO v_mode FROM public.platform_settings WHERE key = 'order_assignment';
    v_mode := COALESCE(v_mode, 'auto');
    IF v_mode = 'auto' THEN
      NEW.partner_id := public.pick_partner_for_new_order();
      IF NEW.partner_id IS NULL THEN
        SELECT id INTO NEW.partner_id FROM public.partners WHERE is_default AND status = 'active' LIMIT 1;
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = public;

DROP TRIGGER IF EXISTS trg_orders_default_partner ON public.orders;
CREATE TRIGGER trg_orders_default_partner BEFORE INSERT OR UPDATE OF status ON public.orders
  FOR EACH ROW EXECUTE FUNCTION public.assign_default_partner();
