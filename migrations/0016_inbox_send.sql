-- Customers can now write and reply to emails from the app. Sent mail is kept in the same table.
ALTER TABLE public.inbox_emails ADD COLUMN IF NOT EXISTS direction TEXT NOT NULL DEFAULT 'in';
ALTER TABLE public.inbox_emails ADD COLUMN IF NOT EXISTS attachments JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE public.inbox_emails ADD COLUMN IF NOT EXISTS reply_to_id UUID REFERENCES public.inbox_emails(id) ON DELETE SET NULL;
DO $$ BEGIN
  ALTER TABLE public.inbox_emails ADD CONSTRAINT inbox_emails_direction_chk CHECK (direction IN ('in', 'out'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS inbox_emails_direction_idx ON public.inbox_emails (customer_id, direction, received_at DESC);
NOTIFY pgrst, 'reload schema';
