-- Push notification devices: one row per phone / browser token, always owned by exactly one user.
-- A token is unique: when someone else signs in on the same phone the row moves to them (and sign-out removes it),
-- so a notification only ever reaches the devices of the person it was written for.
CREATE TABLE IF NOT EXISTS public.push_devices (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  token TEXT NOT NULL UNIQUE,
  platform TEXT NOT NULL DEFAULT 'web' CHECK (platform IN ('android', 'ios', 'web')),
  app TEXT NOT NULL DEFAULT 'client' CHECK (app IN ('client', 'admin')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS push_devices_user_idx ON public.push_devices (user_id);

-- only the API (service role) reads or writes this table
ALTER TABLE public.push_devices ENABLE ROW LEVEL SECURITY;
