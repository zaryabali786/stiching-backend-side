-- ==============================================================================
-- 0018_support_chat.sql
-- A general chat between a customer and the admin team, not tied to any order
-- (the chat button outside an order page). One thread per customer.
-- Safe to run more than once.
-- ==============================================================================
CREATE TABLE IF NOT EXISTS public.support_messages (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  customer_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  sender_id UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  sender_role TEXT NOT NULL CHECK (sender_role IN ('customer', 'admin')),
  body TEXT NOT NULL CHECK (char_length(btrim(body)) > 0 AND char_length(body) <= 4000),
  -- lets a client safely retry a send without creating duplicates
  client_msg_id TEXT,
  -- set when the other side has opened the conversation
  read_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS support_messages_thread_idx ON public.support_messages (customer_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS support_messages_unread_idx ON public.support_messages (customer_id, sender_role) WHERE read_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS support_messages_client_msg_idx
  ON public.support_messages (customer_id, sender_id, client_msg_id) WHERE client_msg_id IS NOT NULL;
ALTER TABLE public.support_messages ENABLE ROW LEVEL SECURITY;
