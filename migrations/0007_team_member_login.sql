-- ==============================================================================
-- 0007_team_member_login.sql
-- A master or tailor on the production board (team_members) can have their own login (profiles).
-- The link is team_members.user_id: one login per team member, one team member per login.
-- Safe to run more than once.
-- ==============================================================================
ALTER TABLE public.team_members ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES public.profiles(id) ON DELETE SET NULL;
CREATE UNIQUE INDEX IF NOT EXISTS team_members_user_idx ON public.team_members (user_id) WHERE user_id IS NOT NULL;
