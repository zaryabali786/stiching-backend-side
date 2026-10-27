-- ==============================================================================
-- 0048_support_voice.sql
-- Voice messages in the general chat between a customer and the admin team.
-- A voice message has kind = 'voice', no text, and its recording in `audio`
-- ({ path, mime, duration, size }; the file sits in the private bucket).
-- Safe to run more than once.
-- ==============================================================================
ALTER TABLE public.support_messages ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'text';
ALTER TABLE public.support_messages ADD COLUMN IF NOT EXISTS audio JSONB;
ALTER TABLE public.support_messages ALTER COLUMN body DROP NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'support_messages_kind_check') THEN
    ALTER TABLE public.support_messages ADD CONSTRAINT support_messages_kind_check CHECK (kind IN ('text', 'voice'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'support_messages_content_check') THEN
    ALTER TABLE public.support_messages ADD CONSTRAINT support_messages_content_check CHECK (
      (kind = 'text' AND body IS NOT NULL AND char_length(btrim(body)) > 0 AND char_length(body) <= 4000)
      OR (kind = 'voice' AND audio IS NOT NULL)
    );
  END IF;
END $$;
