import { supabaseAdmin } from '../config/supabase.js';
import { BadRequestError } from '../utils/error.helper.js';

/**
 * Shipping a parcel uses a courier from the managed list (Catalogue > Couriers), never free text.
 * Accepts `courier_id`, or a `courier` name that matches an active courier (older callers).
 * @returns {Promise<{ id: string, name: string }>}
 */
export const resolveCourier = async ({ courier_id: courierId, courier } = {}) => {
  if (courierId) {
    const { data } = await supabaseAdmin.from('couriers').select('id, name, status').eq('id', courierId).maybeSingle();
    if (!data) throw new BadRequestError('That courier was not found. Choose one from the list.');
    if (data.status !== 'active') throw new BadRequestError(`${data.name} is switched off. Choose another courier.`);
    return { id: data.id, name: data.name };
  }
  const name = String(courier ?? '').trim();
  if (!name) throw new BadRequestError('Choose a courier from the list.');
  const { data } = await supabaseAdmin.from('couriers').select('id, name, status').eq('status', 'active').ilike('name', name.replace(/[%_\\]/g, (c) => `\\${c}`)).limit(5);
  const found = (data || []).find((c) => c.name.trim().toLowerCase() === name.toLowerCase());
  if (!found) throw new BadRequestError(`"${name}" is not in the courier list. Choose a courier from the list (new ones are added under Catalogue > Couriers).`);
  return { id: found.id, name: found.name };
};
