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
