import { supabaseAdmin } from '../config/supabase.js';
import { BadRequestError, ConflictError, ForbiddenError } from '../utils/error.helper.js';
import { unwrap } from '../utils/db.js';
import { notifyUser } from './notification.service.js';
import { logUnitEvent, addEvent } from './order.service.js';
import { resolveCourier } from './courier.service.js';
import { obtainCn, cancelWithProvider, providerFor } from './courier-provider.service.js';
import { markSentBack, emitUnitUpdate, syncReviewFlag } from './unit-review.service.js';
import { ARTICLE_STATE_LABELS } from './unit-flow.service.js';

/**
 * The courier workflow of a returned article, one return shipment per article:
 *
 *   requested ──book CN──> booked ──loadsheet downloaded──> handed_over ──> in_transit ──> delivered (= Returned)
 *                 └─ cancel booking (only while booked)
 *
 * The courier is not called from here: this project has no courier API connection, so the partner books the consignment (CN)
 * with the courier and types the CN in. Tracking comes from the courier's webhook (POST /api/webhooks/courier) or from a person
 * entering what the courier's tracking shows; every event keeps its source. Delivery is only recorded from a tracking event,
 * never inferred from a booking, a loadsheet or a handover.
 */

export const SHIPMENT_STATUS_LABELS = {
  booked: 'CN booked · ready for return',
  handed_over: 'Handed over to the courier',
  in_transit: 'In transit',
  delivered: 'Delivered to the customer',
  cancelled: 'Booking cancelled',
};

const cleanCn = (v) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, 40);

const loadShipment = async (id) => {
  const { data } = await supabaseAdmin.from('return_shipments').select('*').eq('id', id).maybeSingle();
  return data || null;
};

const liveShipmentOf = async (unitId) => {
  const { data } = await supabaseAdmin.from('return_shipments').select('*').eq('unit_id', unitId).neq('status', 'cancelled').maybeSingle();
  return data || null;
};

const addShipmentEvent = async ({ shipmentId, status, note, source, eventId, occurredAt, userId }) => {
  const { error } = await supabaseAdmin.from('return_shipment_events').insert({
    shipment_id: shipmentId, status, note: note ? String(note).slice(0, 300) : null, source, event_id: eventId || null,
    occurred_at: occurredAt || new Date().toISOString(), created_by: userId || null,
  });
  if (error) {
    if (error.code === '23505') return false; // the same courier event arrived again
    throw error;
  }
  return true;
};

/** Book the return shipment of ONE returned article: the CN the courier gave for it. */
export const bookReturn = async ({ order, unit, courierId, cn, manual = false, profile }) => {
  if (unit.review_status !== 'rejected' || unit.return_status !== 'requested') throw new BadRequestError('Only an article the customer asked to return can be booked.');
  const courier = await resolveCourier({ courier_id: courierId });
  if (await liveShipmentOf(unit.id)) throw new ConflictError('This article already has a CN booked.');
  // a return that already went to the Warehouse is dispatched there: it is not booked a second time here
  const routed = (await supabaseAdmin.from('orders').select('id').eq('return_unit_id', unit.id).neq('status', 'cancelled').maybeSingle()).data;
  if (routed) throw new ConflictError('This return is already in the Warehouse. Book its courier there.');
  // through the courier's API when it has one (PostEx): the parcel goes from the partner to the return address the customer gave
  let booking;
  if (!manual && providerFor(courier.name)?.book) {
    const to = unit.return_shipping;
    if (unit.return_to !== 'customer' || !to) throw new BadRequestError('This return goes to the brand, whose address is not stored here, so it cannot be booked through the courier API. Book it with the courier yourself and enter the CN.');
    booking = await obtainCn({
      courier,
      parcel: {
        order: { reference: order.reference }, itemsCount: 1, description: `Return: ${unit.unit_title}`.slice(0, 180), destination: { name: to.name || order.customer_name, phone: to.phone, address: to.address, city: to.city },
        refNumber: `${unit.code || order.reference}-RET`, notes: `Return of ${unit.code || unit.unit_title} (${order.reference})`,
      },
    });
  } else {
    booking = await obtainCn({ courier, manualCn: cn, forceManual: true });
  }
  const number = cleanCn(booking.cn);
  const { data: dup } = await supabaseAdmin.from('return_shipments').select('id').eq('courier_id', courier.id).ilike('cn_number', number.replace(/[%_\\]/g, (c) => `\\${c}`)).neq('status', 'cancelled').maybeSingle();
  if (dup) throw new ConflictError(`The CN ${number} is already used for another return with ${courier.name}.`);

  const { data, error } = await supabaseAdmin.from('return_shipments').insert({
    order_id: order.id, unit_id: unit.id, partner_id: order.partner_id ?? null, courier_id: courier.id, courier_name: courier.name,
    cn_number: number, status: 'booked', booking_source: booking.source, booking_response: booking.response, return_to: unit.return_to ?? null, ship_to: unit.return_shipping ?? null, booked_by: profile.id,
  }).select('*').single();
  if (error) {
    if (error.code === '23505') throw new ConflictError('This article already has a CN booked, or that CN is already in use.');
    throw error;
  }
  await addShipmentEvent({ shipmentId: data.id, status: 'booked', note: `${courier.name} · CN ${number}`, source: booking.source === 'api' ? 'system' : 'manual', userId: profile.id });
  await logUnitEvent(unit.id, order.id, 'return_booked', { note: `${courier.name} · CN ${number}`, actorId: profile.id });
  await addEvent(order.id, order.status, `Return CN booked for ${unit.unit_title}: ${courier.name} ${number}`, profile.id);
  emitUnitUpdate(order, unit, { state: 'return_requested', stateLabel: 'CN booked', returnStatus: 'booked' });
  return data;
};

/** Undo a booking made by mistake. Only while the parcel has not been handed over. */
export const cancelBooking = async ({ order, unit, profile }) => {
  const shipment = await liveShipmentOf(unit.id);
  if (!shipment) throw new BadRequestError('This article has no CN booked.');
  if (shipment.status !== 'booked') throw new BadRequestError('The parcel was already handed over to the courier. The booking cannot be cancelled.');
  // a booking made through the courier's API is cancelled at the courier first; if it refuses, nothing changes
  if (shipment.booking_source === 'api') {
    try {
      await cancelWithProvider({ courierName: shipment.courier_name, cn: shipment.cn_number });
    } catch (e) {
      throw new BadRequestError(`${shipment.courier_name} did not cancel the booking: ${e?.message || 'no answer'}. The booking was not cancelled.`);
    }
  }
  const now = new Date().toISOString();
  const { data, error } = await supabaseAdmin.from('return_shipments').update({ status: 'cancelled', cancelled_at: now, updated_at: now }).eq('id', shipment.id).eq('status', 'booked').select('id').maybeSingle();
  if (error) throw error;
  if (!data) throw new BadRequestError('The booking changed meanwhile. Refresh and try again.');
  await addShipmentEvent({ shipmentId: shipment.id, status: 'cancelled', note: 'Booking cancelled', source: 'manual', userId: profile.id });
  await addEvent(order.id, order.status, `Return CN cancelled for ${unit.unit_title} (${shipment.cn_number})`, profile.id);
  emitUnitUpdate(order, unit, { state: 'return_requested', stateLabel: ARTICLE_STATE_LABELS.return_requested, returnStatus: 'requested' });
  return { cancelled: true };
};

const csvCell = (v) => `"${String(v ?? '').replace(/"/g, '""').replace(/\r?\n/g, ' ')}"`;

/** The loadsheet as a CSV file (opens in Excel): one line per parcel being handed to the courier. */
export const loadsheetCsv = (sheet) => {
  const dispatch = sheet.kind === 'dispatch';
  const head = dispatch ? ['#', 'CN number', 'Order', 'Customer code', 'Weight', 'Customer', 'Phone', 'Address', 'City'] : ['#', 'CN number', 'Order', 'Article code', 'Article', 'Return to', 'Receiver', 'Phone', 'Address', 'City'];
  const lines = [
    [`Loadsheet ${sheet.number}`, `Courier: ${sheet.courier_name || ''}`, `Date: ${String(sheet.created_at || new Date().toISOString()).slice(0, 10)}`, `Parcels: ${sheet.items.length}`].map(csvCell).join(','),
    head.map(csvCell).join(','),
    ...sheet.items.map((it, i) => (dispatch ? [i + 1, it.cn, it.order, it.code, it.article, it.name, it.phone, it.address, it.city] : [i + 1, it.cn, it.order, it.code, it.article, it.to, it.name, it.phone, it.address, it.city]).map(csvCell).join(',')),
  ];
  return `﻿${lines.join('\r\n')}\r\n`;
};

const RETURN_TO_LABEL = { brand: 'Brand', customer: 'Customer' };

/**
 * Make the loadsheet for the selected parcels. Nothing is handed over yet: that only happens when the download succeeded
 * (confirmHandover). Every parcel must be booked, of one courier and one partner.
 */
export const createLoadsheet = async ({ shipmentIds, profile, canAccess }) => {
  const ids = [...new Set((shipmentIds || []).filter(Boolean))];
  if (!ids.length) throw new BadRequestError('Select at least one parcel.');
  if (ids.length > 200) throw new BadRequestError('Select up to 200 parcels per loadsheet.');
  const rows = unwrap(await supabaseAdmin.from('return_shipments').select('*').in('id', ids));
  if (rows.length !== ids.length) throw new BadRequestError('One of the selected parcels was not found.');
  const [orders, units] = await Promise.all([
    supabaseAdmin.from('orders').select('id, reference').in('id', [...new Set(rows.map((x) => x.order_id))]),
    supabaseAdmin.from('order_units').select('id, code, unit_title, return_shipping, return_to').in('id', rows.map((x) => x.unit_id)),
  ]);
  const orderOf = new Map(unwrap(orders).map((o) => [o.id, o]));
  const unitOf = new Map(unwrap(units).map((u) => [u.id, u]));
  const shipments = rows.map((x) => ({ ...x, order: orderOf.get(x.order_id), unit: unitOf.get(x.unit_id) }));
  for (const s of shipments) {
    if (canAccess && !canAccess(s.partner_id)) throw new ForbiddenError('One of the selected parcels belongs to another partner.');
    if (s.status !== 'booked') throw new BadRequestError(`${s.unit?.code || 'A parcel'} is not ready for return (${SHIPMENT_STATUS_LABELS[s.status] || s.status}).`);
    if (!cleanCn(s.cn_number)) throw new BadRequestError(`${s.unit?.code || 'A parcel'} has no valid CN.`);
  }
  if (new Set(shipments.map((s) => s.courier_id)).size > 1) throw new BadRequestError('A loadsheet is for one courier. Select parcels of the same courier.');
  if (new Set(shipments.map((s) => s.partner_id)).size > 1) throw new BadRequestError('Select parcels of one partner only.');

  const items = shipments
    .sort((a, b) => String(a.unit?.code).localeCompare(String(b.unit?.code)))
    .map((s) => {
      const to = s.ship_to || s.unit?.return_shipping || {};
      return { shipment_id: s.id, order: s.order?.reference, code: s.unit?.code, article: s.unit?.unit_title, cn: s.cn_number, to: RETURN_TO_LABEL[s.return_to] || '', name: to.name || '', phone: to.phone || '', address: to.address || '', city: to.city || '' };
    });
  const first = shipments[0];
  const sheet = unwrap(await supabaseAdmin.from('return_loadsheets').insert({ partner_id: first.partner_id, courier_id: first.courier_id, courier_name: first.courier_name, status: 'generated', items, created_by: profile.id }).select('*').single());
  // a loadsheet made earlier for these parcels but never downloaded is replaced by this one
  const older = [...new Set(shipments.map((s) => s.loadsheet_id).filter((x) => x && x !== sheet.id))];
  if (older.length) await supabaseAdmin.from('return_loadsheets').update({ status: 'void' }).in('id', older).eq('status', 'generated');
  unwrap(await supabaseAdmin.from('return_shipments').update({ loadsheet_id: sheet.id, updated_at: new Date().toISOString() }).in('id', ids).eq('status', 'booked'));
  return sheet;
};

/**
 * The loadsheet was downloaded: the parcels are now with the courier. Safe to call again (a second call changes nothing).
 * Only parcels that are still booked move; a parcel cancelled meanwhile is left alone.
 */
export const confirmHandover = async ({ sheetId, profile, canAccess }) => {
  const sheet = (await supabaseAdmin.from('return_loadsheets').select('*').eq('id', sheetId).maybeSingle()).data;
  if (!sheet) throw new BadRequestError('Loadsheet not found.');
  if (canAccess && !canAccess(sheet.partner_id)) throw new ForbiddenError('This loadsheet belongs to another partner.');
  if (sheet.status === 'handed_over') return { already: true, count: 0, sheet };
  if (sheet.status !== 'generated') throw new BadRequestError('This loadsheet was replaced by a newer one. Download the newer one.');
  const now = new Date().toISOString();
  const { data: claimed } = await supabaseAdmin.from('return_loadsheets').update({ status: 'handed_over', handed_over_at: now }).eq('id', sheet.id).eq('status', 'generated').select('id').maybeSingle();
  if (!claimed) return { already: true, count: 0, sheet };

  const shipments = unwrap(await supabaseAdmin.from('return_shipments').select('*').eq('loadsheet_id', sheet.id).eq('status', 'booked'));
  let moved = 0;
  for (const s of shipments) {
    const { data: ok } = await supabaseAdmin.from('return_shipments').update({ status: 'handed_over', handed_over_at: now, updated_at: now }).eq('id', s.id).eq('status', 'booked').select('id').maybeSingle();
    if (!ok) continue;
    const unit = (await supabaseAdmin.from('order_units').select('*').eq('id', s.unit_id).maybeSingle()).data;
    const order = (await supabaseAdmin.from('orders').select('*').eq('id', s.order_id).maybeSingle()).data;
    await addShipmentEvent({ shipmentId: s.id, status: 'handed_over', note: `Loadsheet ${sheet.number}`, source: 'system', userId: profile.id });
    // the article now counts as sent back: the customer and the team see it as in progress
    if (unit && order && unit.return_status === 'requested') await markSentBack({ order, unit, courier: s.courier_name, tracking: s.cn_number, profile });
    moved += 1;
  }
  return { already: false, count: moved, sheet };
};

const FORWARD = { handed_over: ['in_transit', 'delivered'], in_transit: ['in_transit', 'delivered'] };

/**
 * One tracking event of a return shipment: it is on its way (in_transit) or it was delivered to the customer (delivered).
 * Duplicate events (same event id, or delivery reported twice) change nothing. A parcel that has not been handed over
 * yet cannot be in transit or delivered.
 * @returns {Promise<{ shipment: object, duplicate?: boolean, ignored?: string }>}
 */
export const recordTracking = async ({ shipment, status, note, source, eventId, occurredAt, profile }) => {
  if (!['in_transit', 'delivered'].includes(status)) throw new BadRequestError('The status must be in_transit or delivered.');
  const current = await loadShipment(shipment.id);
  if (!current) throw new BadRequestError('Return shipment not found.');
  if (['booked', 'cancelled'].includes(current.status)) throw new BadRequestError(current.status === 'booked' ? 'This parcel has not been handed over to the courier yet.' : 'This booking was cancelled.');
  if (current.status === 'delivered') return { shipment: current, duplicate: true };
  if (!FORWARD[current.status]?.includes(status)) throw new BadRequestError(`A parcel that is ${SHIPMENT_STATUS_LABELS[current.status]?.toLowerCase()} cannot become ${status}.`);

  const stored = await addShipmentEvent({ shipmentId: current.id, status, note, source, eventId, occurredAt, userId: profile?.id });
  if (!stored) return { shipment: current, duplicate: true };

  const now = new Date().toISOString();
  const patch = status === 'delivered' ? { status: 'delivered', delivered_at: occurredAt || now, updated_at: now } : { status: 'in_transit', updated_at: now };
  const { data: updated } = await supabaseAdmin.from('return_shipments').update(patch).eq('id', current.id).eq('status', current.status).select('*').maybeSingle();
  if (!updated) return { shipment: await loadShipment(current.id), duplicate: true };

  const unit = (await supabaseAdmin.from('order_units').select('*').eq('id', current.unit_id).maybeSingle()).data;
  const order = (await supabaseAdmin.from('orders').select('*').eq('id', current.order_id).maybeSingle()).data;
  if (unit && order) {
    if (status === 'delivered') {
      const { data: back } = await supabaseAdmin.from('order_units').update({ return_status: 'returned', return_updated_at: now, updated_at: now }).eq('id', unit.id).eq('return_status', 'sent_back').select('id').maybeSingle();
      if (back) {
        await logUnitEvent(unit.id, order.id, 'return_delivered', { note: `${current.courier_name} · CN ${current.cn_number}`, actorId: profile?.id ?? null });
        await addEvent(order.id, order.status, `${unit.unit_title} returned: delivered to ${current.return_to === 'brand' ? 'the brand' : 'the customer'} (${current.courier_name} ${current.cn_number})`, profile?.id ?? null);
        await syncReviewFlag(order.id);
        await notifyUser(order.customer_id, { type: 'update', title: `Return delivered: ${order.reference}`, body: `${unit.unit_title} was delivered${current.return_to === 'brand' ? ' to the brand' : ' to you'}.`, link: `/app/orders/${order.id}`, orderId: order.id }).catch(() => {});
      }
      emitUnitUpdate(order, unit, { state: 'returned', stateLabel: 'Returned', returnStatus: 'returned' });
    } else {
      await logUnitEvent(unit.id, order.id, 'return_in_transit', { note: note ? String(note).slice(0, 200) : null, actorId: profile?.id ?? null });
      emitUnitUpdate(order, unit, { state: 'returned', stateLabel: 'In transit', returnStatus: 'in_transit' });
    }
  }
  return { shipment: updated };
};

/** A courier's wording → our two tracking statuses (anything else is not an event this workflow acts on). */
export const normalizeCourierStatus = (raw) => {
  const s = String(raw ?? '').toLowerCase().replace(/[\s_-]+/g, ' ').trim();
  if (/^(delivered|delivered to (the )?(customer|consignee|receiver)|delivery completed)$/.test(s)) return 'delivered';
  if (/^(in transit|picked up|pickup done|dispatched|out for delivery|arrived at hub|shipped)$/.test(s)) return 'in_transit';
  return null;
};

/** The wording of couriers for the dispatch workflow: also a failed attempt and a confirmed return to the shipper. */
export const normalizeDispatchStatus = (raw) => {
  const s = String(raw ?? '').toLowerCase().replace(/[\s_-]+/g, ' ').trim();
  if (/^(returned to shipper|returning to shipper|return to origin|returning to origin|rto|return to sender|returning to sender|returned to origin)$/.test(s)) return 'returning_to_partner';
  if (/^(delivery failed|delivery attempt failed|failed delivery|undelivered|attempted|delivery attempted)$/.test(s)) return 'failed_delivery';
  return normalizeCourierStatus(raw);
};

/** Find the return shipment a courier's webhook is about by its CN (and the courier name when several couriers share a CN). */
export const findShipmentByCn = async ({ cn, courier }) => {
  const number = cleanCn(cn);
  if (!number) return { error: 'CN missing' };
  let rows = unwrap(await supabaseAdmin.from('return_shipments').select('*').ilike('cn_number', number.replace(/[%_\\]/g, (c) => `\\${c}`)).neq('status', 'cancelled'));
  if (courier) rows = rows.filter((r) => r.courier_name.trim().toLowerCase() === String(courier).trim().toLowerCase());
  if (!rows.length) return { error: 'No return shipment has that CN' };
  if (rows.length > 1) return { error: 'More than one courier has that CN: send the courier name too' };
  return { shipment: rows[0] };
};

/** Shipments (with their events) for a set of articles, for the partner list and the customer's order. */
export const shipmentsForUnits = async (unitIds) => {
  if (!unitIds.length) return new Map();
  const shipments = unwrap(await supabaseAdmin.from('return_shipments').select('*').in('unit_id', unitIds).neq('status', 'cancelled'));
  if (!shipments.length) return new Map();
  const events = unwrap(await supabaseAdmin.from('return_shipment_events').select('shipment_id, status, note, source, occurred_at').in('shipment_id', shipments.map((s) => s.id)).order('occurred_at', { ascending: true }));
  const by = new Map();
  for (const e of events) (by.get(e.shipment_id) || by.set(e.shipment_id, []).get(e.shipment_id)).push(e);
  const out = new Map();
  for (const s of shipments) {
    out.set(s.unit_id, {
      id: s.id, courier_name: s.courier_name, cn_number: s.cn_number, status: s.status, status_label: SHIPMENT_STATUS_LABELS[s.status], booking_source: s.booking_source,
      booked_at: s.booked_at, handed_over_at: s.handed_over_at, delivered_at: s.delivered_at, loadsheet_id: s.loadsheet_id, events: by.get(s.id) || [],
    });
  }
  return out;
};
