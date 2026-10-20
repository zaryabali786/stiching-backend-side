-- Optional text message to the customer of a Shopify order ("add your sizes"), next to the email.
-- The phone number is kept only until the text was sent (it is the customer's own number from the brand's order).
ALTER TABLE public.shopify_orders ADD COLUMN IF NOT EXISTS customer_phone TEXT;
ALTER TABLE public.shopify_orders ADD COLUMN IF NOT EXISTS sms_notified_at TIMESTAMPTZ;
