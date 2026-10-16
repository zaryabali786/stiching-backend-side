/**
 * Article weights: the shipment weight is the total of the weights of the articles it covers, and a missing weight is never assumed 0.
 * Real service + controller code, in-memory database.
 */
import { test, mock, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeDb } from './fake-supabase.mjs';

let db;
let w;
let fin;
const dbProxy = new Proxy({}, { get: (_, key) => db[key] });
const noop = async () => {};

before(async () => {
  mock.module('../src/config/supabase.js', { namedExports: { supabaseAdmin: dbProxy, supabase: dbProxy } });
  mock.module('../src/services/notification.service.js', { namedExports: { notifyAdmins: noop, notifyPartner: noop, notifyUser: noop, notifyUsers: noop, notifyStaff: noop, partnerRecipients: async () => [] } });
  w = await import('../src/services/weight.service.js');
  fin = await import('../src/controllers/finance.controller.js');
});

beforeEach(() => {
  db = createFakeDb({
    orders: [
      { id: 'o1', reference: 'SA-1', status: 'packed', partner_id: 'p1', order_kind: 'order', destination_country: 'Pakistan', weight_kg: null },
      { id: 'o-old', reference: 'SA-0', status: 'packed', partner_id: 'p1', order_kind: 'order', destination_country: 'Pakistan', weight_kg: 1.5 },
      { id: 'r1', reference: 'SA-1-1-RET', status: 'packed', order_kind: 'return', return_unit_id: 'u1', partner_id: 'p1', destination_country: 'Pakistan', weight_kg: null },
    ],
    shipping_rates: [], invoices: [], invoice_lines: [],
    order_units: [
      { id: 'u1', order_id: 'o1', line_no: 1, code: 'SA-1-1', unit_title: 'Lawn 3pc', weight_kg: 0.8 },
      { id: 'u2', order_id: 'o1', line_no: 2, code: 'SA-1-2', unit_title: 'Kurta', weight_kg: null },
      { id: 'u3', order_id: 'o1', line_no: 3, code: 'SA-1-3', unit_title: 'Dupatta', weight_kg: 0.25 },
      { id: 'uo', order_id: 'o-old', line_no: 1, code: 'SA-0-1', unit_title: 'Old suit', weight_kg: null },
    ],
  });
});

const order = (id) => db.table('orders').find((o) => o.id === id);
const unit = (id) => db.table('order_units').find((u) => u.id === id);

test('validation: weight must be a number above 0 and below 50, never blank', () => {
  assert.equal(w.parseWeight('0.65'), 0.65);
  assert.equal(w.parseWeight(1.23456), 1.235);
  for (const bad of ['', null, undefined, 0, -1, 50, 'abc']) assert.throws(() => w.parseWeight(bad), /weight in kg/i);
});

test('a missing article weight is named and the total is not guessed', async () => {
  const info = await w.orderWeightInfo(order('o1'));
  assert.equal(info.total_kg, null);
  assert.deepEqual(info.missing.map((m) => m.title), ['Kurta']);
  assert.match(w.missingWeightMessage(info), /Kurta \(SA-1-2\)/);
  await assert.rejects(() => w.requireOrderWeight(order('o1')), /Kurta/);
});

test('the total is the sum of the article weights once all are entered (one article and several)', async () => {
  await w.saveUnitWeight({ unit: unit('u2'), order: order('o1'), weight: '0.45' });
  const info = await w.orderWeightInfo(order('o1'));
  assert.equal(info.total_kg, 1.5);
  assert.equal(info.source, 'articles');
  assert.equal(order('o1').weight_kg, 1.5, 'orders.weight_kg follows, so the Warehouse and couriers see the same weight');
  // a single-article order
  db.table('order_units').splice(0, db.table('order_units').length, { id: 'a', order_id: 'o1', line_no: 1, unit_title: 'Only', weight_kg: 2.2 });
  assert.equal((await w.orderWeightInfo(order('o1'))).total_kg, 2.2);
});

test('only the articles of the shipment count: a return order weighs its one article', async () => {
  const info = await w.orderWeightInfo(order('r1'));
  assert.equal(info.total_kg, 0.8);
  assert.equal(info.units.length, 1, 'the other articles of the original order are not counted');
});

test('an older order with no article weights keeps its own weight; with none at all it is blocked', async () => {
  const old = await w.orderWeightInfo(order('o-old'));
  assert.equal(old.total_kg, 1.5);
  assert.equal(old.source, 'order');
  order('o-old').weight_kg = null;
  await assert.rejects(() => w.requireOrderWeight(order('o-old')), /Old suit/);
});

const call = (fn, req) => new Promise((resolve) => {
  const res = { status() { return this; }, json(body) { resolve({ body }); return this; } };
  fn(req, res, (err) => resolve({ err }));
});

test('invoice builder: shipping weight comes from the articles, and saving is blocked until every article has a weight', async () => {
  db.table('shipping_rates').push({ id: 'sr1', courier: 'TCS', zone: 'Pakistan', countries: ['Pakistan'], is_active: true, base_rate: 300, max_weight_kg: 1, per_extra_kg: 100 });
  const req = (body) => ({ params: { orderId: 'o1' }, body, userId: 'admin-1', access: { all: true } });
  const lines = [{ kind: 'other', label: 'x', customer_amount: 10 }];
  const blocked = await call(fin.saveInvoiceDraft, req({ currency: 'PKR', lines, shipping_rate_id: 'sr1' }));
  assert.match(blocked.err?.message || '', /Kurta/);
  assert.equal(db.table('invoices').length, 0);

  await w.saveUnitWeight({ unit: unit('u2'), order: order('o1'), weight: 0.45 });
  const ok = await call(fin.saveInvoiceDraft, req({ currency: 'PKR', lines, shipping_rate_id: 'sr1' }));
  assert.equal(ok.err, undefined, ok.err?.message);
  const ship = db.table('invoice_lines').find((l) => l.kind === 'shipping');
  assert.match(ship.description, /1\.5 kg/);
  assert.equal(ship.customer_amount, 400, '1.5 kg on a 1 kg allowance = base 300 + 1 started kg x 100');
});
