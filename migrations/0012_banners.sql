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
