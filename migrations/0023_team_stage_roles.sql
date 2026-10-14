-- ==============================================================================
-- 0023_team_stage_roles.sql
-- The team page can hold the people of every production stage, not only masters and tailors:
-- quality check (qa), pressing and packing. Each can get their own login (staff type = the role) and scan articles.
-- Safe to run more than once.
-- ==============================================================================
ALTER TABLE public.team_members DROP CONSTRAINT IF EXISTS team_members_role_check;
ALTER TABLE public.team_members ADD CONSTRAINT team_members_role_check CHECK (role IN ('master', 'tailor', 'qa', 'pressing', 'packing'));

NOTIFY pgrst, 'reload schema';
