import { supabaseAdmin } from '../config/supabase.js';

/**
 * Express shipping, decided by the admin in Settings > Express (platform_settings 'express_shipping'):
 * whether customers can ask for it and how many days the delivery takes.
 */
const DEFAULTS = { enabled: true, days: 3 };

export const loadExpressShipping = async () => {
  const { data } = await supabaseAdmin.from('platform_settings').select('value').eq('key', 'express_shipping').maybeSingle();
  const v = data?.value || {};
  const days = Number(v.days);
  const price = Number(v.price_pkr);
  return { enabled: v.enabled === undefined ? DEFAULTS.enabled : v.enabled === true, days: Number.isInteger(days) && days >= 1 && days <= 90 ? days : DEFAULTS.days, price_pkr: Number.isFinite(price) && price >= 0 ? Math.round(price * 100) / 100 : 0 };
};

export const saveExpressShipping = async (body, userId) => {
  const days = Number(body.days);
  if (!Number.isInteger(days) || days < 1 || days > 90) throw Object.assign(new Error('Days must be a whole number from 1 to 90.'), { statusCode: 400, bad: true });
  const price = body.price_pkr === undefined || body.price_pkr === '' || body.price_pkr === null ? 0 : Number(body.price_pkr);
  if (!Number.isFinite(price) || price < 0 || price > 10000000) throw Object.assign(new Error('The price must be 0 or more.'), { statusCode: 400, bad: true });
  const value = { enabled: body.enabled === true, days, price_pkr: Math.round(price * 100) / 100 };
  const { error } = await supabaseAdmin.from('platform_settings').upsert({ key: 'express_shipping', value, updated_by: userId, updated_at: new Date().toISOString() });
  if (error) throw error;
  return loadExpressShipping();
};
