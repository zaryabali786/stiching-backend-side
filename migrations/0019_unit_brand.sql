-- ==============================================================================
-- 0019_unit_brand.sql
-- Orders made "direct from customer" name the brand per article (each article can come from a different brand).
-- The order keeps the first article's brand as its own brand. Safe to run more than once.
-- ==============================================================================
ALTER TABLE public.order_units ADD COLUMN IF NOT EXISTS brand_id UUID REFERENCES public.brands(id) ON DELETE SET NULL;
ALTER TABLE public.order_units ADD COLUMN IF NOT EXISTS brand TEXT;
