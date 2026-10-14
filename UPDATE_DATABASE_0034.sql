-- V360: run ONLY this if migrations 0001-0003 were already applied (it carries 0004 + 0005 + 0006 + 0007 + 0008 + 0009 + 0010 + 0011 + 0012 + 0013 + 0014 + 0015 + 0016 + 0017 + 0018 + 0019 + 0020 + 0021 + 0022 + 0023 + 0024 + 0025 + 0026 + 0027 + 0028 + 0029 + 0030 + 0031 + 0032 + 0033 + 0034). Safe to run more than once.
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
-- 0013 replaces this index with a per-partner one: do not bring the old one back once partner_id exists
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'article_types' AND column_name = 'partner_id') THEN
    CREATE UNIQUE INDEX IF NOT EXISTS article_types_name_lower_idx ON public.article_types (lower(btrim(name)));
  END IF;
END $$;
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
-- 0013 replaces this index with a per-partner one: do not bring the old one back once partner_id exists
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'articles' AND column_name = 'partner_id') THEN
    CREATE UNIQUE INDEX IF NOT EXISTS articles_type_name_lower_idx ON public.articles (article_type_id, lower(btrim(name)));
  END IF;
END $$;
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


-- ==============================================================================
-- 0012_banners.sql
-- Home-page banners managed by the admin and shown to customers in the client app.
-- Each banner has a picture and an optional link opened when the customer taps it.
-- Safe to run more than once.
-- ==============================================================================

CREATE TABLE IF NOT EXISTS public.banners (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title       TEXT,
  image_url   TEXT NOT NULL,
  image_path  TEXT,
  link_url    TEXT,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  is_active   BOOLEAN NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS banners_active_order_idx ON public.banners (is_active, sort_order, created_at DESC);

ALTER TABLE public.banners ENABLE ROW LEVEL SECURITY;


-- ==============================================================================
-- 0013_partner_choice.sql
-- Customers choose the stitching partner when they start an order. That partner's own address is shown
-- as the "ship to" address, and only that partner's articles (plus the ones shared by everyone) are offered.
--   1. partners: customer-facing profile + the receiving address of the partner
--   2. article_types / articles: partner_id (NULL = shared with every partner, existing rows stay shared)
-- Safe to run more than once.
-- ==============================================================================

-- 1. PARTNER PROFILE ----------------------------------------------------------
ALTER TABLE public.partners ADD COLUMN IF NOT EXISTS short_code TEXT;
ALTER TABLE public.partners ADD COLUMN IF NOT EXISTS city TEXT;
ALTER TABLE public.partners ADD COLUMN IF NOT EXISTS tagline TEXT;
ALTER TABLE public.partners ADD COLUMN IF NOT EXISTS turnaround_days INTEGER;
ALTER TABLE public.partners ADD COLUMN IF NOT EXISTS is_listed BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE public.partners ADD COLUMN IF NOT EXISTS receiving_name TEXT;
ALTER TABLE public.partners ADD COLUMN IF NOT EXISTS receiving_address TEXT;
ALTER TABLE public.partners ADD COLUMN IF NOT EXISTS receiving_city TEXT;
ALTER TABLE public.partners ADD COLUMN IF NOT EXISTS receiving_phone TEXT;

-- a short code (P1, P2 ...) written on the parcel label next to the customer code
UPDATE public.partners p
   SET short_code = 'P' || n.rn
  FROM (SELECT id, ROW_NUMBER() OVER (ORDER BY created_at, id) AS rn FROM public.partners) n
 WHERE p.id = n.id AND p.short_code IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS partners_short_code_idx ON public.partners (lower(btrim(short_code))) WHERE short_code IS NOT NULL;

-- 2. PARTNER-OWNED CATALOGUE ---------------------------------------------------
ALTER TABLE public.article_types ADD COLUMN IF NOT EXISTS partner_id UUID REFERENCES public.partners(id) ON DELETE RESTRICT;
ALTER TABLE public.articles ADD COLUMN IF NOT EXISTS partner_id UUID REFERENCES public.partners(id) ON DELETE RESTRICT;
CREATE INDEX IF NOT EXISTS article_types_partner_idx ON public.article_types (partner_id);
CREATE INDEX IF NOT EXISTS articles_partner_idx ON public.articles (partner_id);

-- names are unique inside one owner (a partner, or "shared"), not across the whole platform
DROP INDEX IF EXISTS public.article_types_name_lower_idx;
CREATE UNIQUE INDEX IF NOT EXISTS article_types_owner_name_idx
  ON public.article_types (COALESCE(partner_id, '00000000-0000-0000-0000-000000000000'::uuid), lower(btrim(name)));

DROP INDEX IF EXISTS public.articles_type_name_lower_idx;
CREATE UNIQUE INDEX IF NOT EXISTS articles_owner_type_name_idx
  ON public.articles (article_type_id, COALESCE(partner_id, '00000000-0000-0000-0000-000000000000'::uuid), lower(btrim(name)));


-- ==============================================================================
-- 0014_central_orders_email_matching.sql
--   1. Every new order starts at the admin's central location (partner_id NULL); the admin chooses the partner later.
--   2. Follow-up emails (shipping / tracking) are matched to the customer's existing order by its order number:
--      the inbox email remembers the order it updated, or that it needs a manual look.
--   3. Courier name read from an email is kept on the order even when it is not in the courier list.
--   4. Guard against duplicates: one email-created order per (customer, brand order number).
-- Safe to run more than once.
-- ==============================================================================

-- 1. CENTRAL LOCATION FIRST ----------------------------------------------------
-- New orders wait for the admin to choose a partner (Settings > Orders is set to "manual").
INSERT INTO public.platform_settings (key, value) VALUES ('order_assignment', '{"mode": "manual"}')
ON CONFLICT (key) DO UPDATE SET value = '{"mode": "manual"}'::jsonb, updated_at = NOW();

-- 2. EMAIL <-> ORDER MATCHING --------------------------------------------------
ALTER TABLE public.inbox_emails ADD COLUMN IF NOT EXISTS order_id UUID REFERENCES public.orders(id) ON DELETE SET NULL;
-- none    = nothing to match (newsletter, first order confirmation that made a draft ...)
-- matched = the courier / tracking in this email were saved on order_id
-- review  = the order number was missing or matched more than one order: nothing was changed, a person must look
ALTER TABLE public.inbox_emails ADD COLUMN IF NOT EXISTS match_status TEXT NOT NULL DEFAULT 'none';
ALTER TABLE public.inbox_emails ADD COLUMN IF NOT EXISTS match_note TEXT;
DO $$ BEGIN
  ALTER TABLE public.inbox_emails ADD CONSTRAINT inbox_emails_match_status_check CHECK (match_status IN ('none', 'matched', 'review'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS inbox_emails_order_idx ON public.inbox_emails (order_id) WHERE order_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS inbox_emails_review_idx ON public.inbox_emails (customer_id) WHERE match_status = 'review';

-- 3. COURIER NAME FROM AN EMAIL --------------------------------------------------
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS courier_name TEXT;
-- when the courier / tracking last came from an email (an older email never overwrites a newer one)
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS shipping_updated_at TIMESTAMPTZ;

-- 4. NO DUPLICATES ---------------------------------------------------------------
-- Looking an order up by its number must find at most one email-created order per customer.
DO $$ BEGIN
  CREATE UNIQUE INDEX IF NOT EXISTS orders_email_order_number_idx
    ON public.orders (customer_id, lower(btrim(brand_order_number)))
    WHERE import_source = 'email' AND brand_order_number IS NOT NULL AND btrim(brand_order_number) <> '' AND status <> 'cancelled';
EXCEPTION WHEN unique_violation THEN
  RAISE NOTICE 'orders_email_order_number_idx not created: duplicate email orders already exist. Clean them up and run this file again.';
END $$;


-- Every customer's shopping address now follows their customer code (STX-10011 -> stx-10011@<mail domain>).
-- Existing customers get the same, replacing their old random token.
UPDATE public.profiles
SET inbound_email_token = lower(customer_code)
WHERE customer_code IS NOT NULL
  AND inbound_email_token IS DISTINCT FROM lower(customer_code);


-- Customers can now write and reply to emails from the app. Sent mail is kept in the same table.
ALTER TABLE public.inbox_emails ADD COLUMN IF NOT EXISTS direction TEXT NOT NULL DEFAULT 'in';
ALTER TABLE public.inbox_emails ADD COLUMN IF NOT EXISTS attachments JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE public.inbox_emails ADD COLUMN IF NOT EXISTS reply_to_id UUID REFERENCES public.inbox_emails(id) ON DELETE SET NULL;
DO $$ BEGIN
  ALTER TABLE public.inbox_emails ADD CONSTRAINT inbox_emails_direction_chk CHECK (direction IN ('in', 'out'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS inbox_emails_direction_idx ON public.inbox_emails (customer_id, direction, received_at DESC);
NOTIFY pgrst, 'reload schema';


-- ==============================================================================
-- 0017_parcel_receiving_media.sql
-- Receiving for orders that come "direct from a website" (email drafts):
--   * every article gets a permanent code (<order reference>-<n>) shown as a QR code
--   * the receiver uploads photos / a video of the whole parcel and of each article
--   * a draft stays a draft when its parcel arrives; the customer reviews the media and approves,
--     then adds sizes and details and submits (the order then continues as "received")
-- Safe to run more than once.
-- ==============================================================================

ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS parcel_media JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS parcel_received_at TIMESTAMPTZ;
-- none = nothing to review · pending = waiting for the customer · approved
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS parcel_review TEXT NOT NULL DEFAULT 'none';
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS parcel_review_at TIMESTAMPTZ;
DO $$ BEGIN
  ALTER TABLE public.orders ADD CONSTRAINT orders_parcel_review_check CHECK (parcel_review IN ('none', 'pending', 'approved'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE public.order_units ADD COLUMN IF NOT EXISTS code TEXT;
ALTER TABLE public.order_units ADD COLUMN IF NOT EXISTS receive_media JSONB NOT NULL DEFAULT '[]'::jsonb;

-- The code never changes once given, even if the articles are re-ordered or one is removed.
CREATE OR REPLACE FUNCTION public.set_unit_code()
RETURNS TRIGGER AS $$
DECLARE
  v_ref TEXT;
  v_next INTEGER;
BEGIN
  IF NEW.code IS NULL THEN
    SELECT reference INTO v_ref FROM public.orders WHERE id = NEW.order_id;
    SELECT COALESCE(MAX(substring(code FROM '-(\d+)$')::int), 0) + 1 INTO v_next FROM public.order_units WHERE order_id = NEW.order_id AND code IS NOT NULL;
    NEW.code := COALESCE(v_ref, 'ORD') || '-' || v_next;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = public;

DROP TRIGGER IF EXISTS trg_order_units_code ON public.order_units;
CREATE TRIGGER trg_order_units_code BEFORE INSERT ON public.order_units
  FOR EACH ROW EXECUTE FUNCTION public.set_unit_code();

-- Backfill existing articles in their line order.
UPDATE public.order_units u
SET code = o.reference || '-' || n.rn
FROM public.orders o, (
  SELECT id, ROW_NUMBER() OVER (PARTITION BY order_id ORDER BY line_no, created_at) AS rn FROM public.order_units
) n
WHERE u.id = n.id AND o.id = u.order_id AND u.code IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS order_units_code_idx ON public.order_units (code) WHERE code IS NOT NULL;


-- ==============================================================================
-- 0018_support_chat.sql
-- A general chat between a customer and the admin team, not tied to any order
-- (the chat button outside an order page). One thread per customer.
-- Safe to run more than once.
-- ==============================================================================
CREATE TABLE IF NOT EXISTS public.support_messages (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  customer_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  sender_id UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  sender_role TEXT NOT NULL CHECK (sender_role IN ('customer', 'admin')),
  body TEXT NOT NULL CHECK (char_length(btrim(body)) > 0 AND char_length(body) <= 4000),
  -- lets a client safely retry a send without creating duplicates
  client_msg_id TEXT,
  -- set when the other side has opened the conversation
  read_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS support_messages_thread_idx ON public.support_messages (customer_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS support_messages_unread_idx ON public.support_messages (customer_id, sender_role) WHERE read_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS support_messages_client_msg_idx
  ON public.support_messages (customer_id, sender_id, client_msg_id) WHERE client_msg_id IS NOT NULL;
ALTER TABLE public.support_messages ENABLE ROW LEVEL SECURITY;


-- ==============================================================================
-- 0019_unit_brand.sql
-- Orders made "direct from customer" name the brand per article (each article can come from a different brand).
-- The order keeps the first article's brand as its own brand. Safe to run more than once.
-- ==============================================================================
ALTER TABLE public.order_units ADD COLUMN IF NOT EXISTS brand_id UUID REFERENCES public.brands(id) ON DELETE SET NULL;
ALTER TABLE public.order_units ADD COLUMN IF NOT EXISTS brand TEXT;


-- ==============================================================================
-- 0020_default_partner_assignment.sql
-- New orders go automatically to the partner the admin marked as DEFAULT (Partners > Make default).
--   mode 'default'  every new / submitted order gets the default partner (when it is active)
--   mode 'auto'     the least busy partner (as before)      mode 'manual'  the order waits for the admin
-- Orders still waiting at the central location (no partner yet) are given the default partner now.
-- Safe to run more than once.
-- ==============================================================================

INSERT INTO public.platform_settings (key, value) VALUES ('order_assignment', '{"mode": "default"}')
ON CONFLICT (key) DO UPDATE SET value = '{"mode": "default"}'::jsonb, updated_at = NOW();

CREATE OR REPLACE FUNCTION public.assign_default_partner()
RETURNS TRIGGER AS $$
DECLARE
  v_mode TEXT;
BEGIN
  IF NEW.partner_id IS NULL AND NEW.status <> 'draft' AND (TG_OP = 'INSERT' OR OLD.status = 'draft') THEN
    SELECT COALESCE(value->>'mode', 'auto') INTO v_mode FROM public.platform_settings WHERE key = 'order_assignment';
    v_mode := COALESCE(v_mode, 'auto');
    IF v_mode = 'default' THEN
      SELECT id INTO NEW.partner_id FROM public.partners WHERE is_default AND status = 'active' LIMIT 1;
    ELSIF v_mode = 'auto' THEN
      NEW.partner_id := public.pick_partner_for_new_order();
      IF NEW.partner_id IS NULL THEN
        SELECT id INTO NEW.partner_id FROM public.partners WHERE is_default AND status = 'active' LIMIT 1;
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = public;

-- Open orders that never got a partner (they were waiting at the central location)
UPDATE public.orders
   SET partner_id = (SELECT id FROM public.partners WHERE is_default AND status = 'active' LIMIT 1)
 WHERE partner_id IS NULL
   AND status NOT IN ('draft', 'cancelled', 'delivered')
   AND EXISTS (SELECT 1 FROM public.partners WHERE is_default AND status = 'active');


-- ==============================================================================
-- 0021_article_workflow.sql
-- Article-level traceability:
--   1. every article (order_units) has its own review state (the customer approves / rejects it after it is received),
--      its own return / correction / resubmission tracking
--   2. a new production stage "pressing" between quality check and packing
--   3. one receipt row per QR scan (who received which article, for which stage, when)
--   4. staff types for the new roles: qa, pressing, packing
--   5. a job card (production ticket) is created only for an article that is released: received, and (when the
--      customer has to review it) approved, and its order is no longer a draft
-- Safe to run more than once.
-- ==============================================================================

-- 1. ARTICLE REVIEW + RETURN --------------------------------------------------------------------------------------
ALTER TABLE public.order_units ADD COLUMN IF NOT EXISTS review_status TEXT NOT NULL DEFAULT 'none';
-- none = no customer review needed · pending = waiting for the customer · approved · rejected
DO $$ BEGIN
  ALTER TABLE public.order_units ADD CONSTRAINT order_units_review_status_check CHECK (review_status IN ('none', 'pending', 'approved', 'rejected'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
ALTER TABLE public.order_units ADD COLUMN IF NOT EXISTS review_note TEXT;
ALTER TABLE public.order_units ADD COLUMN IF NOT EXISTS review_media JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE public.order_units ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMPTZ;
ALTER TABLE public.order_units ADD COLUMN IF NOT EXISTS reviewed_by UUID REFERENCES public.profiles(id) ON DELETE SET NULL;

-- none -> requested (customer asks to send it back) -> sent_back (team returned it) -> resubmitted (corrected / replacement
-- article is back and waits for the customer again)
ALTER TABLE public.order_units ADD COLUMN IF NOT EXISTS return_status TEXT NOT NULL DEFAULT 'none';
DO $$ BEGIN
  ALTER TABLE public.order_units ADD CONSTRAINT order_units_return_status_check CHECK (return_status IN ('none', 'requested', 'sent_back', 'resubmitted'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
ALTER TABLE public.order_units ADD COLUMN IF NOT EXISTS return_note TEXT;
ALTER TABLE public.order_units ADD COLUMN IF NOT EXISTS return_courier TEXT;
ALTER TABLE public.order_units ADD COLUMN IF NOT EXISTS return_tracking TEXT;
ALTER TABLE public.order_units ADD COLUMN IF NOT EXISTS return_updated_at TIMESTAMPTZ;
ALTER TABLE public.order_units ADD COLUMN IF NOT EXISTS resubmit_count INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS order_units_review_idx ON public.order_units (order_id, review_status) WHERE review_status <> 'none';

-- orders whose parcel was already received in the old flow: their articles carry the order's review state
UPDATE public.order_units u
   SET review_status = CASE o.parcel_review WHEN 'pending' THEN 'pending' WHEN 'approved' THEN 'approved' ELSE 'none' END
  FROM public.orders o
 WHERE o.id = u.order_id AND o.parcel_review IN ('pending', 'approved') AND u.review_status = 'none' AND u.status = 'received';

-- 2. PRESSING STAGE ------------------------------------------------------------------------------------------------
ALTER TABLE public.job_cards DROP CONSTRAINT IF EXISTS job_cards_stage_check;
ALTER TABLE public.job_cards ADD CONSTRAINT job_cards_stage_check CHECK (stage IN ('to_assign', 'cutting', 'stitching', 'qc', 'pressing', 'packed'));
ALTER TABLE public.job_cards ADD COLUMN IF NOT EXISTS pressing_at TIMESTAMPTZ;

-- 3. RECEIPTS (one row per scan that moved an article into a stage) -------------------------------------------------
CREATE TABLE IF NOT EXISTS public.unit_stage_receipts (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  order_id UUID NOT NULL REFERENCES public.orders(id) ON DELETE CASCADE,
  unit_id UUID NOT NULL REFERENCES public.order_units(id) ON DELETE CASCADE,
  card_id UUID REFERENCES public.job_cards(id) ON DELETE SET NULL,
  partner_id UUID REFERENCES public.partners(id) ON DELETE SET NULL,
  stage TEXT NOT NULL CHECK (stage IN ('cutting', 'stitching', 'qc', 'pressing', 'packed')),
  -- the role the person acted as: master | tailor | qa | pressing | packing | supervisor
  role TEXT NOT NULL,
  user_id UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  user_name TEXT,
  team_member_id UUID REFERENCES public.team_members(id) ON DELETE SET NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS unit_stage_receipts_unit_idx ON public.unit_stage_receipts (unit_id, received_at DESC);
CREATE INDEX IF NOT EXISTS unit_stage_receipts_order_idx ON public.unit_stage_receipts (order_id, received_at DESC);
CREATE INDEX IF NOT EXISTS unit_stage_receipts_partner_idx ON public.unit_stage_receipts (partner_id, received_at DESC);
ALTER TABLE public.unit_stage_receipts ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "unit_stage_receipts_staff_select" ON public.unit_stage_receipts;
CREATE POLICY "unit_stage_receipts_staff_select" ON public.unit_stage_receipts FOR SELECT USING (public.staff_can_see_order(order_id));

-- 4. STAFF TYPES ----------------------------------------------------------------------------------------------------
ALTER TABLE public.profiles DROP CONSTRAINT IF EXISTS profiles_staff_type_check;
ALTER TABLE public.profiles ADD CONSTRAINT profiles_staff_type_check
  CHECK (staff_type IS NULL OR staff_type IN ('master', 'tailor', 'qa', 'pressing', 'packing', 'staff'));

-- 5. JOB CARDS ONLY FOR RELEASED ARTICLES ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.create_job_card_for_unit()
RETURNS TRIGGER AS $$
DECLARE
  v_order public.orders%ROWTYPE;
  v_pos DOUBLE PRECISION;
BEGIN
  IF NEW.status = 'received' AND NEW.review_status IN ('none', 'approved') THEN
    SELECT * INTO v_order FROM public.orders WHERE id = NEW.order_id;
    -- a draft is still the customer's: its articles join production when the customer submits it
    IF v_order.status IN ('draft', 'cancelled') THEN
      RETURN NEW;
    END IF;
    SELECT COALESCE(MAX(position), 0) + 1024 INTO v_pos FROM public.job_cards WHERE stage = 'to_assign' AND partner_id IS NOT DISTINCT FROM v_order.partner_id;
    INSERT INTO public.job_cards (order_id, unit_id, stage, position, priority, due_date, order_reference, customer_code, unit_title, partner_id)
    VALUES (NEW.order_id, NEW.id, 'to_assign', v_pos, v_order.priority, v_order.due_date,
            v_order.reference, v_order.customer_code, NEW.unit_title, v_order.partner_id)
    ON CONFLICT (unit_id) DO NOTHING;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

DROP TRIGGER IF EXISTS trg_create_job_card ON public.order_units;
CREATE TRIGGER trg_create_job_card
  AFTER INSERT OR UPDATE OF status, review_status ON public.order_units
  FOR EACH ROW EXECUTE FUNCTION public.create_job_card_for_unit();

NOTIFY pgrst, 'reload schema';


-- ==============================================================================
-- 0022_order_sources_returns.sql
-- One parcel-review workflow for every kind of order:
--   website   a purchase made on a brand's website (product links / invoice import)
--   customer  the customer ships their own fabric / parcel to us ("direct from customer")
--   email     an order made from an email in the customer's shopping inbox
-- After the parcel is received the customer approves or rejects each article. A rejection records where the parcel goes
-- back to (the brand or the customer). Website and email orders then finish their articles / sizes / notes before the
-- approved articles enter production; a customer's own order goes straight to production once approved.
-- Safe to run more than once.
-- ==============================================================================

ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS order_source TEXT;
UPDATE public.orders
   SET order_source = CASE
     WHEN import_source = 'email' THEN 'email'
     WHEN import_source IN ('link', 'invoice') THEN 'website'
     WHEN courier_id IS NOT NULL OR tracking_number IS NOT NULL OR brand_order_number IS NOT NULL THEN 'website'
     ELSE 'customer' END
 WHERE order_source IS NULL;
ALTER TABLE public.orders ALTER COLUMN order_source SET DEFAULT 'customer';
ALTER TABLE public.orders ALTER COLUMN order_source SET NOT NULL;
DO $$ BEGIN
  ALTER TABLE public.orders ADD CONSTRAINT orders_order_source_check CHECK (order_source IN ('website', 'customer', 'email'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- when the customer finished the articles / sizes / notes step (website and email orders)
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS details_completed_at TIMESTAMPTZ;
-- orders already past the draft stage have their details: nothing changes for them
UPDATE public.orders SET details_completed_at = COALESCE(received_at, created_at) WHERE status <> 'draft' AND details_completed_at IS NULL;

-- where a rejected article is sent back to
ALTER TABLE public.order_units ADD COLUMN IF NOT EXISTS return_to TEXT;
DO $$ BEGIN
  ALTER TABLE public.order_units ADD CONSTRAINT order_units_return_to_check CHECK (return_to IS NULL OR return_to IN ('brand', 'customer'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- A production ticket only exists for an article that is released: received, approved by the customer when a review
-- applies, its order is not a draft, and (website / email orders) the customer finished the details step.
CREATE OR REPLACE FUNCTION public.create_job_card_for_unit()
RETURNS TRIGGER AS $$
DECLARE
  v_order public.orders%ROWTYPE;
  v_pos DOUBLE PRECISION;
BEGIN
  IF NEW.status = 'received' AND NEW.review_status IN ('none', 'approved') THEN
    SELECT * INTO v_order FROM public.orders WHERE id = NEW.order_id;
    IF v_order.status IN ('draft', 'cancelled') THEN
      RETURN NEW;
    END IF;
    IF v_order.order_source <> 'customer' AND v_order.details_completed_at IS NULL THEN
      RETURN NEW;
    END IF;
    SELECT COALESCE(MAX(position), 0) + 1024 INTO v_pos FROM public.job_cards WHERE stage = 'to_assign' AND partner_id IS NOT DISTINCT FROM v_order.partner_id;
    INSERT INTO public.job_cards (order_id, unit_id, stage, position, priority, due_date, order_reference, customer_code, unit_title, partner_id)
    VALUES (NEW.order_id, NEW.id, 'to_assign', v_pos, v_order.priority, v_order.due_date,
            v_order.reference, v_order.customer_code, NEW.unit_title, v_order.partner_id)
    ON CONFLICT (unit_id) DO NOTHING;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

NOTIFY pgrst, 'reload schema';


-- ==============================================================================
-- 0023_team_stage_roles.sql
-- The team page can hold the people of every production stage, not only masters and tailors:
-- quality check (qa), pressing and packing. Each can get their own login (staff type = the role) and scan articles.
-- Safe to run more than once.
-- ==============================================================================
ALTER TABLE public.team_members DROP CONSTRAINT IF EXISTS team_members_role_check;
ALTER TABLE public.team_members ADD CONSTRAINT team_members_role_check CHECK (role IN ('master', 'tailor', 'qa', 'pressing', 'packing'));

NOTIFY pgrst, 'reload schema';


-- ==============================================================================
-- 0024_order_delivery_contact.sql
-- The delivery address and phone given when an order is submitted belong to THAT order only (the customer's profile
-- is not changed). The address columns exist already; this adds the phone number for the order.
-- Safe to run more than once.
-- ==============================================================================

alter table public.orders add column if not exists destination_phone text;


-- ==============================================================================
-- 0025_express_stitching.sql
-- Express stitching: the customer can ask for the order to be stitched faster. The admin decides how many days it takes
-- (express_days); the due date follows from it. Safe to run more than once.
-- ==============================================================================

alter table public.orders add column if not exists express_stitching boolean not null default false;
alter table public.orders add column if not exists express_days integer check (express_days is null or express_days between 1 and 90);


-- ==============================================================================
-- 0026_article_hold.sql
-- When the customer rejects an article they can either ask for it to be RETURNED (notes + photos + where to) or put it
-- on HOLD (one short text). A held article stays rejected with return_status = 'held' until the customer decides.
-- Safe to run more than once.
-- ==============================================================================

alter table public.order_units drop constraint if exists order_units_return_status_check;
alter table public.order_units add constraint order_units_return_status_check
  check (return_status in ('none', 'requested', 'sent_back', 'resubmitted', 'held'));

notify pgrst, 'reload schema';


-- ==============================================================================
-- 0027_hold_resolution.sql
-- Hold articles are corrected and come back:
--   held_at           when the customer put the article on hold
--   hold_received_at  when the partner confirmed the corrected article ("Receive Corrected Article")
--   hold_received_by  who confirmed it
--   hold_resolved_at  when the customer approved the corrected article: the hold is resolved (<ref>-RESOLVED)
-- Orders are shown in groups (<ref>, <ref>-HOLD, <ref>-RETURN, <ref>-RESOLVED) derived from these article states;
-- no order or article is duplicated. Safe to run more than once.
-- ==============================================================================

alter table public.order_units add column if not exists held_at timestamptz;
alter table public.order_units add column if not exists hold_received_at timestamptz;
alter table public.order_units add column if not exists hold_received_by uuid references public.profiles(id) on delete set null;
alter table public.order_units add column if not exists hold_resolved_at timestamptz;

-- articles already on hold before this migration
update public.order_units set held_at = coalesce(return_updated_at, reviewed_at, now()) where return_status = 'held' and held_at is null;

create index if not exists order_units_hold_idx on public.order_units (order_id) where held_at is not null;

notify pgrst, 'reload schema';


-- ==============================================================================
-- 0028_return_shipping.sql
-- Where a rejected article is sent back to when the customer asks for a return to themselves: name, phone, address, city,
-- country. It starts from the customer's delivery address and the customer can change it for this return.
-- Safe to run more than once.
-- ==============================================================================

alter table public.order_units add column if not exists return_shipping jsonb;

notify pgrst, 'reload schema';


-- ==============================================================================
-- 0029_return_shipments.sql
-- The courier workflow of a returned article:
--   Return Requested -> CN booked (Ready for Return) -> loadsheet downloaded = Handed Over to Courier
--   -> In transit -> Delivered to customer -> Returned
-- One return shipment per returned article (never shared between articles), its tracking events, and the loadsheets that
-- hand a batch of parcels to one courier. Safe to run more than once.
-- ==============================================================================

-- an article whose return was delivered
alter table public.order_units drop constraint if exists order_units_return_status_check;
alter table public.order_units add constraint order_units_return_status_check
  check (return_status in ('none', 'requested', 'sent_back', 'resubmitted', 'held', 'returned'));

create sequence if not exists return_loadsheet_seq start with 1001;

create table if not exists public.return_loadsheets (
  id uuid primary key default uuid_generate_v4(),
  number text unique,
  partner_id uuid references public.partners(id) on delete set null,
  courier_id uuid references public.couriers(id) on delete set null,
  courier_name text,
  -- generated: the file was made · handed_over: it was downloaded and the parcels were handed over · void: replaced
  status text not null default 'generated' check (status in ('generated', 'handed_over', 'void')),
  -- what the loadsheet lists, as it was when it was made: [{ order, article, code, cn, to, name, phone, address, city }]
  items jsonb not null default '[]'::jsonb,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  handed_over_at timestamptz
);

create or replace function public.generate_return_loadsheet_number()
returns trigger as $$
begin
  if new.number is null then
    new.number := 'LS-' || nextval('return_loadsheet_seq')::text;
  end if;
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_return_loadsheet_number on public.return_loadsheets;
create trigger trg_return_loadsheet_number before insert on public.return_loadsheets
  for each row execute function public.generate_return_loadsheet_number();

create table if not exists public.return_shipments (
  id uuid primary key default uuid_generate_v4(),
  order_id uuid not null references public.orders(id) on delete cascade,
  unit_id uuid not null references public.order_units(id) on delete cascade,
  partner_id uuid references public.partners(id) on delete set null,
  courier_id uuid references public.couriers(id) on delete set null,
  courier_name text not null,
  cn_number text not null check (char_length(btrim(cn_number)) between 4 and 40),
  status text not null default 'booked' check (status in ('booked', 'handed_over', 'in_transit', 'delivered', 'cancelled')),
  -- manual: the partner booked it with the courier and typed the CN here · api: booked through a courier API
  booking_source text not null default 'manual' check (booking_source in ('manual', 'api')),
  booking_response jsonb,
  return_to text,
  ship_to jsonb,
  loadsheet_id uuid references public.return_loadsheets(id) on delete set null,
  booked_by uuid references public.profiles(id) on delete set null,
  booked_at timestamptz not null default now(),
  handed_over_at timestamptz,
  delivered_at timestamptz,
  cancelled_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
-- an article has at most one live return shipment, and a CN belongs to one live shipment of its courier
create unique index if not exists return_shipments_one_live_per_unit_idx on public.return_shipments (unit_id) where status <> 'cancelled';
create unique index if not exists return_shipments_cn_idx on public.return_shipments (courier_id, lower(btrim(cn_number))) where status <> 'cancelled';
create index if not exists return_shipments_order_idx on public.return_shipments (order_id);
create index if not exists return_shipments_partner_status_idx on public.return_shipments (partner_id, status);

create table if not exists public.return_shipment_events (
  id uuid primary key default uuid_generate_v4(),
  shipment_id uuid not null references public.return_shipments(id) on delete cascade,
  status text not null,
  note text,
  -- manual: typed by a person · webhook: sent by the courier · system: a step of our own workflow
  source text not null default 'system' check (source in ('manual', 'webhook', 'system')),
  -- the courier's id of this tracking event: a repeated delivery of the same event is stored once
  event_id text,
  occurred_at timestamptz not null default now(),
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now()
);
create unique index if not exists return_shipment_events_dedupe_idx on public.return_shipment_events (shipment_id, event_id) where event_id is not null;
create index if not exists return_shipment_events_shipment_idx on public.return_shipment_events (shipment_id, occurred_at);

alter table public.return_loadsheets enable row level security;
alter table public.return_shipments enable row level security;
alter table public.return_shipment_events enable row level security;

drop policy if exists "return_shipments_staff" on public.return_shipments;
create policy "return_shipments_staff" on public.return_shipments for all using (public.staff_can_see_order(order_id)) with check (public.staff_can_see_order(order_id));
drop policy if exists "return_shipments_own_select" on public.return_shipments;
create policy "return_shipments_own_select" on public.return_shipments for select using (
  exists (select 1 from public.orders o where o.id = return_shipments.order_id and o.customer_id = auth.uid())
);
drop policy if exists "return_shipment_events_staff" on public.return_shipment_events;
create policy "return_shipment_events_staff" on public.return_shipment_events for all
  using (exists (select 1 from public.return_shipments s where s.id = return_shipment_events.shipment_id and public.staff_can_see_order(s.order_id)))
  with check (exists (select 1 from public.return_shipments s where s.id = return_shipment_events.shipment_id and public.staff_can_see_order(s.order_id)));
drop policy if exists "return_shipment_events_own_select" on public.return_shipment_events;
create policy "return_shipment_events_own_select" on public.return_shipment_events for select using (
  exists (select 1 from public.return_shipments s join public.orders o on o.id = s.order_id where s.id = return_shipment_events.shipment_id and o.customer_id = auth.uid())
);
drop policy if exists "return_loadsheets_admin" on public.return_loadsheets;
create policy "return_loadsheets_admin" on public.return_loadsheets for all using (public.is_admin()) with check (public.is_admin());

notify pgrst, 'reload schema';


-- ==============================================================================
-- 0030_dispatch_shipments.sql
-- Direct dispatch from the partner warehouse, with the same courier / loadsheet logic as the returns:
--   Paid -> CN booked (Ready for dispatch) -> loadsheet downloaded -> handover confirmed (Dispatched)
--   -> In transit -> Delivered   |   failed delivery -> returning to the partner -> received back
-- Extends the existing shipments table (one per order) and the loadsheet table of the returns. Safe to run more than once.
-- ==============================================================================

alter table public.shipments drop constraint if exists shipments_status_check;
alter table public.shipments add constraint shipments_status_check check (status in (
  'needs_label',          -- paid, no courier booked yet
  'booked',               -- CN saved: ready for dispatch
  'labelled',             -- loadsheet downloaded, waiting for the courier to take the parcels
  'handed_to_courier',    -- handover confirmed: dispatched
  'in_transit',
  'delivered',
  'failed_delivery',      -- an attempt failed (the courier may try again)
  'returning_to_partner', -- the courier confirmed the parcel is coming back
  'returned_to_partner'   -- the partner confirmed it is physically back
));

alter table public.shipments add column if not exists courier_id uuid references public.couriers(id) on delete set null;
-- manual: the partner booked with the courier and typed the CN · api: booked through a courier API
alter table public.shipments add column if not exists booking_source text not null default 'manual';
alter table public.shipments add column if not exists booking_response jsonb;
alter table public.shipments add column if not exists booked_at timestamptz;
alter table public.shipments add column if not exists booked_by uuid references public.profiles(id) on delete set null;
alter table public.shipments add column if not exists loadsheet_id uuid references public.return_loadsheets(id) on delete set null;
alter table public.shipments add column if not exists failure_reason text;
alter table public.shipments add column if not exists failed_at timestamptz;
alter table public.shipments add column if not exists return_started_at timestamptz;
alter table public.shipments add column if not exists returned_at timestamptz;
alter table public.shipments add column if not exists returned_confirmed_by uuid references public.profiles(id) on delete set null;
-- proof of delivery when the courier sends it: { receiver, note, url }
alter table public.shipments add column if not exists proof jsonb;

-- a CN belongs to one live shipment of its courier
create unique index if not exists shipments_courier_cn_idx on public.shipments (courier_id, lower(btrim(tracking_number))) where tracking_number is not null and courier_id is not null;

-- loadsheets are shared with the returns
alter table public.return_loadsheets add column if not exists kind text not null default 'return';
alter table public.return_loadsheets drop constraint if exists return_loadsheets_kind_check;
alter table public.return_loadsheets add constraint return_loadsheets_kind_check check (kind in ('return', 'dispatch'));
alter table public.return_loadsheets drop constraint if exists return_loadsheets_status_check;
alter table public.return_loadsheets add constraint return_loadsheets_status_check check (status in ('generated', 'downloaded', 'handed_over', 'void'));

create table if not exists public.shipment_events (
  id uuid primary key default uuid_generate_v4(),
  shipment_id uuid not null references public.shipments(id) on delete cascade,
  status text not null,
  note text,
  source text not null default 'system' check (source in ('manual', 'webhook', 'system')),
  event_id text,
  occurred_at timestamptz not null default now(),
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now()
);
create unique index if not exists shipment_events_dedupe_idx on public.shipment_events (shipment_id, event_id) where event_id is not null;
create index if not exists shipment_events_shipment_idx on public.shipment_events (shipment_id, occurred_at);

alter table public.shipment_events enable row level security;
drop policy if exists "shipment_events_staff" on public.shipment_events;
create policy "shipment_events_staff" on public.shipment_events for all
  using (exists (select 1 from public.shipments s where s.id = shipment_events.shipment_id and public.staff_can_see_order(s.order_id)))
  with check (exists (select 1 from public.shipments s where s.id = shipment_events.shipment_id and public.staff_can_see_order(s.order_id)));
drop policy if exists "shipment_events_own_select" on public.shipment_events;
create policy "shipment_events_own_select" on public.shipment_events for select using (
  exists (select 1 from public.shipments s join public.orders o on o.id = s.order_id where s.id = shipment_events.shipment_id and o.customer_id = auth.uid())
);

notify pgrst, 'reload schema';


-- ==============================================================================
-- 0031_postex_courier.sql
-- PostEx as a courier in Catalogue > Couriers (the Warehouse books and tracks parcels with the courier of this name).
-- Safe to run more than once.
-- ==============================================================================
insert into public.couriers (name) values ('PostEx') on conflict do nothing;


-- ==============================================================================
-- 0032_return_orders.sql
-- A rejected article that goes back to the customer travels through the SAME Warehouse workflow as every outgoing parcel.
-- It becomes a "return order" (orders.order_kind = 'return') linked to the article (return_unit_id): invoice (return shipping),
-- payment, courier booking, loadsheet, dispatch and delivery all work on it as on any order. The partner chooses its destination:
--   customer  Return Directly to Customer: Waiting for invoice > Awaiting payment > Paid > courier ... > Delivered
--   admin     Send to Admin: added to the partner's transfer to the admin warehouse (no invoice), the admin ships it on
-- The article itself is never copied: the return order only points at it. Safe to run more than once.
-- ==============================================================================

alter table public.orders add column if not exists order_kind text not null default 'order';
alter table public.orders drop constraint if exists orders_order_kind_check;
alter table public.orders add constraint orders_order_kind_check check (order_kind in ('order', 'return'));
alter table public.orders add column if not exists return_unit_id uuid references public.order_units(id) on delete set null;
alter table public.orders add column if not exists return_destination text;
alter table public.orders drop constraint if exists orders_return_destination_check;
alter table public.orders add constraint orders_return_destination_check check (return_destination is null or return_destination in ('customer', 'admin'));

-- one live return order per article
create unique index if not exists orders_one_live_return_per_unit_idx on public.orders (return_unit_id) where return_unit_id is not null and status <> 'cancelled';
create index if not exists orders_kind_idx on public.orders (order_kind) where order_kind <> 'order';

notify pgrst, 'reload schema';


-- Article weight, entered in Receiving. The invoice's shipping weight is the sum of the weights of the articles it covers.
alter table public.order_units add column if not exists weight_kg numeric(7,3);
do $$ begin
  alter table public.order_units add constraint order_units_weight_kg_check check (weight_kg is null or (weight_kg > 0 and weight_kg < 50));
exception when duplicate_object then null; end $$;


-- Orders made from an email (drafts) go to the default partner, so the partner's Receiving list and the admin Orders list show them
-- and the parcel can be received before the customer completes the order. Safe to run more than once.
UPDATE public.orders
   SET partner_id = (SELECT id FROM public.partners WHERE is_default AND status = 'active' LIMIT 1)
 WHERE status = 'draft'
   AND partner_id IS NULL
   AND EXISTS (SELECT 1 FROM public.partners WHERE is_default AND status = 'active');
