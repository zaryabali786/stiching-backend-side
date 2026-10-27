-- ==============================================================================
-- 0050_banner_focus.sql
-- Which part of a banner picture stays in view when the picture is cropped to the banner's
-- wide shape: the admin drags the picture, and the point they leave it at is kept here
-- (0 to 100 percent across and down; 50 / 50 is the middle, as before).
-- Safe to run more than once.
-- ==============================================================================
ALTER TABLE public.banners ADD COLUMN IF NOT EXISTS focus_x INTEGER NOT NULL DEFAULT 50;
ALTER TABLE public.banners ADD COLUMN IF NOT EXISTS focus_y INTEGER NOT NULL DEFAULT 50;
