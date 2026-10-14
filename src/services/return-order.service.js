import { supabaseAdmin } from '../config/supabase.js';
import { BadRequestError, ConflictError } from '../utils/error.helper.js';
import { unwrap } from '../utils/db.js';
import { notifyUser } from './notification.service.js';
import { addEvent, logUnitEvent, onOrderStatusChange, STATUS_LABELS } from './order.service.js';
import { markSentBack, emitUnitUpdate, syncReviewFlag } from './unit-review.service.js';
import { addOrderToTransfer } from './transfer.service.js';
import { ARTICLE_STATE_LABELS } from './unit-flow.service.js';
import { localPhone } from './postex.service.js';

/**
 * A rejected article that must go back to the customer is handled in the Warehouse, like any outgoing parcel.
 * The partner chooses its destination:
 *   customer  Return Directly to Customer: a return order that waits for its invoice (return shipping), payment, courier booking,
 *             loadsheet, dispatch and delivery, exactly as a normal order does.
 *   admin     Send to Admin: the return order joins the partner's transfer to the admin warehouse (no invoice); the admin receives it
 *             and ships it on with the existing admin warehouse steps.
 * The article is not copied: the return order (orders.order_kind = 'return') points at it with return_unit_id. When the return order is
 * shipped or delivered, the article's own return status follows (sent back, then returned).
 */

const liveReturnOrderOf = async (unitId) =>
  (await supabaseAdmin.from('orders').select('*').eq('return_unit_id', unitId).neq('status', 'cancelled').maybeSingle()).data || null;

const liveLegacyShipmentOf = async (unitId) =>
  (await supabaseAdmin.from('return_shipments').select('id').eq('unit_id', unitId).neq('status', 'cancelled').maybeSingle()).data || null;

export { liveReturnOrderOf };

/** Is this article already on its way through the Warehouse (or booked the old way)? Used to keep the two ways from clashing. */
export const returnIsRouted = async (unitId) => !!(await liveReturnOrderOf(unitId)) || !!(await liveLegacyShipmentOf(unitId));

/**
 * @param {{ order: object, unit: object, destination: 'customer'|'admin', profile: { id: string } }} input
 * @returns {Promise<object>} the return order
 */
export const createReturnOrder = async ({ order, unit, destination, profile }) => {
  if (!['customer', 'admin'].includes(destination)) throw new BadRequestError('Choose Send to Admin or Return Directly to Customer.');
  if (unit.review_status !== 'rejected' || unit.return_status !== 'requested') throw new BadRequestError('Only an article the customer asked to return can be routed.');
  if (await liveReturnOrderOf(unit.id)) throw new ConflictError('This return is already in the Warehouse.');
  if (await liveLegacyShipmentOf(unit.id)) throw new ConflictError('This return already has a courier booking.');

  const ship = unit.return_shipping || {};
  if (destination === 'customer') {
    if (unit.return_to !== 'customer') throw new BadRequestError('The customer asked for this return to go to the brand, not to them. Use Send to Admin.');
    if (!String(ship.address || '').trim() || !String(ship.city || '').trim()) throw new BadRequestError('The return address is missing. Ask the customer to confirm it.');
    if (!/^03\d{9}$/.test(localPhone(ship.phone))) throw new BadRequestError('The customer gave no valid phone number for this return.');
  }

  const now = new Date().toISOString();
  const reference = `${unit.code || `${order.reference}-${unit.line_no ?? 1}`}-RET`;
  const row = {
    reference,
    order_kind: 'return',
    return_unit_id: unit.id,
    return_destination: destination,
    customer_id: order.customer_id,
    customer_name: String(ship.name || '').trim() || order.customer_name,
    customer_code: order.customer_code,
    brand: order.brand,
    partner_id: order.partner_id ?? null,
    // it is packed (waiting for its invoice) when it goes to the customer, and paid-and-ready when it goes to the admin warehouse
    status: destination === 'admin' ? 'paid' : 'packed',
    packed_at: now,
    destination_country: ship.country || order.destination_country || null,
    destination_city: ship.city || order.destination_city || null,
    destination_address: ship.address || order.destination_address || null,
    destination_phone: ship.phone || order.destination_phone || null,
    // the weight of the one article it carries (the invoice weighs from the article)
    ...(Number(unit.weight_kg) > 0 ? { weight_kg: Number(unit.weight_kg) } : {}),
    shipping_service: order.shipping_service || 'standard',
    international_shipping: order.international_shipping ?? null,
    priority: 'normal',
    order_source: 'customer',
    details_completed_at: now,
    customer_notes: `Return of ${unit.unit_title} (${order.reference})${unit.review_note ? `: ${String(unit.review_note).slice(0, 300)}` : ''}`,
  };
  const { data: created, error } = await supabaseAdmin.from('orders').insert(row).select('*').single();
  if (error) {
    if (error.code === '23505') throw new ConflictError('This return is already in the Warehouse.');
    throw error;
  }

  if (destination === 'admin') await addOrderToTransfer({ order: created, userId: profile.id });
  const where = destination === 'admin' ? 'sent to the admin warehouse' : 'to be returned directly to the customer (invoice, payment, courier)';
  await logUnitEvent(unit.id, order.id, 'return_routed', { note: destination === 'admin' ? 'Send to Admin' : 'Return directly to the customer', actorId: profile.id });
  await addEvent(order.id, order.status, `Return of ${unit.unit_title} ${where} · ${reference}`, profile.id);
  await addEvent(created.id, created.status, `Return of ${unit.unit_title} from ${order.reference}`, profile.id);
  await notifyUser(order.customer_id, {
    type: 'update',
    title: `Your return is being prepared: ${order.reference}`,
    body: destination === 'admin'
      ? `${unit.unit_title} is on its way to our admin warehouse and will be sent back to you from there.`
      : `${unit.unit_title} will be sent back to you. We will send an invoice for the return shipping first (${reference}).`,
    link: `/app/orders/${created.id}`,
    orderId: created.id,
  }).catch(() => {});
  emitUnitUpdate(order, unit, { state: 'return_requested', stateLabel: ARTICLE_STATE_LABELS.return_requested, returnOrder: reference });
  return created;
};

/** The return orders of some articles, for the partner's Receiving list. */
export const returnOrdersForUnits = async (unitIds) => {
  if (!unitIds.length) return new Map();
  const rows = unwrap(await supabaseAdmin.from('orders').select('id, reference, status, return_unit_id, return_destination').in('return_unit_id', unitIds).neq('status', 'cancelled'));
  return new Map(rows.map((o) => [o.return_unit_id, { id: o.id, reference: o.reference, status: o.status, status_label: STATUS_LABELS[o.status] || o.status, destination: o.return_destination }]));
};

/** When a return order is shipped / delivered, the article's own return status follows (the same states as the courier return used). */
const followReturnOrder = async (order, status, { actorId } = {}) => {
  if (order.order_kind !== 'return' || !order.return_unit_id || !['shipped', 'delivered'].includes(status)) return;
  const unit = (await supabaseAdmin.from('order_units').select('*').eq('id', order.return_unit_id).maybeSingle()).data;
  if (!unit) return;
  const original = (await supabaseAdmin.from('orders').select('*').eq('id', unit.order_id).maybeSingle()).data;
  if (!original) return;
  const shipment = (await supabaseAdmin.from('shipments').select('courier, tracking_number').eq('order_id', order.id).maybeSingle()).data;

  if (status === 'shipped') {
    if (unit.return_status !== 'requested') return;
    await markSentBack({ order: original, unit, courier: shipment?.courier, tracking: shipment?.tracking_number, profile: { id: actorId ?? null } });
    return;
  }
  const now = new Date().toISOString();
  const { data } = await supabaseAdmin.from('order_units').update({ return_status: 'returned', return_updated_at: now, updated_at: now }).eq('id', unit.id).in('return_status', ['requested', 'sent_back']).select('id').maybeSingle();
  if (!data) return;
  await logUnitEvent(unit.id, original.id, 'return_delivered', { note: [shipment?.courier, shipment?.tracking_number].filter(Boolean).join(' · ') || null, actorId: actorId ?? null });
  await addEvent(original.id, original.status, `${unit.unit_title} returned: delivered to the customer (${order.reference})`, actorId ?? null);
  await syncReviewFlag(original.id);
  await notifyUser(original.customer_id, { type: 'update', title: `Return delivered: ${original.reference}`, body: `${unit.unit_title} was delivered to you.`, link: `/app/orders/${original.id}`, orderId: original.id }).catch(() => {});
  emitUnitUpdate(original, unit, { state: 'returned', stateLabel: 'Returned', returnStatus: 'returned' });
};

onOrderStatusChange(followReturnOrder);
export { followReturnOrder };
