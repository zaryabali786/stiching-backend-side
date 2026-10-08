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
