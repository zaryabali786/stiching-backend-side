/**
 * Warehouse dispatch: Paid > book the courier CN > Ready for dispatch > loadsheet downloaded > handover confirmed (Dispatched)
 * > In transit > Delivered, or a failed delivery that the courier confirms is coming back to the partner.
 * Real service code on an in-memory database. No courier API exists in this project: the CN is typed in.
 */
import { test, mock, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeDb } from './fake-supabase.mjs';

let db;
let wh;
let ret;
const dbProxy = new Proxy({}, { get: (_, key) => db[key] });
const noop = async () => {};

before(async () => {
  mock.module('../src/config/supabase.js', { namedExports: { supabaseAdmin: dbProxy, supabase: dbProxy } });
  mock.module('../src/services/notification.service.js', { namedExports: { notifyAdmins: noop, notifyPartner: noop, notifyUser: noop, notifyStaff: noop, partnerRecipients: async () => [] } });
  wh = await import('../src/services/dispatch-shipment.service.js');
  ret = await import('../src/services/return-shipment.service.js');
});

const PARTNER = 'partner-1';
const STAFF = { id: 'staff-1', full_name: 'Warehouse Staff' };

const order = (n, over = {}) => ({
  id: `order-${n}`, reference: `SA-400${n}`, status: 'paid', partner_id: PARTNER, partner_route: null, customer_id: 'cust-1', customer_name: 'Zaryab Ali', customer_code: 'STX-10011',
  destination_address: 'House 1, Street 2', destination_city: 'Lahore', destination_country: 'Pakistan', destination_phone: '+923001234567', weight_kg: 1.2, shipping_service: 'standard', ...over,
});

beforeEach(() => {
  db = createFakeDb({
    orders: [order(1), order(2), order(3), order(4, { status: 'packed' })],
    invoices: [{ order_id: 'order-1', status: 'paid' }, { order_id: 'order-2', status: 'paid' }, { order_id: 'order-3', status: 'paid' }, { order_id: 'order-4', status: 'draft' }],
    couriers: [{ id: 'c-tcs', name: 'TCS', status: 'active' }, { id: 'c-leo', name: 'Leopards', status: 'active' }],
  }, { uniques: { shipment_events: { when: (r) => !!r.event_id, key: (r) => `${r.shipment_id}|${r.event_id}` } } });
});

const ord = (n) => db.table('orders').find((o) => o.id === `order-${n}`);
const shipOf = (n) => db.table('shipments').find((s) => s.order_id === `order-${n}`);
const book = (n, cn, courier = 'c-tcs') => wh.bookDispatch({ order: { ...ord(n) }, courierId: courier, cn, profile: STAFF });
const events = (n) => db.table('shipment_events').filter((e) => e.shipment_id === shipOf(n).id).map((e) => e.status);
const sheetFor = async (...ids) => wh.createDispatchLoadsheet({ shipmentIds: ids.map((n) => shipOf(n).id), profile: STAFF, canAccess: (p) => p === PARTNER });
const dispatchIt = async (...ns) => {
  const sheet = await sheetFor(...ns);
  await wh.markDownloaded({ sheetId: sheet.id, profile: STAFF });
  await wh.confirmDispatchHandover({ sheetId: sheet.id, profile: STAFF });
  return sheet;
};

test('a parcel is booked only for an order with a really paid invoice, a valid CN, once', async () => {
  await assert.rejects(() => book(4, 'TCS12345'), /paid order|paid invoice/i, 'a packed order is not bookable');
  ord(4).status = 'paid';
  await assert.rejects(() => book(4, 'TCS12345'), /paid invoice/i, 'the order status alone is not enough: the invoice must be paid');
  await assert.rejects(() => book(1, '12'), /CN/i);
  await assert.rejects(() => book(1, 'TCS12345', 'nope'), /courier/i);
  assert.equal(db.table('shipments').length, 0, 'a failed booking changes nothing');
  assert.equal(ord(1).status, 'paid');

  const s = await book(1, 'TCS12345');
  assert.equal(s.status, 'booked');
  assert.equal(s.booking_source, 'manual', 'no courier API is called');
  assert.equal(ord(1).status, 'partner_dispatch');
  assert.equal(ord(1).partner_route, 'direct_dispatch');
  await assert.rejects(() => book(1, 'TCS99999'), /already has a booking|not been routed/i, 'no second booking');
});

test('a booking can be cancelled before the loadsheet, then booked again; the order never goes back in status', async () => {
  await book(1, 'TCS12345');
  await wh.cancelDispatchBooking({ order: { ...ord(1) }, profile: STAFF });
  assert.equal(shipOf(1).status, 'needs_label');
  assert.equal(shipOf(1).tracking_number, null);
  assert.equal(ord(1).status, 'partner_dispatch', 'the order stays where it is');
  const again = await book(1, 'TCS54321');
  assert.equal(again.tracking_number, 'TCS54321');
  assert.equal(shipOf(1).status, 'booked');
});

test('the loadsheet takes only booked parcels of one courier and dispatches nothing by itself', async () => {
  await book(1, 'TCS12345');
  await book(2, 'LEO55555', 'c-leo');
  await assert.rejects(() => wh.createDispatchLoadsheet({ shipmentIds: [], profile: STAFF }), /select at least one/i);
  await assert.rejects(() => sheetFor(1, 2), /one courier/i);
  await assert.rejects(() => wh.createDispatchLoadsheet({ shipmentIds: [shipOf(1).id], profile: STAFF, canAccess: () => false }), /another partner/i);

  const sheet = await sheetFor(1);
  assert.equal(sheet.kind, 'dispatch');
  const csv = ret.loadsheetCsv({ ...sheet, number: 'LS-1001' });
  assert.ok(csv.includes('TCS12345') && csv.includes('SA-4001') && csv.includes('Zaryab Ali') && csv.includes('House 1, Street 2') && csv.includes('Lahore'));
  assert.ok(!csv.includes('LEO55555'));
  assert.equal(shipOf(1).status, 'booked', 'generating the file dispatches nothing');
  assert.equal(ord(1).status, 'partner_dispatch');
});

test('downloaded is not dispatched: the handover must be confirmed, and only after the download', async () => {
  await book(1, 'TCS12345');
  const sheet = await sheetFor(1);
  await assert.rejects(() => wh.confirmDispatchHandover({ sheetId: sheet.id, profile: STAFF }), /download the loadsheet first/i, 'no handover before the download');
  assert.equal(shipOf(1).status, 'booked');

  const dl = await wh.markDownloaded({ sheetId: sheet.id, profile: STAFF });
  assert.equal(dl.count, 1);
  assert.equal(shipOf(1).status, 'labelled');
  assert.equal(ord(1).status, 'partner_dispatch', 'a downloaded loadsheet is not a shipment');
  assert.equal((await wh.markDownloaded({ sheetId: sheet.id, profile: STAFF })).already, true);

  await assert.rejects(() => wh.recordDispatchTracking({ shipment: shipOf(1), status: 'delivered', source: 'webhook', eventId: 'x', profile: null }), /not been handed over/i);

  const done = await wh.confirmDispatchHandover({ sheetId: sheet.id, profile: STAFF });
  assert.equal(done.count, 1);
  assert.equal(shipOf(1).status, 'handed_to_courier');
  assert.ok(shipOf(1).handed_at);
  assert.equal(ord(1).status, 'shipped');
  assert.equal((await wh.confirmDispatchHandover({ sheetId: sheet.id, profile: STAFF })).already, true, 'a second confirm changes nothing');
  await assert.rejects(() => wh.cancelDispatchBooking({ order: { ...ord(1) }, profile: STAFF }), /already downloaded|no booking/i);
  assert.deepEqual(events(1), ['booked', 'labelled', 'handed_to_courier']);
});

test('delivery moves the order to Delivered once; a duplicate or later event changes nothing', async () => {
  await book(1, 'TCS12345');
  await dispatchIt(1);
  const t = await wh.recordDispatchTracking({ shipment: shipOf(1), status: 'in_transit', source: 'webhook', eventId: 'e1', profile: null });
  assert.equal(t.shipment.status, 'in_transit');
  assert.equal(ord(1).status, 'shipped');
  assert.equal((await wh.recordDispatchTracking({ shipment: shipOf(1), status: 'in_transit', source: 'webhook', eventId: 'e1', profile: null })).duplicate, true);

  const d = await wh.recordDispatchTracking({ shipment: shipOf(1), status: 'delivered', source: 'webhook', eventId: 'e2', proof: { receiver: 'Mr Ali' }, profile: null });
  assert.equal(d.shipment.status, 'delivered');
  assert.deepEqual(d.shipment.proof, { receiver: 'Mr Ali' }, 'the proof of delivery is kept');
  assert.equal(ord(1).status, 'delivered');
  assert.ok(shipOf(1).delivered_at);
  assert.equal((await wh.recordDispatchTracking({ shipment: shipOf(1), status: 'delivered', source: 'webhook', eventId: 'e3', profile: null })).duplicate, true);
  assert.equal((await wh.recordDispatchTracking({ shipment: shipOf(1), status: 'failed_delivery', source: 'webhook', eventId: 'e4', profile: null })).duplicate, true, 'nothing after delivery');
  assert.equal(events(1).filter((e) => e === 'delivered').length, 1);
});

test('a failed attempt stays Dispatched; only the courier confirming the return moves it to Failed delivery, and receipt is confirmed by the partner', async () => {
  await book(2, 'LEO55555', 'c-leo');
  await dispatchIt(2);
  const f = await wh.recordDispatchTracking({ shipment: shipOf(2), status: 'failed_delivery', reason: 'Customer not available', source: 'webhook', eventId: 'f1', profile: null });
  assert.equal(f.shipment.status, 'failed_delivery');
  assert.equal(shipOf(2).failure_reason, 'Customer not available');
  assert.equal(ord(2).status, 'shipped', 'a failed attempt is not a return');
  assert.notEqual(ord(2).has_issue, true);
  // the courier tries again
  const again = await wh.recordDispatchTracking({ shipment: shipOf(2), status: 'in_transit', source: 'webhook', eventId: 'f2', profile: null });
  assert.equal(again.shipment.status, 'in_transit');
  await wh.recordDispatchTracking({ shipment: shipOf(2), status: 'failed_delivery', source: 'webhook', eventId: 'f3', profile: null });

  await assert.rejects(() => wh.confirmReturnedToPartner({ shipment: shipOf(2), profile: STAFF }), /not confirmed/i, 'a failed attempt is not a returned parcel');
  const back = await wh.recordDispatchTracking({ shipment: shipOf(2), status: 'returning_to_partner', reason: 'Refused', source: 'webhook', eventId: 'f4', profile: null });
  assert.equal(back.shipment.status, 'returning_to_partner');
  assert.ok(shipOf(2).return_started_at);
  assert.equal(ord(2).has_issue, true);
  assert.equal(ord(2).status, 'shipped', 'the order stays linked to its shipment history');
  assert.equal(shipOf(2).returned_at ?? null, null, 'not received until the partner confirms');
  await assert.rejects(() => wh.recordDispatchTracking({ shipment: shipOf(2), status: 'delivered', source: 'webhook', eventId: 'f5', profile: null }), /cannot become/i);

  const got = await wh.confirmReturnedToPartner({ shipment: shipOf(2), profile: STAFF });
  assert.equal(got.shipment.status, 'returned_to_partner');
  assert.ok(shipOf(2).returned_at);
  assert.equal((await wh.confirmReturnedToPartner({ shipment: shipOf(2), profile: STAFF })).duplicate, true);
});

test('courier wording for dispatched parcels, and finding a parcel by CN', async () => {
  const w = ret.normalizeDispatchStatus;
  assert.equal(w('Delivered'), 'delivered');
  assert.equal(w('Out for delivery'), 'in_transit');
  assert.equal(w('Delivery attempt failed'), 'failed_delivery');
  assert.equal(w('Return to origin'), 'returning_to_partner');
  assert.equal(w('Returned to shipper'), 'returning_to_partner');
  assert.equal(w('Booked'), null);
  await book(1, 'SAME1234');
  await book(2, 'same1234', 'c-leo');
  assert.match((await wh.findDispatchByCn({ cn: 'SAME1234' })).error, /more than one courier/i);
  assert.equal((await wh.findDispatchByCn({ cn: 'same1234', courier: 'leopards' })).shipment.order_id, 'order-2');
  assert.match((await wh.findDispatchByCn({ cn: 'ZZZ99999' })).error, /No dispatched parcel/i);
});
