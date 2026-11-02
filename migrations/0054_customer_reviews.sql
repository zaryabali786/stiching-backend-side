-- ==============================================================================
-- 0054_customer_reviews.sql
-- Customer reviews. After an order is Delivered the customer gets one email (a few days later, set in Settings > Customer reviews,
-- separately for Pakistan and international orders) with a link to rate the order from 1 to 5 stars and leave a comment.
--   review_invitations  one row per delivered order: when the email is due, whether it went out, retries
--   order_reviews       one row per order: the customer's rating and comment (one review per order, enforced here)
-- The settings live in platform_settings (key 'review_settings'). Safe to run more than once. Run once in the Supabase SQL editor.
-- ==============================================================================

CREATE TABLE IF NOT EXISTS public.review_invitations (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id        UUID NOT NULL REFERENCES public.orders(id) ON DELETE CASCADE,
  customer_id     UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  customer_type   TEXT NOT NULL CHECK (customer_type IN ('national', 'international')),
  delivered_at    TIMESTAMPTZ NOT NULL,           -- the real Delivered moment; the due date is always counted from it
  scheduled_at    TIMESTAMPTZ NOT NULL,           -- delivered_at + the configured days (UTC)
  next_attempt_at TIMESTAMPTZ,                    -- after a failed send: not before this moment
  sent_at         TIMESTAMPTZ,
  status          TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'failed', 'cancelled')),
  cancel_reason   TEXT,
  retry_count     INT NOT NULL DEFAULT 0,
  last_error      TEXT,
  locked_until    TIMESTAMPTZ,                    -- a worker that is sending this row holds it until here
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT review_invitations_order_key UNIQUE (order_id)  -- one invitation per order, however often the status is written
);
CREATE INDEX IF NOT EXISTS review_invitations_due_idx ON public.review_invitations (status, scheduled_at);
CREATE INDEX IF NOT EXISTS review_invitations_customer_idx ON public.review_invitations (customer_id);

CREATE TABLE IF NOT EXISTS public.order_reviews (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id      UUID NOT NULL REFERENCES public.orders(id) ON DELETE CASCADE,
  customer_id   UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  rating        INT NOT NULL CHECK (rating BETWEEN 1 AND 5),
  comment       TEXT CHECK (comment IS NULL OR char_length(comment) <= 2000),
  customer_type TEXT NOT NULL CHECK (customer_type IN ('national', 'international')),
  delivered_at  TIMESTAMPTZ,
  source        TEXT NOT NULL DEFAULT 'email' CHECK (source IN ('email', 'app')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT order_reviews_order_key UNIQUE (order_id)       -- one review per order
);
CREATE INDEX IF NOT EXISTS order_reviews_created_idx ON public.order_reviews (created_at DESC);
CREATE INDEX IF NOT EXISTS order_reviews_rating_idx ON public.order_reviews (rating);
CREATE INDEX IF NOT EXISTS order_reviews_type_idx ON public.order_reviews (customer_type);
CREATE INDEX IF NOT EXISTS order_reviews_customer_idx ON public.order_reviews (customer_id);

-- Only the server (service role) reads and writes these tables.
ALTER TABLE public.review_invitations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.order_reviews ENABLE ROW LEVEL SECURITY;

INSERT INTO public.platform_settings (key, value)
VALUES ('review_settings', '{"nationalEnabled": true, "nationalReviewDays": 3, "internationalEnabled": true, "internationalReviewDays": 7}')
ON CONFLICT (key) DO NOTHING;
