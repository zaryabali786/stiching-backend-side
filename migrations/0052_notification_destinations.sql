-- ==============================================================================
-- 0052_notification_destinations.sql
-- A Notification Center message can lead somewhere when it is tapped: a page of the app (optionally one order), a Shop product,
-- or an approved address. It is stored as one validated JSON document on the broadcast and copied to each person's notification.
--   { type: 'page'|'product'|'url', page?, entity_type?, entity_id?, entity_ref?, product_id?, store_id?, url?, external?, label }
-- NULL = no destination: every existing notification keeps working exactly as before. Run once in the Supabase SQL editor.
-- ==============================================================================

ALTER TABLE public.broadcasts ADD COLUMN IF NOT EXISTS destination JSONB;
ALTER TABLE public.notifications ADD COLUMN IF NOT EXISTS destination JSONB;
