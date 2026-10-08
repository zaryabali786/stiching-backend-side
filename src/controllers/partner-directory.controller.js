import { supabaseAdmin } from '../config/supabase.js';
import { config } from '../config/env.js';
import { catchAsync, ApiResponse } from '../utils/error.helper.js';
import { unwrap } from '../utils/db.js';

/** Platform defaults from the environment; an unset one is a [placeholder] and counts as empty. */
const fallback = (key) => {
  const v = config.platform?.[key] || '';
  return v.startsWith('[') ? '' : v;
};

/**
 * GET /api/client/partners — the stitching partners a customer can choose from when starting an order, each with the
 * address the parcel has to be sent to. `recommendedId` is the partner the platform would pick right now (lowest load).
 */
export const listClientPartners = catchAsync(async (req, res) => {
  const [rows, pick] = await Promise.all([
    supabaseAdmin
      .from('partners')
      .select('id, name, short_code, city, tagline, turnaround_days, receiving_name, receiving_address, receiving_city, receiving_phone, permissions')
      .eq('status', 'active')
      .eq('is_listed', true)
      .order('name', { ascending: true }),
    supabaseAdmin.rpc('pick_partner_for_new_order'),
  ]);
  const partners = unwrap(rows, 'Could not load the partners').filter((p) => (p.permissions || []).includes('receiving.view'));
  const recommendedId = !pick.error && partners.some((p) => p.id === pick.data) ? pick.data : partners[0]?.id ?? null;
  const items = partners.map(({ permissions, ...p }) => ({
    id: p.id,
    name: p.name,
    short_code: p.short_code,
    city: p.city,
    tagline: p.tagline,
    turnaround_days: p.turnaround_days,
    recommended: p.id === recommendedId,
    // a partner that has not filled in its address yet falls back to the platform's default receiving address
    receiving: {
      name: p.receiving_name || fallback('shipToName') || p.name,
      address: p.receiving_address || fallback('shipToAddress') || '',
      city: p.receiving_city || p.city || fallback('shipToCity') || '',
      phone: p.receiving_phone || fallback('shipToPhone') || '',
    },
  }));
  return ApiResponse.success(res, { items, recommendedId });
});
