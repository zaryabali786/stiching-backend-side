-- Express shipping: the customer can ask for the finished order to be delivered faster. The admin decides how many days it takes
-- (Settings > Express). Safe to run more than once.
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS express_shipping BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS express_shipping_days INTEGER;
DO $$ BEGIN
  ALTER TABLE public.orders ADD CONSTRAINT orders_express_shipping_days_check CHECK (express_shipping_days IS NULL OR express_shipping_days BETWEEN 1 AND 90);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
NOTIFY pgrst, 'reload schema';
