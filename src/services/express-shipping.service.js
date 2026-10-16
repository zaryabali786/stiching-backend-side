import { supabaseAdmin } from '../config/supabase.js';

/**
 * Fast shipping (stored as 'express_shipping'), decided by the admin in Settings > Priority & fast:
 * whether customers can ask for it and how many days the delivery takes. It has NO price: it is never added to an order, an
 * invoice or any total. (An older saved price is ignored and dropped the next time the settings are saved.)
 */
const DEFAULTS = { enabled: true, days: 3 };

export const loadExpressShipping = async () => {
  const { data } = await supabaseAdmin.from('platform_settings').select('value').eq('key', 'express_shipping').maybeSingle();
  const v = data?.value || {};
  const days = Number(v.days);
  return { enabled: v.enabled === undefined ? DEFAULTS.enabled : v.enabled === true, days: Number.isInteger(days) && days >= 1 && days <= 90 ? days : DEFAULTS.days };
};

export const saveExpressShipping = async (body, userId) => {
  const days = Number(body.days);
  if (!Number.isInteger(days) || days < 1 || days > 90) throw Object.assign(new Error('Days must be a whole number from 1 to 90.'), { statusCode: 400, bad: true });
  const value = { enabled: body.enabled === true, days };
  const { error } = await supabaseAdmin.from('platform_settings').upsert({ key: 'express_shipping', value, updated_by: userId, updated_at: new Date().toISOString() });
  if (error) throw error;
  return loadExpressShipping();
};
