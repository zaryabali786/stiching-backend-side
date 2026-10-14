import { supabaseAdmin } from '../config/supabase.js';

/**
 * A shared (standard) article may have no price of its own. The price a partner set on its own copy of the same article tells the
 * customer what to expect: the default partner's price, else the lowest one. Used by the article lists of the order form and by the
 * saved customizations of an order, so Create and Edit show the same price.
 * @param {{ name: string, type_name: string|null, customer_price: number|null }[]} items
 * @returns {Promise<Map<string, number>>} price by "type name|article name" (lower case) for the items that had none
 */
export const fallbackPrices = async (items) => {
  const missing = items.filter((a) => a.customer_price == null && a.name && a.type_name);
  const out = new Map();
  if (!missing.length) return out;
  const names = [...new Set(missing.map((a) => a.name))];
  const [theirs, defaults] = await Promise.all([
    supabaseAdmin.from('articles').select('name, customer_price, partner_id, type:article_types!inner(name)').in('name', names).not('partner_id', 'is', null).not('customer_price', 'is', null),
    supabaseAdmin.from('partners').select('id').eq('is_default', true),
  ]);
  const defaultIds = new Set((defaults.data || []).map((p) => p.id));
  const best = new Map();
  for (const t of theirs.data || []) {
    const typeName = (Array.isArray(t.type) ? t.type[0]?.name : t.type?.name) ?? '';
    const key = `${typeName.trim().toLowerCase()}|${t.name.trim().toLowerCase()}`;
    const cur = best.get(key);
    const isDefault = defaultIds.has(t.partner_id);
    const better = !cur || (isDefault && !cur.isDefault) || (isDefault === cur.isDefault && Number(t.customer_price) < cur.price);
    if (better) best.set(key, { price: Number(t.customer_price), isDefault });
  }
  for (const a of missing) {
    const key = `${a.type_name.trim().toLowerCase()}|${a.name.trim().toLowerCase()}`;
    if (best.has(key)) out.set(key, best.get(key).price);
  }
  return out;
};

export const priceKey = (typeName, name) => `${String(typeName ?? '').trim().toLowerCase()}|${String(name ?? '').trim().toLowerCase()}`;
