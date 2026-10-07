-- ==============================================================================
-- 0006_staff_type.sql
-- A partner's users are typed: master, tailor or other staff. The type is shown in the portals and lets the
-- partner start from sensible default permissions; what a user may actually do is still profiles.permissions
-- (always within the partner's own modules). Safe to run more than once.
-- ==============================================================================
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS staff_type TEXT;

DO $$ BEGIN
  ALTER TABLE public.profiles ADD CONSTRAINT profiles_staff_type_check
    CHECK (staff_type IS NULL OR staff_type IN ('master', 'tailor', 'staff'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- existing partner users: derive the type from the job title they were given
UPDATE public.profiles
   SET staff_type = CASE
         WHEN job_title ILIKE '%master%' THEN 'master'
         WHEN job_title ILIKE '%tailor%' THEN 'tailor'
         ELSE 'staff'
       END
 WHERE role = 'partner_staff' AND partner_role = 'member' AND staff_type IS NULL;

CREATE INDEX IF NOT EXISTS profiles_partner_type_idx ON public.profiles (partner_id, staff_type) WHERE partner_id IS NOT NULL;
