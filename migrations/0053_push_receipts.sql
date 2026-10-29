-- ==============================================================================
-- 0053_push_receipts.sql
-- A Notification Center push is now sent to MOBILE devices only (Android and iPhone). Firebase answers each accepted push with a
-- message id: it is kept next to the delivery so a push can be traced in the Firebase console and in the logs.
-- (Firebase gives no "delivered to the phone" receipt, so 'sent' means: accepted by Firebase for at least one device.)
-- NULL / empty = no push was accepted for this person. Safe to run more than once. Run once in the Supabase SQL editor.
-- ==============================================================================

ALTER TABLE public.broadcast_deliveries ADD COLUMN IF NOT EXISTS push_message_ids TEXT[];
