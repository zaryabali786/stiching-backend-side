-- ==============================================================================
-- 0010_inbox.sql
-- Every customer has their own shopping address (profiles.inbound_email_token ->
-- <token>@<INBOUND_EMAIL_DOMAIN>). Every email that arrives there is kept here so
-- the customer can read it in the app (order confirmations, tracking updates,
-- verification codes ...). Order-like emails also get an order_imports draft.
-- Safe to run more than once.
-- ==============================================================================

CREATE TABLE IF NOT EXISTS public.inbox_emails (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  customer_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  -- the mail provider's id for the message: a retried delivery is stored only once
  message_id TEXT,
  email_from TEXT,
  email_to TEXT,
  subject TEXT,
  body_text TEXT,
  body_html TEXT,
  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  is_read BOOLEAN NOT NULL DEFAULT FALSE,
  -- draft read from this email when it looked like an order confirmation
  import_id UUID REFERENCES public.order_imports(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS inbox_emails_message_idx
  ON public.inbox_emails (customer_id, message_id) WHERE message_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS inbox_emails_customer_idx
  ON public.inbox_emails (customer_id, received_at DESC);
CREATE INDEX IF NOT EXISTS inbox_emails_unread_idx
  ON public.inbox_emails (customer_id) WHERE is_read = FALSE;

ALTER TABLE public.inbox_emails ENABLE ROW LEVEL SECURITY;

-- Customers read their own mail; all writes go through the backend (service role)
DROP POLICY IF EXISTS "inbox_emails_own_select" ON public.inbox_emails;
CREATE POLICY "inbox_emails_own_select" ON public.inbox_emails FOR SELECT USING (auth.uid() = customer_id);
DROP POLICY IF EXISTS "inbox_emails_admin" ON public.inbox_emails;
CREATE POLICY "inbox_emails_admin" ON public.inbox_emails FOR ALL USING (public.is_admin()) WITH CHECK (public.is_admin());
