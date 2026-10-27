-- ==============================================================================
-- 0049_banner_text.sql
-- Text and a button on a home banner: a heading, a small text, a button (its words and
-- where it goes), the text colour, a dark layer behind the text and where the text sits.
-- Safe to run more than once.
-- ==============================================================================
ALTER TABLE public.banners ADD COLUMN IF NOT EXISTS heading TEXT;
ALTER TABLE public.banners ADD COLUMN IF NOT EXISTS subheading TEXT;
ALTER TABLE public.banners ADD COLUMN IF NOT EXISTS button_label TEXT;
ALTER TABLE public.banners ADD COLUMN IF NOT EXISTS button_link TEXT;
ALTER TABLE public.banners ADD COLUMN IF NOT EXISTS text_color TEXT NOT NULL DEFAULT '#FFFFFF';
ALTER TABLE public.banners ADD COLUMN IF NOT EXISTS button_bg TEXT NOT NULL DEFAULT '#FFFFFF';
ALTER TABLE public.banners ADD COLUMN IF NOT EXISTS button_color TEXT NOT NULL DEFAULT '#62003E';
ALTER TABLE public.banners ADD COLUMN IF NOT EXISTS overlay INTEGER NOT NULL DEFAULT 35;
ALTER TABLE public.banners ADD COLUMN IF NOT EXISTS text_align TEXT NOT NULL DEFAULT 'left';
