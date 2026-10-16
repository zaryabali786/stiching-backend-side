/**
 * PostEx integration: the CLIENT's own behaviour (what it sends, and that it never reports a success PostEx did not confirm).
 *
 * IMPORTANT: PostEx is not called here. The responses below are fixtures written to the SHAPE the client expects; they are not recordings
 * of PostEx, and passing these tests does not prove PostEx answers this way. The endpoints and field names come from a third-party client
 * of the v4.1.9 API (see postex.service.js); verify them against PostEx's documentation and a real token before relying on this.
 */
import { test, mock, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeDb } from './fake-supabase.mjs';
import { config } from '../src/config/env.js';

let db;
let px;
let sync;
let wh;
let provider;
const dbProxy = new Proxy({}, { get: (_, key) => db[key] });
const noop = async () => {};

before(async () => {
  mock.module('../src/config/supabase.js', { namedExports: { supabaseAdmin: dbProxy, supabase: dbProxy } });
  mock.module('../src/services/notification.service.js', { namedExports: { notifyAdmins: noop, notifyPartner: noop, notifyUser: noop, notifyUsers: noop, notifyStaff: noop, partnerRecipients: async () => [] } });
  px = await import('../src/services/postex.service.js');
  sync = await import('../src/services/postex-tracking.service.js');
  wh = await import('../src/services/dispatch-shipment.service.js');
  provider = await import('../src/services/courier-provider.service.js');
});

const STAFF = { id: 'staff-1' };
const ORDER = { id: 'order-1', reference: 'SA-5001', status: 'paid', partner_id: 'p1', partner_route: null, customer_id: 'cust-1', customer_name: 'Zaryab Ali', customer_code: 'STX-1', destination_address: 'House 91, Kharepull', destination_city: 'Lahore', destination_country: 'Pakistan', destination_phone: '+92 304 4954013', weight_kg: 1, shipping_service: 'standard' };

let calls;
const reply = (status, body) => async (url, init) => { calls.push({ url: String(url), init }); return { ok: status >= 200 && status < 300, status, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) }; };

beforeEach(() => {
  calls = [];
  config.postex.token = 'test-token';
  config.postex.pickupAddressCode = '001';
  px.setPostexTransport(null);
  db = createFakeDb({
    orders: [{ ...ORDER }],
    order_units: [{ id: 'u1', order_id: 'order-1', unit_title: 'Lawn 3pc', quantity: 2 }],
    invoices: [{ order_id: 'order-1', status: 'paid' }],
    couriers: [{ id: 'c-px', name: 'PostEx', status: 'active' }, { id: 'c-tcs', name: 'TCS', status: 'active' }],
  }, { uniques: { shipment_events: { when: (r) => !!r.event_id, key: (r) => `${r.shipment_id}|${r.event_id}` }, return_shipment_events: { when: (r) => !!r.event_id, key: (r) => `${r.shipment_id}|${r.event_id}` } } });
  px.registerPostex();
});

const OK_CREATE = { statusCode: '200', statusMessage: 'ORDER HAS BEEN CREATED', dist: { trackingNumber: '3007070009' } };

test('without a token nothing is called and PostEx stays a manual courier', async () => {
  config.postex.token = '';
  px.setPostexTransport(reply(200, OK_CREATE));
  await assert.rejects(() => px.bookParcel({ order: ORDER, itemsCount: 1 }), /not configured/i);
  assert.equal(calls.length, 0);
  assert.equal(px.postexConfigured(), false);
});

test('the booking request carries the token, the verified endpoint and the order data; the paid order is not collected on delivery', async () => {
  px.setPostexTransport(reply(200, OK_CREATE));
  const r = await px.bookParcel({ order: ORDER, itemsCount: 2, description: 'Lawn 3pc' });
  assert.equal(r.cn, '3007070009');
  const c = calls[0];
  assert.equal(c.init.method, 'POST');
  assert.match(c.url, /^https:\/\/api\.postex\.pk\/services\/integration\/api\/order\/v3\/create-order$/);
  assert.equal(c.init.headers.token, 'test-token');
  const body = JSON.parse(c.init.body);
  assert.equal(body.customerName, 'Zaryab Ali');
  assert.equal(body.customerPhone, '03044954013', 'PostEx wants the 03xxxxxxxxx format');
  assert.equal(body.deliveryAddress, 'House 91, Kharepull');
  assert.equal(body.cityName, 'Lahore');
  assert.equal(body.invoicePayment, 0, 'already paid online: nothing to collect');
  assert.equal(body.items, 2);
  assert.equal(body.orderRefNumber, 'SA-5001');
  assert.equal(body.pickupAddressCode, '001');
});

test('an order with a missing phone, address or city is refused before PostEx is called', async () => {
  px.setPostexTransport(reply(200, OK_CREATE));
  await assert.rejects(() => px.bookParcel({ order: { ...ORDER, destination_phone: '12' } }), /mobile number/i);
  await assert.rejects(() => px.bookParcel({ order: { ...ORDER, destination_address: '' } }), /delivery address/i);
  await assert.rejects(() => px.bookParcel({ order: { ...ORDER, destination_city: '' } }), /city/i);
  assert.equal(calls.length, 0);
});

test('a booking counts only when PostEx confirms it with a tracking number (it fails closed)', async () => {
  px.setPostexTransport(reply(500, { statusMessage: 'Server error' }));
  await assert.rejects(() => px.bookParcel({ order: ORDER }), /Server error/);
  px.setPostexTransport(reply(200, { statusCode: '400', statusMessage: 'INVALID CITY' }));
  await assert.rejects(() => px.bookParcel({ order: ORDER }), /INVALID CITY/);
  px.setPostexTransport(reply(200, { statusCode: '200', statusMessage: 'OK', dist: {} }));
  await assert.rejects(() => px.bookParcel({ order: ORDER }), /no tracking number/i);
  px.setPostexTransport(reply(200, 'not json at all'));
  await assert.rejects(() => px.bookParcel({ order: ORDER }), /no tracking number/i);
});

test('a timeout on create-order is never retried and is reported as an unknown outcome', async () => {
  let n = 0;
  px.setPostexTransport(async () => { n += 1; const e = new Error('aborted'); e.name = 'AbortError'; throw e; });
  await assert.rejects(() => px.bookParcel({ order: ORDER }), (e) => e.unknownOutcome === true && /in time/.test(e.message));
  assert.equal(n, 1, 'a booking is not repeated automatically');
});

test('reading tracking is retried after a temporary failure', async () => {
  let n = 0;
  px.setPostexTransport(async () => { n += 1; if (n < 3) throw new Error('network'); return { ok: true, status: 200, text: async () => JSON.stringify({ statusCode: '200', dist: { transactionStatus: 'Delivered', transactionStatusHistory: [{ transactionStatusMessage: 'Delivered', updatedAt: '2026-10-14T10:00:00Z' }] } }) }; });
  const t = await px.trackParcel('3007070009');
  assert.equal(n, 3);
  assert.equal(t.current, 'Delivered');
});

test('PostEx wording is mapped by text: only "delivered" delivers, a failed attempt is not a return, unknown wording moves nothing', () => {
  const m = px.mapPostexStatus;
  assert.equal(m('Delivered'), 'delivered');
  assert.equal(m('Package on Route'), 'in_transit');
  assert.equal(m('At PostEx Warehouse'), 'in_transit');
  assert.equal(m('Delivery Attempted - Customer not available'), 'failed_delivery');
  assert.equal(m('Undelivered'), 'failed_delivery');
  assert.equal(m('Returned to Shipper'), 'returning_to_partner');
  assert.equal(m('Return in transit'), 'returning_to_partner');
  assert.equal(m('Delivery Under Review'), null);
  assert.equal(m('Something new'), null);
  assert.equal(m(''), null);
});

test('a tracking response in an unrecognised format is an error, not a guess', () => {
  assert.throws(() => px.parseTracking({ foo: 'bar' }), /does not recognise/i);
  assert.throws(() => px.parseTracking({ statusCode: '404', statusMessage: 'NOT FOUND' }), /NOT FOUND/);
});

const seedShipmentFlow = async () => {
  const courier = { id: 'c-px', name: 'PostEx' };
  px.setPostexTransport(reply(200, OK_CREATE));
  await wh.bookDispatch({ order: { ...db.table('orders')[0] }, courierId: courier.id, profile: STAFF });
  const ship = db.table('shipments')[0];
  const sheet = await wh.createDispatchLoadsheet({ shipmentIds: [ship.id], profile: STAFF });
  await wh.markDownloaded({ sheetId: sheet.id, profile: STAFF });
  await wh.confirmDispatchHandover({ sheetId: sheet.id, profile: STAFF });
  return db.table('shipments')[0];
};

test('booking from the warehouse: the API result is saved as an API booking; a failure saves nothing; a manual CN skips the API', async () => {
  px.setPostexTransport(reply(200, { statusCode: '400', statusMessage: 'INVALID ADDRESS' }));
  await assert.rejects(() => wh.bookDispatch({ order: { ...db.table('orders')[0] }, courierId: 'c-px', profile: STAFF }), /INVALID ADDRESS/);
  assert.equal(db.table('shipments').length, 0);
  assert.equal(db.table('orders')[0].status, 'paid', 'a failed booking does not move the parcel');

  // booked outside the system: the CN is typed in and PostEx is not called
  calls = [];
  const manual = await wh.bookDispatch({ order: { ...db.table('orders')[0] }, courierId: 'c-px', cn: 'PX-MANUAL-1', manual: true, profile: STAFF });
  assert.equal(manual.booking_source, 'manual');
  assert.equal(calls.length, 0);
  await wh.cancelDispatchBooking({ order: { ...db.table('orders')[0] }, profile: STAFF });
  assert.equal(calls.length, 0, 'a manual booking is not cancelled at PostEx');

  px.setPostexTransport(reply(200, OK_CREATE));
  const api = await wh.bookDispatch({ order: { ...db.table('orders')[0] }, courierId: 'c-px', profile: STAFF });
  assert.equal(api.booking_source, 'api');
  assert.equal(api.tracking_number, '3007070009');
  assert.deepEqual(api.booking_response, OK_CREATE, 'the raw PostEx response is kept');
  assert.equal(db.table('orders')[0].status, 'partner_dispatch');
  await assert.rejects(() => wh.bookDispatch({ order: { ...db.table('orders')[0] }, courierId: 'c-px', profile: STAFF }), /already has a booking/i);
});

test('cancelling an API booking cancels it at PostEx first; if PostEx refuses, the booking stays', async () => {
  px.setPostexTransport(reply(200, OK_CREATE));
  await wh.bookDispatch({ order: { ...db.table('orders')[0] }, courierId: 'c-px', profile: STAFF });
  px.setPostexTransport(reply(200, { statusCode: '400', statusMessage: 'ALREADY PICKED UP' }));
  await assert.rejects(() => wh.cancelDispatchBooking({ order: { ...db.table('orders')[0] }, profile: STAFF }), /did not cancel/i);
  assert.equal(db.table('shipments')[0].status, 'booked');
  px.setPostexTransport(reply(200, { statusCode: '200', statusMessage: 'CANCELLED' }));
  await wh.cancelDispatchBooking({ order: { ...db.table('orders')[0] }, profile: STAFF });
  assert.equal(db.table('shipments')[0].status, 'needs_label');
  assert.equal(calls.at(-1).init.method, 'PUT');
  assert.match(calls.at(-1).url, /cancel-order$/);
});

test('tracking sync applies PostEx history once: in transit, a failed attempt (still dispatched), then delivered', async () => {
  const ship = await seedShipmentFlow();
  const history = (list) => ({ statusCode: '200', dist: { transactionStatus: list.at(-1).t, transactionStatusHistory: list.map((x) => ({ transactionStatusMessage: x.t, transactionStatusMessageCode: x.c, updatedAt: x.at })) } });
  const h1 = [{ t: 'Package on Route', c: '0004', at: '2026-10-14T08:00:00Z' }, { t: 'Delivery Attempted - customer not available', c: '0013', at: '2026-10-14T12:00:00Z' }];
  px.setPostexTransport(reply(200, history(h1)));
  const first = await sync.syncPostexShipment({ ...ship });
  assert.equal(first.applied, 2);
  assert.equal(db.table('shipments')[0].status, 'failed_delivery');
  assert.equal(db.table('orders')[0].status, 'shipped', 'a failed attempt is not a return and not a delivery');
  assert.notEqual(db.table('shipments')[0].status, 'returning_to_partner');

  const again = await sync.syncPostexShipment({ ...db.table('shipments')[0] });
  assert.equal(again.applied, 0, 'the same history changes nothing');

  px.setPostexTransport(reply(200, history([...h1, { t: 'Delivered', c: '0005', at: '2026-10-15T09:00:00Z' }])));
  const last = await sync.syncPostexShipment({ ...db.table('shipments')[0] });
  assert.equal(last.applied, 1);
  assert.equal(db.table('shipments')[0].status, 'delivered');
  assert.equal(db.table('orders')[0].status, 'delivered');
});

test('PostEx confirming a return to the shipper moves the parcel to Failed delivery, and wording we cannot map is only recorded', async () => {
  const ship = await seedShipmentFlow();
  px.setPostexTransport(reply(200, { statusCode: '200', dist: { transactionStatusHistory: [
    { transactionStatusMessage: 'Some new PostEx wording', updatedAt: '2026-10-14T08:00:00Z' },
    { transactionStatusMessage: 'Returned to Shipper', updatedAt: '2026-10-16T08:00:00Z' },
  ] } }));
  await sync.syncPostexShipment({ ...ship });
  assert.equal(db.table('shipments')[0].status, 'returning_to_partner');
  assert.ok(db.table('shipment_events').some((e) => e.status === 'courier_update' && /new PostEx wording/.test(e.note)));
  assert.equal(db.table('shipments')[0].returned_at ?? null, null, 'not received until the partner confirms');
});

test('the courier registry: PostEx has an API provider only while configured', () => {
  assert.equal(provider.supportsApiBooking('PostEx'), true);
  assert.equal(provider.supportsApiBooking('TCS'), false);
});

test('the admin saves the token in settings: it is never returned, a non-PostEx address is refused, and saving switches API booking on', async () => {
  config.postex.token = '';
  px.unregisterForTest?.();
  assert.equal(provider.supportsApiBooking('PostEx') && px.postexConfigured(), false);
  await assert.rejects(() => px.savePostexSettings({ baseUrl: 'http://api.postex.pk' }, 'admin-1'), /https/i);
  await assert.rejects(() => px.savePostexSettings({ baseUrl: 'https://evil.example.com' }, 'admin-1'), /postex\.pk/i);
  await assert.rejects(() => px.savePostexSettings({ pollMinutes: -1 }, 'admin-1'), /0 to 1440/);

  const view = await px.savePostexSettings({ token: 'secret-token-1234', pickupAddressCode: '002', pollMinutes: 30 }, 'admin-1');
  assert.equal(view.configured, true);
  assert.equal(view.source, 'settings');
  assert.equal(view.tokenHint, '••••1234');
  assert.ok(!JSON.stringify(view).includes('secret-token'), 'the token is never returned');
  assert.equal(view.pickupAddressCode, '002');
  assert.equal(provider.supportsApiBooking('PostEx'), true);

  // an empty token keeps the saved one; removing it switches the API off again
  assert.equal((await px.savePostexSettings({ token: '', orderType: 'Normal' }, 'admin-1')).tokenHint, '••••1234');
  const cleared = await px.savePostexSettings({ clearToken: true }, 'admin-1');
  assert.equal(cleared.configured, false);
  assert.equal(provider.supportsApiBooking('PostEx'), false);
  px.setPostexTransport(reply(200, OK_CREATE));
  await assert.rejects(() => px.bookParcel({ order: ORDER }), /not configured/i);
});

test('a customer return is booked with PostEx from the partner to the return address; a brand return needs a manual CN; a failed booking saves nothing', async () => {
  const ret = await import('../src/services/return-shipment.service.js');
  db.table('order_units').push({
    id: 'u-ret', order_id: 'order-1', unit_title: 'Lawn 3pc', code: 'SA-5001-1', status: 'received', review_status: 'rejected', return_status: 'requested', return_to: 'customer',
    return_shipping: { name: 'Sara Khan', phone: '0300 1234567', address: 'Flat 4, Gulberg III', city: 'Lahore', country: 'Pakistan' },
  });
  const unit = () => ({ ...db.table('order_units').find((u) => u.id === 'u-ret') });
  const order = { ...db.table('orders')[0] };

  px.setPostexTransport(reply(200, { statusCode: '400', statusMessage: 'INVALID CITY' }));
  await assert.rejects(() => ret.bookReturn({ order, unit: unit(), courierId: 'c-px', profile: STAFF }), /INVALID CITY/);
  assert.equal(db.table('return_shipments').length, 0, 'a refused booking saves nothing');
  assert.equal(unit().return_status, 'requested');

  px.setPostexTransport(reply(200, OK_CREATE));
  const s = await ret.bookReturn({ order, unit: unit(), courierId: 'c-px', profile: STAFF });
  assert.equal(s.booking_source, 'api');
  assert.equal(s.cn_number, '3007070009');
  assert.deepEqual(s.booking_response, OK_CREATE);
  const sent = JSON.parse(calls.at(-1).init.body);
  assert.equal(sent.customerName, 'Sara Khan', 'the parcel goes to the return address the customer gave');
  assert.equal(sent.deliveryAddress, 'Flat 4, Gulberg III');
  assert.equal(sent.orderRefNumber, 'SA-5001-1-RET', 'a return has its own reference');
  assert.equal(sent.invoicePayment, 0);
  await assert.rejects(() => ret.bookReturn({ order, unit: unit(), courierId: 'c-px', profile: STAFF }), /already has a CN/i);

  // cancelling an API booking cancels it at PostEx first
  px.setPostexTransport(reply(200, { statusCode: '400', statusMessage: 'ALREADY PICKED UP' }));
  await assert.rejects(() => ret.cancelBooking({ order, unit: unit(), profile: STAFF }), /did not cancel/i);
  px.setPostexTransport(reply(200, { statusCode: '200', statusMessage: 'CANCELLED' }));
  await ret.cancelBooking({ order, unit: unit(), profile: STAFF });
  assert.equal(db.table('return_shipments')[0].status, 'cancelled');

  // a return to the brand has no stored address: it cannot go through the API, and a manual CN still works
  db.table('order_units').find((u) => u.id === 'u-ret').return_to = 'brand';
  await assert.rejects(() => ret.bookReturn({ order, unit: unit(), courierId: 'c-px', profile: STAFF }), /goes to the brand/i);
  const manual = await ret.bookReturn({ order, unit: unit(), courierId: 'c-px', cn: 'PX-BRAND-77', manual: true, profile: STAFF });
  assert.equal(manual.booking_source, 'manual');
});

test('PostEx tracking of a return parcel: only in transit and delivered move it; a failed attempt is just recorded', async () => {
  const ret = await import('../src/services/return-shipment.service.js');
  db.table('order_units').push({ id: 'u-ret', order_id: 'order-1', unit_title: 'Lawn 3pc', code: 'SA-5001-1', status: 'received', review_status: 'rejected', return_status: 'sent_back', return_to: 'customer' });
  db.table('return_shipments').push({ id: 'rs-1', order_id: 'order-1', unit_id: 'u-ret', partner_id: 'p1', courier_id: 'c-px', courier_name: 'PostEx', cn_number: '3007070009', status: 'handed_over', booking_source: 'api', return_to: 'customer' });
  px.setPostexTransport(reply(200, { statusCode: '200', dist: { transactionStatusHistory: [
    { transactionStatusMessage: 'Package on Route', updatedAt: '2026-10-14T08:00:00Z' },
    { transactionStatusMessage: 'Delivery Attempted - not available', updatedAt: '2026-10-14T12:00:00Z' },
  ] } }));
  const first = await sync.syncPostexReturn({ ...db.table('return_shipments')[0] });
  assert.equal(first.applied, 2);
  assert.equal(db.table('return_shipments')[0].status, 'in_transit');
  assert.equal(db.table('order_units').find((u) => u.id === 'u-ret').return_status, 'sent_back', 'a failed attempt does not mark the return delivered');
  assert.equal((await sync.syncPostexReturn({ ...db.table('return_shipments')[0] })).applied, 0, 'the same history changes nothing');

  px.setPostexTransport(reply(200, { statusCode: '200', dist: { transactionStatusHistory: [{ transactionStatusMessage: 'Delivered', updatedAt: '2026-10-15T09:00:00Z' }] } }));
  await sync.syncPostexReturn({ ...db.table('return_shipments')[0] });
  assert.equal(db.table('return_shipments')[0].status, 'delivered');
  assert.equal(db.table('order_units').find((u) => u.id === 'u-ret').return_status, 'returned');
  void ret;
});


test('phones are sent the way the PostEx guide wants them: 03xxxxxxxxx', () => {
  for (const v of ['+92 304 4954013', '0092 304 4954013', '923044954013', '0304-4954013', '304 4954013', '03044954013']) assert.equal(px.localPhone(v), '03044954013', v);
});

test('an invalid address code from PostEx is explained and nothing is booked; with no codes set none are sent', async () => {
  px.setPostexTransport(reply(200, { statusCode: '400', statusMessage: 'INVALID MERCHANT STORE ADDRESS CODE' }));
  await assert.rejects(() => px.bookParcel({ order: ORDER }), (e) => /INVALID MERCHANT STORE ADDRESS CODE/.test(e.message) && /Load my PostEx addresses/.test(e.message));
  config.postex.pickupAddressCode = '';
  config.postex.storeAddressCode = '';
  await px.savePostexSettings({ pickupAddressCode: '', storeAddressCode: '' }, null); // an earlier test saved a code in the module's settings
  px.setPostexTransport(reply(200, OK_CREATE));
  await px.bookParcel({ order: ORDER });
  const body = JSON.parse(calls.at(-1).init.body);
  assert.ok(!('pickupAddressCode' in body) && !('storeAddressCode' in body), 'PostEx then uses the default pickup address');
});

test("the guide's message codes decide the status; a parcel still at the merchant or under review moves nothing", () => {
  const m = px.mapPostexStatus;
  assert.equal(m("At Merchant's Warehouse", '0001'), null);
  assert.equal(m('At PostEx Warehouse', '0003'), 'in_transit');
  assert.equal(m('Package on Root', '0004'), 'in_transit');
  assert.equal(m('Delivered', '0005'), 'delivered');
  assert.equal(m('Returned', '0006'), 'returning_to_partner');
  assert.equal(m('Delivery Under Review', '0008'), null);
  assert.equal(m('Attempt Made: Customer not available', '0013'), 'failed_delivery');
  assert.equal(m("At Merchant's Warehouse"), null, 'by wording too');
});

test('the CN slip is escaped HTML with one slip per parcel; PostEx airway bills must really be PDFs', async () => {
  const { cnSlipsHtml } = await import('../src/services/cn-slip.service.js');
  const html = cnSlipsHtml([{ courier: 'PostEx', cn: 'CX-123', order: 'SA-1', customer: '<script>alert(1)</script>', address: 'A & B "street"', city: 'Lahore' }, { courier: 'TCS', cn: 'T-9', order: 'SA-2', customer: 'Ali', address: 'x', city: 'y' }]);
  assert.equal((html.match(/class="slip"/g) || []).length, 2);
  assert.ok(!html.includes('<script>alert(1)</script>'), 'values are escaped');
  assert.ok(html.includes('&lt;script&gt;') && html.includes('A &amp; B &quot;street&quot;'));
  assert.ok(html.includes('CX-123') && html.includes('T-9'));

  const pdf = Buffer.from('%PDF-1.4 fake');
  px.setPostexTransport(async (url, init) => { calls.push({ url: String(url), init }); return { ok: true, status: 200, arrayBuffer: async () => pdf.buffer.slice(pdf.byteOffset, pdf.byteOffset + pdf.length) }; });
  const out = await px.airwayBillPdf(['CX-1', 'CX-2']);
  assert.equal(out.subarray(0, 4).toString(), '%PDF');
  assert.match(calls.at(-1).url, /\/v1\/get-invoice\?trackingNumbers=CX-1,CX-2$/);
  assert.equal(calls.at(-1).init.headers.token, 'test-token');

  // an answer that is not a PDF is an error, with PostEx's message when it gave one
  px.setPostexTransport(async () => ({ ok: true, status: 200, arrayBuffer: async () => { const b = Buffer.from(JSON.stringify({ statusMessage: 'ORDER NOT FOUND' })); return b.buffer.slice(b.byteOffset, b.byteOffset + b.length); } }));
  await assert.rejects(() => px.airwayBillPdf(['CX-1']), /ORDER NOT FOUND/);
  await assert.rejects(() => px.airwayBillPdf(Array.from({ length: 11 }, (_, i) => `CX-${i}`)), /at most 10/);
  await assert.rejects(() => px.airwayBillPdf([]), /No CN/);
});
