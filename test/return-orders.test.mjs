/**
 * A rejected article that goes back to the customer is handled by the Warehouse: Send to Admin (transfer to the admin warehouse) or
 * Return Directly to Customer (invoice, payment, courier, loadsheet, dispatch, delivery). Real service code, in-memory database.
 */
import { test, mock, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeDb } from './fake-supabase.mjs';

let db;
let ro;
let wh;
let rs;
let orderSvc;
const dbProxy = new Proxy({}, { get: (_, key) => db[key] });
const noop = async () => {};

before(async () => {
  mock.module('../src/config/supabase.js', { namedExports: { supabaseAdmin: dbProxy, supabase: dbProxy } });
  mock.module('../src/services/notification.service.js', { namedExports: { notifyAdmins: noop, notifyPartner: noop, notifyUser: noop, notifyUsers: noop, notifyStaff: noop, partnerRecipients: async () => [] } });
  orderSvc = await import('../src/services/order.service.js');
  ro = await import('../src/services/return-order.service.js');
  wh = await import('../src/services/dispatch-shipment.service.js');
  rs = await import('../src/services/return-shipment.service.js');
});

const STAFF = { id: 'staff-1' };
const SHIP = { name: 'Sara Khan', phone: '0300 1234567', address: 'Flat 4, Gulberg III', city: 'Lahore', country: 'Pakistan' };

beforeEach(() => {
  db = createFakeDb({
    orders: [{ id: 'order-1', reference: 'SA-7001', status: 'received', customer_id: 'cust-1', customer_name: 'Zaryab Ali', customer_code: 'STX-1', partner_id: 'p1', brand: 'Alkaram', order_kind: 'order', destination_city: 'Lahore', destination_country: 'Pakistan', destination_address: 'Home', destination_phone: '03001112222', shipping_service: 'standard' }],
    order_units: [
      { id: 'u1', order_id: 'order-1', line_no: 1, code: 'SA-7001-1', unit_title: 'Lawn 3pc', status: 'received', review_status: 'rejected', review_note: 'Wrong colour', return_status: 'requested', return_to: 'customer', return_shipping: SHIP },
      { id: 'u2', order_id: 'order-1', line_no: 2, code: 'SA-7001-2', unit_title: 'Kurta', status: 'received', review_status: 'rejected', return_status: 'requested', return_to: 'brand', return_shipping: null },
    ],
    couriers: [{ id: 'c-tcs', name: 'TCS', status: 'active' }],
  });
});

const orig = () => db.table('orders').find((o) => o.id === 'order-1');
const unit = (id) => db.table('order_units').find((u) => u.id === id);
const retOrder = () => db.table('orders').find((o) => o.order_kind === 'return');
const route = (id, destination) => ro.createReturnOrder({ order: { ...orig() }, unit: { ...unit(id) }, destination, profile: STAFF });

test('Return Directly to Customer makes a return order that waits for its invoice, carrying the article, the address and the reason', async () => {
  const created = await route('u1', 'customer');
  assert.equal(created.reference, 'SA-7001-1-RET');
  assert.equal(created.order_kind, 'return');
  assert.equal(created.status, 'packed', 'it appears in Warehouse > Waiting for invoice');
  assert.equal(created.return_unit_id, 'u1');
  assert.equal(created.return_destination, 'customer');
  assert.equal(created.customer_name, 'Sara Khan');
  assert.equal(created.destination_address, 'Flat 4, Gulberg III');
  assert.equal(created.partner_id, 'p1');
  assert.match(created.customer_notes, /SA-7001/);
  assert.match(created.customer_notes, /Wrong colour/);
  assert.equal(db.table('orders').length, 2, 'the original order is not duplicated');
  assert.equal(db.table('order_units').length, 2, 'the article is not copied');
  assert.equal(unit('u1').return_status, 'requested', 'the article is untouched until the parcel actually ships');
  assert.equal(db.table('transfers').length, 0, 'a direct return is not put in a transfer');
});

test('Send to Admin joins the partner transfer to the admin warehouse with no invoice, like any paid parcel sent to the admin', async () => {
  const created = await route('u1', 'admin');
  assert.equal(created.status, 'paid');
  assert.equal(retOrder().partner_route, 'admin_warehouse');
  const transfer = db.table('transfers')[0];
  assert.ok(transfer && transfer.status === 'open' && transfer.partner_id === 'p1');
  assert.equal(retOrder().transfer_id, transfer.id);
  assert.equal(db.table('invoices').length, 0, 'no invoice is made for a transfer to the admin');
  // a second return of the same partner joins the SAME open transfer
  const second = await route('u2', 'admin');
  assert.equal(db.table('transfers').length, 1);
  assert.equal(db.table('orders').find((o) => o.id === second.id).transfer_id, transfer.id);
});

test('the rules: only a requested return, once, and Return Directly to Customer only for a return that goes to the customer', async () => {
  await assert.rejects(() => route('u1', 'somewhere'), /Send to Admin or Return Directly/);
  await assert.rejects(() => route('u2', 'customer'), /not to them|brand/i);
  const bad = unit('u1');
  bad.return_shipping = { ...SHIP, phone: '123' };
  await assert.rejects(() => route('u1', 'customer'), /phone/i);
  bad.return_shipping = { ...SHIP, address: '' };
  await assert.rejects(() => route('u1', 'customer'), /address is missing/i);
  bad.return_shipping = SHIP;
  await route('u1', 'customer');
  await assert.rejects(() => route('u1', 'admin'), /already in the Warehouse/i, 'one return order per article');
  await assert.rejects(() => rs.bookReturn({ order: { ...orig() }, unit: { ...unit('u1') }, courierId: 'c-tcs', cn: 'TCS12345', manual: true, profile: STAFF }), /already in the Warehouse/i, 'the old courier booking cannot run on top');
  unit('u2').return_status = 'none';
  await assert.rejects(() => route('u2', 'admin'), /asked to return/i);
});

test('an article booked the old way cannot also be routed to the Warehouse', async () => {
  await rs.bookReturn({ order: { ...orig() }, unit: { ...unit('u1') }, courierId: 'c-tcs', cn: 'TCS12345', manual: true, profile: STAFF });
  await assert.rejects(() => route('u1', 'customer'), /already has a courier booking/i);
  assert.equal(await ro.returnIsRouted('u1'), true);
});

test('a direct return goes through the normal Warehouse: invoice paid, courier booked, loadsheet, handover, delivery. The article follows', async () => {
  await route('u1', 'customer');
  const id = retOrder().id;
  // payment of the return invoice (the existing invoice / payment flow sets the order to Paid)
  db.table('invoices').push({ id: 'inv-1', order_id: id, status: 'paid' });
  retOrder().status = 'paid';

  const booked = await wh.bookDispatch({ order: { ...retOrder() }, courierId: 'c-tcs', cn: 'TCS99887', profile: STAFF });
  assert.equal(booked.status, 'booked');
  assert.equal(retOrder().status, 'partner_dispatch');
  await assert.rejects(() => wh.bookDispatch({ order: { ...retOrder() }, courierId: 'c-tcs', cn: 'TCS11111', profile: STAFF }), /already has a booking/i, 'no duplicate booking');
  assert.equal(db.table('shipments').length, 1);

  const sheet = await wh.createDispatchLoadsheet({ shipmentIds: [booked.id], profile: STAFF });
  await wh.markDownloaded({ sheetId: sheet.id, profile: STAFF });
  assert.equal(unit('u1').return_status, 'requested', 'a downloaded loadsheet is not a shipment');
  await wh.confirmDispatchHandover({ sheetId: sheet.id, profile: STAFF });
  assert.equal(retOrder().status, 'shipped');
  assert.equal(unit('u1').return_status, 'sent_back', 'the article is now on its way back');
  assert.equal(unit('u1').return_courier, 'TCS');
  assert.equal(unit('u1').return_tracking, 'TCS99887');

  await wh.recordDispatchTracking({ shipment: db.table('shipments')[0], status: 'delivered', source: 'manual', profile: STAFF });
  assert.equal(retOrder().status, 'delivered');
  assert.equal(unit('u1').return_status, 'returned', 'delivery to the customer = Returned');
  assert.equal(db.table('order_unit_events').filter((e) => e.unit_id === 'u1' && e.status === 'return_delivered').length, 1);
  assert.equal(db.table('orders').length, 2, 'still no duplicate order');
});

test('a return sent to the admin follows the admin warehouse: shipped and delivered by the admin, and the article follows', async () => {
  await route('u1', 'admin');
  const id = retOrder().id;
  await orderSvc.setOrderStatus(id, 'at_admin_warehouse', { actorId: 'admin-1' });
  assert.equal(unit('u1').return_status, 'requested', 'in the admin warehouse is not shipped yet');
  await orderSvc.setOrderStatus(id, 'shipped', { actorId: 'admin-1' });
  assert.equal(unit('u1').return_status, 'sent_back');
  await orderSvc.setOrderStatus(id, 'delivered', { actorId: 'admin-1' });
  assert.equal(unit('u1').return_status, 'returned');
  // an ordinary order is never touched by this
  await orderSvc.setOrderStatus('order-1', 'assigned', { actorId: 'admin-1', soft: true });
  assert.equal(unit('u2').return_status, 'requested');
});

test('the Receiving list can tell which articles are already in the Warehouse', async () => {
  await route('u1', 'customer');
  const map = await ro.returnOrdersForUnits(['u1', 'u2']);
  assert.equal(map.get('u1').reference, 'SA-7001-1-RET');
  assert.equal(map.get('u1').destination, 'customer');
  assert.equal(map.has('u2'), false);
});

test('a return sent to the Warehouse leaves the Receiving return tabs and shows in the Warehouse list', async () => {
  const partner = await import('../src/controllers/partner.controller.js');
  const call = (fn, req) => new Promise((resolve) => {
    const res = { status() { return this; }, json(body) { resolve({ body }); return this; } };
    fn(req, res, (err) => resolve({ err }));
  });
  unit('u2').return_status = 'none';
  const req = (tab) => ({ query: { tab }, access: { isAdmin: true, permissions: new Set() }, profile: STAFF, userId: 'staff-1' });
  const counts = async () => (await call(partner.getReceiving, req('return_requested'))).body.meta.counts;
  assert.equal((await counts()).return_requested, 1, 'waiting for a routing choice: shown in Return Requested');
  await route('u1', 'customer');
  const after = await counts();
  for (const t of ['return_requested', 'ready_return', 'handed_over', 'returns']) assert.equal(after[t], 0, `gone from ${t} once in the Warehouse`);
  assert.equal(retOrder().status, 'packed', 'it is a Warehouse order waiting for its invoice');
  assert.equal(db.table('orders').length, 2, 'no duplicate record');
});
