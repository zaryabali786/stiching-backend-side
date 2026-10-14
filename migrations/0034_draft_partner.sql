-- Orders made from an email (drafts) go to the default partner, so the partner's Receiving list and the admin Orders list show them
-- and the parcel can be received before the customer completes the order. Safe to run more than once.
UPDATE public.orders
   SET partner_id = (SELECT id FROM public.partners WHERE is_default AND status = 'active' LIMIT 1)
 WHERE status = 'draft'
   AND partner_id IS NULL
   AND EXISTS (SELECT 1 FROM public.partners WHERE is_default AND status = 'active');
