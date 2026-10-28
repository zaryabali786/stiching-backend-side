-- ==============================================================================
-- 0051_notification_center.sql
-- Notification Center: broadcasts (one row per message an admin or a partner sends), one delivery row per
-- recipient (so a retry or a restart never sends twice), and the extra fields a notification carries
-- (urgent flag, picture, which broadcast it came from).
-- Run once in the Supabase SQL editor.
-- ==============================================================================

CREATE TABLE IF NOT EXISTS public.broadcasts (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  created_by UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  -- set when a partner sent it: that partner owns it and alone sees it; NULL = sent by the admin
  partner_id UUID REFERENCES public.partners(id) ON DELETE CASCADE,
  -- { category: clients|staff|partners, mode: all|selected|filter, ids: [], partner_ids: [], staff_types: [], include_subordinates: bool }
  audience JSONB NOT NULL,
  category TEXT NOT NULL CHECK (category IN ('clients', 'staff', 'partners')),
  title TEXT NOT NULL CHECK (char_length(btrim(title)) BETWEEN 1 AND 120),
  body TEXT NOT NULL CHECK (char_length(btrim(body)) BETWEEN 1 AND 1000),
  image_url TEXT,
  image_path TEXT,
  priority TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('normal', 'urgent')),
  channels TEXT[] NOT NULL DEFAULT '{web}',
  -- scheduled -> processing -> sent | partial | failed ;  scheduled -> cancelled
  status TEXT NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled', 'processing', 'sent', 'partial', 'failed', 'cancelled')),
  -- when it goes out (UTC); a notification sent at once has it set to its creation time
  send_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  is_scheduled BOOLEAN NOT NULL DEFAULT FALSE,
  timezone TEXT,
  claimed_at TIMESTAMPTZ,
  sent_at TIMESTAMPTZ,
  attempts INTEGER NOT NULL DEFAULT 0,
  recipient_count INTEGER NOT NULL DEFAULT 0,
  web_sent INTEGER NOT NULL DEFAULT 0,
  web_failed INTEGER NOT NULL DEFAULT 0,
  push_sent INTEGER NOT NULL DEFAULT 0,
  push_failed INTEGER NOT NULL DEFAULT 0,
  push_no_device INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS broadcasts_due_idx ON public.broadcasts (send_at) WHERE status = 'scheduled';
CREATE INDEX IF NOT EXISTS broadcasts_partner_idx ON public.broadcasts (partner_id, created_at DESC);
CREATE INDEX IF NOT EXISTS broadcasts_history_idx ON public.broadcasts (created_at DESC);

DROP TRIGGER IF EXISTS trg_broadcasts_updated ON public.broadcasts;
CREATE TRIGGER trg_broadcasts_updated BEFORE UPDATE ON public.broadcasts FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

CREATE TABLE IF NOT EXISTS public.broadcast_deliveries (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  broadcast_id UUID NOT NULL REFERENCES public.broadcasts(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  notification_id UUID,
  web_status TEXT CHECK (web_status IN ('sent', 'failed', 'skipped')),
  push_status TEXT CHECK (push_status IN ('sent', 'failed', 'no_device', 'skipped')),
  push_devices INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- one row per person per broadcast: a retry or a second worker can never deliver it twice
  UNIQUE (broadcast_id, user_id)
);
CREATE INDEX IF NOT EXISTS broadcast_deliveries_broadcast_idx ON public.broadcast_deliveries (broadcast_id);

-- what a notification carries: urgent flag, a picture, and the broadcast it came from
ALTER TABLE public.notifications ADD COLUMN IF NOT EXISTS priority TEXT NOT NULL DEFAULT 'normal';
ALTER TABLE public.notifications ADD COLUMN IF NOT EXISTS image_url TEXT;
ALTER TABLE public.notifications ADD COLUMN IF NOT EXISTS broadcast_id UUID REFERENCES public.broadcasts(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS notifications_broadcast_idx ON public.notifications (broadcast_id) WHERE broadcast_id IS NOT NULL;

-- only the API (service role) reads or writes these tables
ALTER TABLE public.broadcasts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.broadcast_deliveries ENABLE ROW LEVEL SECURITY;
