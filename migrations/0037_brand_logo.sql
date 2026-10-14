-- A logo for each brand (uploaded in Catalogue > Brands), shown next to the brand's orders. Safe to run more than once.
ALTER TABLE public.brands ADD COLUMN IF NOT EXISTS logo_url TEXT;
ALTER TABLE public.brands ADD COLUMN IF NOT EXISTS logo_path TEXT;
NOTIFY pgrst, 'reload schema';
