import { supabaseAdmin } from '../config/supabase.js';
import { config } from '../config/env.js';

/**
 * The central receiving address customers ship parcels to (until the admin assigns an order to a partner).
 * The admin edits it in Settings > Ship-to address (platform_settings 'ship_to'); the SHIP_TO_* environment values are only the fallback.
 */
const KEYS = ['shipToName', 'shipToAddress', 'shipToCity', 'shipToPhone'];
const clean = (v, max) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
const unset = (v) => !v || v.startsWith('[');

export const loadShipTo = async () => {
  const { data } = await supabaseAdmin.from('platform_settings').select('value').eq('key', 'ship_to').maybeSingle();
  const saved = data?.value || {};
  const out = {};
  for (const k of KEYS) out[k] = saved[k] !== undefined && saved[k] !== null && String(saved[k]).trim() !== '' ? String(saved[k]) : unset(config.platform[k]) ? '' : config.platform[k];
  return out;
};

export const saveShipTo = async (body, userId) => {
  const value = { shipToName: clean(body.name, 120), shipToAddress: clean(body.address, 300), shipToCity: clean(body.city, 80), shipToPhone: clean(body.phone, 40) };
  const { error } = await supabaseAdmin.from('platform_settings').upsert({ key: 'ship_to', value, updated_by: userId, updated_at: new Date().toISOString() });
  if (error) throw error;
  return loadShipTo();
};
