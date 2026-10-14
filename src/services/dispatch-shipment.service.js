import { supabaseAdmin } from '../config/supabase.js';
import { BadRequestError, ConflictError, ForbiddenError } from '../utils/error.helper.js';
import { unwrap } from '../utils/db.js';
import { notifyUser } from './notification.service.js';
import { addEvent, setOrderStatus } from './order.service.js';
import { resolveCourier } from './courier.service.js';
import { obtainCn, cancelWithProvider } from './courier-provider.service.js';
import { loadsheetCsv } from './return-shipment.service.js';
import { emitTo, rooms } from '../realtime/io.js';

/**
 * Direct dispatch from the partner warehouse, one shipment per order (the `shipments` table):
 *
 *   needs_label ──book CN──> booked ──loadsheet downloaded──> labelled ──handover confirmed──> handed_to_courier (Dispatched)
 *        └ cancel booking ┘                                                      │
 *                                          in_transit ◄──────────────────────────┤
 *                                          delivered (Delivered) · failed_delivery (still Dispatched)
 *                                          returning_to_partner (Failed delivery tab) ──partner confirms──> returned_to_partner
 *
 * The order only becomes Shipped when the handover is confirmed, and Delivered only from a delivery tracking event.
 * A failed attempt is not a return: the parcel only leaves Dispatched when the courier confirms it is coming back.
 */

export const DISPATCH_LABELS = {
  needs_label: 'Paid · no courier booked',
  booked: 'CN booked · ready for dispatch',
  labelled: 'Loadsheet downloaded · confirm handover',
  handed_to_courier: 'Dispatched',
  in_transit: 'In transit',
  delivered: 'Delivered',
  failed_delivery: 'Delivery attempt failed',
  returning_to_partner: 'Returning to the partner',
  returned_to_partner: 'Received back by the partner',
};

const loadShipment = async (id) => (await supabaseAdmin.from('shipments').select('*').eq('id', id).maybeSingle()).data || null;
const loadOrder = async (id) => (await supabaseAdmin.from('orders').select('*').eq('id', id).maybeSingle()).data || null;

export const emitShipmentUpdate = (order, shipment, extra = {}) => {
  const payload = { orderId: order.id, reference: order.reference, shipmentId: shipment?.id ?? null, status: shipment?.status ?? null, label: DISPATCH_LABELS[shipment?.status] ?? null, ...extra, at: new Date().toISOString() };
  emitTo(rooms.user(order.customer_id), 'shipment:update', payload);
  emitTo(rooms.admins, 'shipment:update', payload);
  if (order.partner_id) emitTo(rooms.production(order.partner_id), 'shipment:update', payload);
};

export const addShipmentEvent = async ({ shipmentId, status, note, source, eventId, occurredAt, userId }) => {
  const { error } = await supabaseAdmin.from('shipment_events').insert({
    shipment_id: shipmentId, status, note: note ? String(note).slice(0, 300) : null, source, event_id: eventId || null,
    occurred_at: occurredAt || new Date().toISOString(), created_by: userId || null,
  });
  if (error) {
    if (error.code === '23505') return false;
    throw error;
  }
  return true;
};

/** The invoice of the order must really be paid: the parcel never moves on the order's status alone. */
const assertPaid = async (order) => {
  const inv = (await supabaseAdmin.from('invoices').select('id, status').eq('order_id', order.id).maybeSingle()).data;
  if (!inv || inv.status !== 'paid') throw new BadRequestError('This order has no paid invoice yet, so it cannot be dispatched.');
};

/**
 * Book the courier for a paid order and save its CN. The order becomes "Dispatching from partner" (direct dispatch) only after
 * the booking succeeded: a courier API error or a missing CN changes nothing.
 */
export const bookDispatch = async ({ order, courierId, cn, manual = false, profile }) => {
  const existing = (await supabaseAdmin.from('shipments').select('*').eq('order_id', order.id).maybeSingle()).data;
  // a paid order not routed yet, or one whose earlier booking was cancelled (it stays "dispatching from partner" without a CN)
  const open = (order.status === 'paid' && !order.partner_route) || (order.status === 'partner_dispatch' && existing?.status === 'needs_label');
  if (!open) throw new BadRequestError(existing && existing.status !== 'needs_label' ? 'This parcel already has a booking.' : 'Only a paid order that has not been routed yet can be booked for dispatch.');
  await assertPaid(order);
  const courier = await resolveCourier({ courier_id: courierId });
  const units = unwrap(await supabaseAdmin.from('order_units').select('unit_title, quantity').eq('order_id', order.id));
  const itemsCount = units.reduce((n, u) => n + (Number(u.quantity) || 1), 0) || 1;
  const description = units.map((u) => u.unit_title).filter(Boolean).join(', ').slice(0, 180);
  const booking = await obtainCn({ courier, manualCn: cn, forceManual: manual === true, parcel: { order, itemsCount, description } });
  const { data: dup } = await supabaseAdmin.from('shipments').select('id').eq('courier_id', courier.id).ilike('tracking_number', booking.cn.replace(/[%_\\]/g, (c) => `\\${c}`)).neq('order_id', order.id).maybeSingle();
  if (dup) throw new ConflictError(`The CN ${booking.cn} is already used for another parcel with ${courier.name}.`);

  const now = new Date().toISOString();
  const row = {
    order_id: order.id, shipped_from: 'partner', status: 'booked', courier: courier.name, courier_id: courier.id, tracking_number: booking.cn,
    booking_source: booking.source, booking_response: booking.response, booked_at: now, booked_by: profile.id,
    weight_kg: order.weight_kg, service: order.shipping_service, updated_at: now,
  };
  const { data, error } = existing
    ? await supabaseAdmin.from('shipments').update(row).eq('id', existing.id).eq('status', 'needs_label').select('*').single()
    : await supabaseAdmin.from('shipments').insert(row).select('*').single();
  if (error) {
    if (error.code === '23505') throw new ConflictError('That CN is already used, or this parcel is already booked.');
    throw error;
  }
  await addShipmentEvent({ shipmentId: data.id, status: 'booked', note: `${courier.name} · CN ${booking.cn}`, source: booking.source === 'api' ? 'system' : 'manual', userId: profile.id });
  if (order.status !== 'partner_dispatch') await setOrderStatus(order.id, 'partner_dispatch', { note: `Courier booked: ${courier.name} · CN ${booking.cn}`, actorId: profile.id, extra: { partner_route: 'direct_dispatch' } });
  emitShipmentUpdate(order, data);
  return data;
};

/** Undo a booking made by mistake, only before the loadsheet was downloaded. */
export const cancelDispatchBooking = async ({ order, profile }) => {
  const shipment = (await supabaseAdmin.from('shipments').select('*').eq('order_id', order.id).maybeSingle()).data;
  if (!shipment || shipment.status !== 'booked') throw new BadRequestError(shipment ? 'The loadsheet was already downloaded. The booking cannot be cancelled.' : 'This parcel has no booking.');
  // an API booking is cancelled at the courier first: if the courier refuses, nothing changes here either
  if (shipment.booking_source === 'api') {
    try {
      await cancelWithProvider({ courierName: shipment.courier, cn: shipment.tracking_number });
    } catch (e) {
      throw new BadRequestError(`${shipment.courier} did not cancel the booking: ${e?.message || 'no answer'}. The booking was not cancelled.`);
    }
  }
  const now = new Date().toISOString();
  const { data } = await supabaseAdmin.from('shipments').update({
    status: 'needs_label', tracking_number: null, courier: null, courier_id: null, booking_response: null, booked_at: null, loadsheet_id: null, updated_at: now,
  }).eq('id', shipment.id).eq('status', 'booked').select('id').maybeSingle();
  if (!data) throw new BadRequestError('The booking changed meanwhile. Refresh and try again.');
  await addShipmentEvent({ shipmentId: shipment.id, status: 'cancelled', note: `Booking cancelled (${shipment.courier} ${shipment.tracking_number})`, source: 'manual', userId: profile.id });
  // the order stays "dispatching from partner" (an order never goes back in status); it is back in the Paid tab to be booked again
  await addEvent(order.id, order.status, `Courier booking cancelled (${shipment.courier} ${shipment.tracking_number})`, profile.id);
  emitShipmentUpdate(order, { ...shipment, status: 'needs_label' });
  return { cancelled: true };
};

const RETURN_TO_NAME = (o) => o.customer_name || '';

/** The loadsheet of the selected parcels (nothing is dispatched yet). Every parcel must be booked, of one courier and one partner. */
export const createDispatchLoadsheet = async ({ shipmentIds, profile, canAccess }) => {
  const ids = [...new Set((shipmentIds || []).filter(Boolean))];
  if (!ids.length) throw new BadRequestError('Select at least one parcel.');
  if (ids.length > 200) throw new BadRequestError('Select up to 200 parcels per loadsheet.');
  const rows = unwrap(await supabaseAdmin.from('shipments').select('*').in('id', ids));
  if (rows.length !== ids.length) throw new BadRequestError('One of the selected parcels was not found.');
  const orders = unwrap(await supabaseAdmin.from('orders').select('id, reference, partner_id, customer_name, customer_code, destination_address, destination_city, destination_country, destination_phone, weight_kg').in('id', rows.map((r) => r.order_id)));
  const orderOf = new Map(orders.map((o) => [o.id, o]));
  const shipments = rows.map((r) => ({ ...r, order: orderOf.get(r.order_id) }));
  for (const s of shipments) {
    if (canAccess && !canAccess(s.order?.partner_id)) throw new ForbiddenError('One of the selected parcels belongs to another partner.');
    if (!['booked', 'labelled'].includes(s.status)) throw new BadRequestError(`${s.order?.reference || 'A parcel'} is not ready for dispatch (${DISPATCH_LABELS[s.status] || s.status}).`);
    if (!String(s.tracking_number || '').trim() || !s.courier_id) throw new BadRequestError(`${s.order?.reference || 'A parcel'} has no valid CN.`);
  }
  if (new Set(shipments.map((s) => s.courier_id)).size > 1) throw new BadRequestError('A loadsheet is for one courier. Select parcels of the same courier.');
  if (new Set(shipments.map((s) => s.order?.partner_id)).size > 1) throw new BadRequestError('Select parcels of one partner only.');

  const items = shipments.sort((a, b) => String(a.order?.reference).localeCompare(String(b.order?.reference))).map((s) => ({
    shipment_id: s.id, order: s.order?.reference, code: s.order?.customer_code, article: `${s.weight_kg ? `${s.weight_kg} kg` : ''}`.trim(), cn: s.tracking_number,
    to: 'Customer', name: RETURN_TO_NAME(s.order), phone: s.order?.destination_phone || '', address: s.order?.destination_address || '',
    city: [s.order?.destination_city, s.order?.destination_country].filter(Boolean).join(', '),
  }));
  const first = shipments[0];
  const sheet = unwrap(await supabaseAdmin.from('return_loadsheets').insert({
    kind: 'dispatch', partner_id: first.order?.partner_id ?? null, courier_id: first.courier_id, courier_name: first.courier, status: 'generated', items, created_by: profile.id,
  }).select('*').single());
  const older = [...new Set(shipments.map((s) => s.loadsheet_id).filter((x) => x && x !== sheet.id))];
  if (older.length) await supabaseAdmin.from('return_loadsheets').update({ status: 'void' }).in('id', older).in('status', ['generated', 'downloaded']);
  unwrap(await supabaseAdmin.from('shipments').update({ loadsheet_id: sheet.id, updated_at: new Date().toISOString() }).in('id', ids).in('status', ['booked', 'labelled']));
  return sheet;
};

export { loadsheetCsv };

/** The file was downloaded: the parcels wait for the courier ("labelled"). Nothing is dispatched yet. Repeating it changes nothing. */
export const markDownloaded = async ({ sheetId, profile, canAccess }) => {
  const sheet = (await supabaseAdmin.from('return_loadsheets').select('*').eq('id', sheetId).maybeSingle()).data;
  if (!sheet || sheet.kind !== 'dispatch') throw new BadRequestError('Loadsheet not found.');
  if (canAccess && !canAccess(sheet.partner_id)) throw new ForbiddenError('This loadsheet belongs to another partner.');
  if (sheet.status === 'void') throw new BadRequestError('This loadsheet was replaced by a newer one.');
  if (sheet.status !== 'generated') return { already: true, count: 0, sheet };
  const { data: claimed } = await supabaseAdmin.from('return_loadsheets').update({ status: 'downloaded' }).eq('id', sheet.id).eq('status', 'generated').select('id').maybeSingle();
  if (!claimed) return { already: true, count: 0, sheet };
  const now = new Date().toISOString();
  const shipments = unwrap(await supabaseAdmin.from('shipments').select('*').eq('loadsheet_id', sheet.id).eq('status', 'booked'));
  for (const s of shipments) {
    const { data: ok } = await supabaseAdmin.from('shipments').update({ status: 'labelled', label_printed_at: now, updated_at: now }).eq('id', s.id).eq('status', 'booked').select('id').maybeSingle();
    if (!ok) continue;
    await addShipmentEvent({ shipmentId: s.id, status: 'labelled', note: `Loadsheet ${sheet.number} downloaded`, source: 'system', userId: profile.id });
    const order = await loadOrder(s.order_id);
    if (order) emitShipmentUpdate(order, { ...s, status: 'labelled' });
  }
  return { already: false, count: shipments.length, sheet };
};

/**
 * The partner confirms the courier really took the parcels. Only now are they Dispatched and the orders Shipped; the customer is told.
 * Only parcels whose loadsheet was downloaded move; a second confirm changes nothing.
 */
export const confirmDispatchHandover = async ({ sheetId, profile, canAccess }) => {
  const sheet = (await supabaseAdmin.from('return_loadsheets').select('*').eq('id', sheetId).maybeSingle()).data;
  if (!sheet || sheet.kind !== 'dispatch') throw new BadRequestError('Loadsheet not found.');
  if (canAccess && !canAccess(sheet.partner_id)) throw new ForbiddenError('This loadsheet belongs to another partner.');
  if (sheet.status === 'handed_over') return { already: true, count: 0, sheet };
  if (sheet.status === 'void') throw new BadRequestError('This loadsheet was replaced by a newer one. Use the newer one.');
  if (sheet.status !== 'downloaded') throw new BadRequestError('Download the loadsheet first. Parcels are handed over only after it was downloaded.');
  const now = new Date().toISOString();
  const { data: claimed } = await supabaseAdmin.from('return_loadsheets').update({ status: 'handed_over', handed_over_at: now }).eq('id', sheet.id).eq('status', 'downloaded').select('id').maybeSingle();
  if (!claimed) return { already: true, count: 0, sheet };

  const shipments = unwrap(await supabaseAdmin.from('shipments').select('*').eq('loadsheet_id', sheet.id).eq('status', 'labelled'));
  let moved = 0;
  for (const s of shipments) {
    const { data: ok } = await supabaseAdmin.from('shipments').update({ status: 'handed_to_courier', handed_at: now, updated_at: now }).eq('id', s.id).eq('status', 'labelled').select('id').maybeSingle();
    if (!ok) continue;
    await addShipmentEvent({ shipmentId: s.id, status: 'handed_to_courier', note: `Handed to ${s.courier} · ${sheet.number}`, source: 'manual', userId: profile.id });
    const order = await loadOrder(s.order_id);
    if (order) {
      await setOrderStatus(order.id, 'shipped', { note: `Shipped by ${s.courier} · tracking ${s.tracking_number}`, actorId: profile.id, extra: { shipped_at: now } });
      await notifyUser(order.customer_id, { type: 'logistics', title: `Shipped: ${order.reference}`, body: `Your order is on its way with ${s.courier}. Tracking number: ${s.tracking_number}.`, link: `/app/orders/${order.id}`, orderId: order.id }).catch(() => {});
      emitShipmentUpdate(order, { ...s, status: 'handed_to_courier' });
    }
    moved += 1;
  }
  return { already: false, count: moved, sheet };
};

const FORWARD = {
  handed_to_courier: ['in_transit', 'delivered', 'failed_delivery', 'returning_to_partner'],
  in_transit: ['in_transit', 'delivered', 'failed_delivery', 'returning_to_partner'],
  failed_delivery: ['in_transit', 'delivered', 'failed_delivery', 'returning_to_partner'],
  returning_to_partner: ['returning_to_partner'],
};

/**
 * One tracking event of a dispatched parcel: in_transit, delivered, failed_delivery (an attempt failed: the parcel stays
 * Dispatched) or returning_to_partner (the courier confirmed it is coming back: it moves to the Failed delivery tab).
 * The same event twice, or an event after delivery, changes nothing.
 */
export const recordDispatchTracking = async ({ shipment, status, note, reason, proof, source, eventId, occurredAt, profile }) => {
  if (!['in_transit', 'delivered', 'failed_delivery', 'returning_to_partner'].includes(status)) throw new BadRequestError('Unknown tracking status.');
  const current = await loadShipment(shipment.id);
  if (!current) throw new BadRequestError('Shipment not found.');
  if (['needs_label', 'booked', 'labelled'].includes(current.status)) throw new BadRequestError('This parcel has not been handed over to the courier yet.');
  if (['delivered', 'returned_to_partner'].includes(current.status)) return { shipment: current, duplicate: true };
  if (!FORWARD[current.status]?.includes(status)) throw new BadRequestError(`A parcel that is ${DISPATCH_LABELS[current.status]?.toLowerCase()} cannot become ${status.replace(/_/g, ' ')}.`);

  const text = [reason, note].filter(Boolean).join(' · ');
  const stored = await addShipmentEvent({ shipmentId: current.id, status, note: text, source, eventId, occurredAt, userId: profile?.id });
  if (!stored) return { shipment: current, duplicate: true };
  if (current.status === status && status !== 'in_transit' && status !== 'failed_delivery') return { shipment: current, duplicate: true };

  const now = new Date().toISOString();
  const patch = { updated_at: now };
  if (status === 'in_transit' && current.status !== 'in_transit') patch.status = 'in_transit';
  if (status === 'delivered') Object.assign(patch, { status: 'delivered', delivered_at: occurredAt || now, proof: proof ?? null });
  if (status === 'failed_delivery') Object.assign(patch, { status: 'failed_delivery', failed_at: occurredAt || now, failure_reason: reason ? String(reason).slice(0, 300) : null });
  if (status === 'returning_to_partner') Object.assign(patch, { status: 'returning_to_partner', return_started_at: occurredAt || now, failure_reason: reason ? String(reason).slice(0, 300) : current.failure_reason });
  const { data: updated } = await supabaseAdmin.from('shipments').update(patch).eq('id', current.id).eq('status', current.status).select('*').maybeSingle();
  if (!updated) return { shipment: await loadShipment(current.id), duplicate: true };

  const order = await loadOrder(current.order_id);
  if (order) {
    if (status === 'delivered') {
      await setOrderStatus(order.id, 'delivered', { note: `Delivered by ${current.courier} · ${current.tracking_number}`, actorId: profile?.id ?? null, extra: { delivered_at: patch.delivered_at } });
      await notifyUser(order.customer_id, { type: 'logistics', title: `Delivered: ${order.reference}`, body: `Your order was delivered by ${current.courier}.`, link: `/app/orders/${order.id}`, orderId: order.id }).catch(() => {});
    } else if (status === 'failed_delivery') {
      await addEvent(order.id, order.status, `Delivery attempt failed (${current.courier} ${current.tracking_number})${text ? `: ${text}` : ''}`, profile?.id ?? null);
    } else if (status === 'returning_to_partner') {
      await supabaseAdmin.from('orders').update({ has_issue: true, updated_at: now }).eq('id', order.id);
      await addEvent(order.id, order.status, `Parcel is being returned to the partner (${current.courier} ${current.tracking_number})${text ? `: ${text}` : ''}`, profile?.id ?? null);
      await notifyUser(order.customer_id, { type: 'alert', title: `Delivery failed: ${order.reference}`, body: 'The courier could not deliver your parcel and is returning it. We will contact you.', link: `/app/orders/${order.id}`, orderId: order.id }).catch(() => {});
    }
    emitShipmentUpdate(order, updated);
  }
  return { shipment: updated };
};

/** The partner confirms the returned parcel is physically back. Only then does it count as received. */
export const confirmReturnedToPartner = async ({ shipment, profile }) => {
  const current = await loadShipment(shipment.id);
  if (!current) throw new BadRequestError('Shipment not found.');
  if (current.status === 'returned_to_partner') return { shipment: current, duplicate: true };
  if (current.status !== 'returning_to_partner') throw new BadRequestError('The courier has not confirmed that this parcel is coming back.');
  const now = new Date().toISOString();
  const { data: updated } = await supabaseAdmin.from('shipments').update({ status: 'returned_to_partner', returned_at: now, returned_confirmed_by: profile.id, updated_at: now }).eq('id', current.id).eq('status', 'returning_to_partner').select('*').maybeSingle();
  if (!updated) return { shipment: await loadShipment(current.id), duplicate: true };
  await addShipmentEvent({ shipmentId: current.id, status: 'returned_to_partner', note: 'Parcel received back by the partner', source: 'manual', userId: profile.id });
  const order = await loadOrder(current.order_id);
  if (order) {
    await addEvent(order.id, order.status, `Parcel received back from ${current.courier} (${current.tracking_number})`, profile.id);
    emitShipmentUpdate(order, updated);
  }
  return { shipment: updated };
};

/** Find the dispatched parcel a courier webhook is about, by CN (and courier name when two couriers share a CN). */
export const findDispatchByCn = async ({ cn, courier }) => {
  const number = String(cn ?? '').replace(/\s+/g, ' ').trim();
  if (!number) return { error: 'CN missing' };
  let rows = unwrap(await supabaseAdmin.from('shipments').select('*').ilike('tracking_number', number.replace(/[%_\\]/g, (c) => `\\${c}`)).eq('shipped_from', 'partner'));
  if (courier) rows = rows.filter((r) => String(r.courier || '').trim().toLowerCase() === String(courier).trim().toLowerCase());
  if (!rows.length) return { error: 'No dispatched parcel has that CN' };
  if (rows.length > 1) return { error: 'More than one courier has that CN: send the courier name too' };
  return { shipment: rows[0] };
};

/** Events of shipments, for the list screens. */
export const dispatchEventsFor = async (shipmentIds) => {
  if (!shipmentIds.length) return new Map();
  const events = unwrap(await supabaseAdmin.from('shipment_events').select('shipment_id, status, note, source, occurred_at').in('shipment_id', shipmentIds).order('occurred_at', { ascending: true }));
  const by = new Map();
  for (const e of events) (by.get(e.shipment_id) || by.set(e.shipment_id, []).get(e.shipment_id)).push(e);
  return by;
};
