import { supabaseAdmin } from '../config/supabase.js';
import { unwrap } from '../utils/db.js';
import { addEvent } from './order.service.js';

/**
 * Add a paid order to the partner's open transfer to the admin warehouse (one open transfer per partner: parcels of different partners are
 * never batched together). Used by the Warehouse "Send to admin warehouse" choice and by a return that is sent to the admin.
 */
export const addOrderToTransfer = async ({ order, userId }) => {
  let openQuery = supabaseAdmin.from('transfers').select('*').eq('status', 'open').order('created_at').limit(1);
  openQuery = order.partner_id ? openQuery.eq('partner_id', order.partner_id) : openQuery.is('partner_id', null);
  let transfer = unwrap(await openQuery.maybeSingle());
  if (!transfer) transfer = unwrap(await supabaseAdmin.from('transfers').insert({ status: 'open', created_by: userId ?? null, partner_id: order.partner_id }).select('*').single());
  unwrap(await supabaseAdmin.from('orders').update({ partner_route: 'admin_warehouse', transfer_id: transfer.id, updated_at: new Date().toISOString() }).eq('id', order.id));
  await addEvent(order.id, order.status, `Added to transfer ${transfer.code} for the dispatch warehouse`, userId ?? null);
  return transfer;
};
