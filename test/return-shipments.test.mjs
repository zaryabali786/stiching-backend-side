/**
 * The courier workflow of a returned article: book the CN, make and hand over the loadsheet, tracking, delivery = Returned.
 * Runs the real service code against an in-memory database. There is no courier API in this project: the partner enters the
 * CN, and tracking comes from the webhook / a person; delivery is never inferred from anything else.
 */
import { test, mock, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeDb } from './fake-supabase.mjs';
import { articleGroup, articleState } from '../src/services/unit-flow.service.js';

let db;
let ship;
const dbProxy = new Proxy({}, { get: (_, key) => db[key] });
const noop = async () => {};

before(async () => {
  mock.module('../src/config/supabase.js', { namedExports: { supabaseAdmin: dbProxy, supabase: dbProxy } });
  mock.module('../src/services/notification.service.js', { namedExports: { notifyAdmins: noop, notifyPartner: noop, notifyUser: noop, notifyStaff: noop, partnerRecipients: async () => [] } });
  ship = await import('../src/services/return-shipment.service.js');
});

const PARTNER = 'partner-1';
const STAFF = { id: 'staff-1', full_name: 'Partner Staff' };

const seed = () => {
  db = createFakeDb({
    orders: [{ id: 'order-1', reference: 'SA-3001', status: 'received', customer_id: 'cust-1', partner_id: PARTNER, parcel_review: 'pending', has_issue: true }],
    order_units: [1, 2, 3].map((n) => ({
      id: `unit-${n}`, order_id: 'order-1', line_no: n, code: `SA-3001-${n}`, unit_title: `Article ${n}`, status: 'received', review_status: 'rejected',
      return_status: n === 3 ? 'none' : 'requested', return_to: 'customer', resubmit_count: 0,
      return_shipping: { name: 'Zaryab', phone: '+923001234567', address: 'House 1, Street 2', city: 'Lahore', country: 'Pakistan' },
    })),
    couriers: [{ id: 'c-tcs', name: 'TCS', status: 'active' }, { id: 'c-leo', name: 'Leopards', status: 'active' }],
  }, {
    uniques: {
      return_shipment_events: { when: (r) => !!r.event_id, key: (r) => `${r.shipment_id}|${r.event_id}` },
      return_shipments: { when: (r) => r.status !== 'cancelled', key: (r) => r.unit_id },
    },
  });
};
beforeEach(seed);

const order = () => db.table('orders')[0];
const unit = (n) => db.table('order_units').find((u) => u.id === `unit-${n}`);
const book = (n, cn, courier = 'c-tcs') => ship.bookReturn({ order: order(), unit: { ...unit(n) }, courierId: courier, cn, profile: STAFF });
const unitEvents = (n) => db.table('order_unit_events').filter((e) => e.unit_id === `unit-${n}`).map((e) => e.status);

test('only a returned article the customer asked to send back can be booked, with a real CN, once', async () => {
  await assert.rejects(() => book(3, 'TCS12345'), /asked to return/i, 'a rejected article without a return request cannot be booked');
  await assert.rejects(() => book(1, '12'), /CN/i, 'a CN must be entered');
  await assert.rejects(() => book(1, 'TCS12345', 'no-such-courier'), /courier/i);

  const s = await book(1, 'TCS12345');
  assert.equal(s.status, 'booked');
  assert.equal(s.courier_name, 'TCS');
  assert.equal(s.booking_source, 'manual', 'no courier API is called: the CN is typed in');
  assert.equal(s.unit_id, 'unit-1');
  assert.equal(unit(1).return_status, 'requested', 'booking alone does not hand anything over');

  await assert.rejects(() => book(1, 'TCS99999'), /already has a CN/i, 'no second booking for the same article');
  await assert.rejects(() => book(2, 'tcs12345'), /already used/i, 'the same CN cannot be used for another article');
  const other = await book(2, 'tcs12345', 'c-leo');
  assert.equal(other.courier_name, 'Leopards', 'the same number at another courier is a different parcel');
});

test('a booking can be cancelled while the parcel is not handed over, then booked again', async () => {
  await book(1, 'TCS12345');
  await ship.cancelBooking({ order: order(), unit: { ...unit(1) }, profile: STAFF });
  assert.equal(db.table('return_shipments')[0].status, 'cancelled');
  const again = await book(1, 'TCS54321');
  assert.equal(again.cn_number, 'TCS54321');
  await assert.rejects(() => ship.cancelBooking({ order: order(), unit: { ...unit(2) }, profile: STAFF }), /no CN/i);
});

test('the loadsheet lists only booked parcels of one courier and hands nothing over by itself', async () => {
  const a = await book(1, 'TCS12345');
  const b = await book(2, 'LEO55555', 'c-leo');
  await assert.rejects(() => ship.createLoadsheet({ shipmentIds: [], profile: STAFF }), /select at least one/i);
  await assert.rejects(() => ship.createLoadsheet({ shipmentIds: [a.id, b.id], profile: STAFF }), /one courier/i);
  await assert.rejects(() => ship.createLoadsheet({ shipmentIds: [a.id], profile: STAFF, canAccess: () => false }), /another partner/i);

  const sheet = await ship.createLoadsheet({ shipmentIds: [a.id], profile: STAFF, canAccess: (p) => p === PARTNER });
  assert.match(sheet.number ?? 'LS-', /LS-|^$/);
  assert.equal(sheet.items.length, 1);
  assert.equal(sheet.items[0].cn, 'TCS12345');
  const csv = ship.loadsheetCsv({ ...sheet, number: 'LS-1001' });
  assert.ok(csv.includes('TCS12345') && csv.includes('SA-3001') && csv.includes('SA-3001-1') && csv.includes('Lahore'), 'the file matches the parcels');
  assert.ok(!csv.includes('LEO55555'), 'a parcel that was not selected is not on the sheet');
  assert.equal(db.table('return_shipments').find((s) => s.id === a.id).status, 'booked', 'generating the file does not hand the parcel over');
  assert.equal(unit(1).return_status, 'requested');
});

test('downloading the loadsheet hands the parcels over once; a repeat changes nothing; a failed download leaves them booked', async () => {
  const a = await book(1, 'TCS12345');
  const b = await book(2, 'TCS12346');
  const failed = await ship.createLoadsheet({ shipmentIds: [a.id, b.id], profile: STAFF });
  // the download failed: confirmHandover was never called
  assert.equal(db.table('return_shipments').every((s) => s.status === 'booked'), true);

  const sheet = await ship.createLoadsheet({ shipmentIds: [a.id, b.id], profile: STAFF });
  assert.notEqual(sheet.id, failed.id);
  assert.equal(db.table('return_loadsheets').find((x) => x.id === failed.id).status, 'void', 'the sheet that was never downloaded is replaced');
  await assert.rejects(() => ship.confirmHandover({ sheetId: failed.id, profile: STAFF }), /replaced/i);

  const done = await ship.confirmHandover({ sheetId: sheet.id, profile: STAFF });
  assert.equal(done.count, 2);
  assert.ok(db.table('return_shipments').every((s) => s.status === 'handed_over' && s.handed_over_at && s.loadsheet_id === sheet.id));
  assert.equal(unit(1).return_status, 'sent_back', 'the customer now sees it as sent back');
  assert.equal(unit(1).return_courier, 'TCS');
  assert.equal(unit(1).return_tracking, 'TCS12345');

  const again = await ship.confirmHandover({ sheetId: sheet.id, profile: STAFF });
  assert.equal(again.already, true);
  assert.equal(again.count, 0);
  assert.equal(unitEvents(1).filter((e) => e === 'returned').length, 1, 'handing over twice does not log twice');
  await assert.rejects(() => ship.cancelBooking({ order: order(), unit: { ...unit(1) }, profile: STAFF }), /already handed over/i);
});

test('delivery is recorded only after the handover, only from a tracking event, and only once', async () => {
  const a = await book(1, 'TCS12345');
  // a booked CN is not a delivery
  await assert.rejects(() => ship.recordTracking({ shipment: a, status: 'delivered', source: 'webhook', eventId: 'e0', profile: null }), /not been handed over/i);
  assert.equal(unit(1).return_status, 'requested');

  const sheet = await ship.createLoadsheet({ shipmentIds: [a.id], profile: STAFF });
  // a generated (not downloaded) loadsheet is not a handover either
  await assert.rejects(() => ship.recordTracking({ shipment: a, status: 'in_transit', source: 'manual', profile: STAFF }), /not been handed over/i);
  await ship.confirmHandover({ sheetId: sheet.id, profile: STAFF });
  const handed = db.table('return_shipments')[0];

  const t = await ship.recordTracking({ shipment: handed, status: 'in_transit', source: 'webhook', eventId: 'e1', profile: null });
  assert.equal(t.shipment.status, 'in_transit');
  assert.equal(unit(1).return_status, 'sent_back', 'in transit is not delivered');
  const dupTransit = await ship.recordTracking({ shipment: handed, status: 'in_transit', source: 'webhook', eventId: 'e1', profile: null });
  assert.equal(dupTransit.duplicate, true, 'the same courier event twice is stored once');

  const delivered = await ship.recordTracking({ shipment: handed, status: 'delivered', source: 'webhook', eventId: 'e2', profile: null });
  assert.equal(delivered.shipment.status, 'delivered');
  assert.ok(delivered.shipment.delivered_at);
  assert.equal(unit(1).return_status, 'returned', 'the article is Returned');
  assert.equal(articleGroup(unit(1)), 'return');
  assert.equal(articleState({ unit: unit(1), card: null, order: order() }), 'returned');

  const again = await ship.recordTracking({ shipment: handed, status: 'delivered', source: 'webhook', eventId: 'e3', profile: null });
  assert.equal(again.duplicate, true, 'a second delivery event does not process the return again');
  assert.equal(unitEvents(1).filter((e) => e === 'return_delivered').length, 1);
  const events = db.table('return_shipment_events').filter((e) => e.shipment_id === handed.id).map((e) => e.status);
  assert.deepEqual(events, ['booked', 'handed_over', 'in_transit', 'delivered']);
  // the other articles of the order are untouched
  assert.equal(unit(2).return_status, 'requested');
});

test('courier wording is mapped to the two tracking statuses; anything else is not acted on', () => {
  assert.equal(ship.normalizeCourierStatus('Delivered'), 'delivered');
  assert.equal(ship.normalizeCourierStatus('delivered to customer'), 'delivered');
  assert.equal(ship.normalizeCourierStatus('In Transit'), 'in_transit');
  assert.equal(ship.normalizeCourierStatus('Out for delivery'), 'in_transit');
  assert.equal(ship.normalizeCourierStatus('Booked'), null);
  assert.equal(ship.normalizeCourierStatus('Delivery attempt failed'), null);
});

test('a webhook finds its parcel by CN, and asks for the courier when two couriers share a CN', async () => {
  const a = await book(1, 'SAME1234');
  await book(2, 'SAME1234', 'c-leo');
  const ambiguous = await ship.findShipmentByCn({ cn: 'same1234' });
  assert.match(ambiguous.error, /more than one courier/i);
  const exact = await ship.findShipmentByCn({ cn: 'same1234', courier: 'tcs' });
  assert.equal(exact.shipment.id, a.id);
  assert.match((await ship.findShipmentByCn({ cn: 'nothing-here' })).error, /No return shipment/i);
});
