-- How the customer paid the brand (read from the order confirmation email). Never guessed: empty when the email does not say.
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS brand_payment_method TEXT;
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS brand_payment_status TEXT;
DO $$ BEGIN
  ALTER TABLE public.orders ADD CONSTRAINT orders_brand_payment_status_check CHECK (brand_payment_status IS NULL OR brand_payment_status IN ('paid', 'pending'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
