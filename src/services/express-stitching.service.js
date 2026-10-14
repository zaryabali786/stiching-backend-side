import { supabaseAdmin } from '../config/supabase.js';

/**
 * Express stitching, decided by the admin in Settings > Express stitching (platform_settings 'express_stitching'):
 * whether customers can ask for it and how many days an express order takes.
 */
const DEFAULTS = { enabled: true, days: 5 };

export const loadExpressStitching = async () => {
  const { data } = await supabaseAdmin.from('platform_settings').select('value').eq('key', 'express_stitching').maybeSingle();
  const v = data?.value || {};
  const days = Number(v.days);
  return { enabled: v.enabled === undefined ? DEFAULTS.enabled : v.enabled === true, days: Number.isInteger(days) && days >= 1 && days <= 90 ? days : DEFAULTS.days };
};

export const saveExpressStitching = async (body, userId) => {
  const days = Number(body.days);
  if (!Number.isInteger(days) || days < 1 || days > 90) throw Object.assign(new Error('Days must be a whole number from 1 to 90.'), { statusCode: 400, bad: true });
  const value = { enabled: body.enabled === true, days };
  const { error } = await supabaseAdmin.from('platform_settings').upsert({ key: 'express_stitching', value, updated_by: userId, updated_at: new Date().toISOString() });
  if (error) throw error;
  return loadExpressStitching();
};

/** The due date for an order created at `from` that takes `days` days. */
export const dueAfter = (from, days) => {
  const d = new Date(from);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};
