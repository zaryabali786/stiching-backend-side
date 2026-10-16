/** Production order of stages: ... QC -> Pressing -> Packed. An article cannot skip Pressing, and packing asks for no weight. */
import { test, mock, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeDb } from './fake-supabase.mjs';

let db;
let prod;
const dbProxy = new Proxy({}, { get: (_, key) => db[key] });
const noop = async () => {};

before(async () => {
  mock.module('../src/config/supabase.js', { namedExports: { supabaseAdmin: dbProxy, supabase: dbProxy } });
  mock.module('../src/services/notification.service.js', { namedExports: { notifyAdmins: noop, notifyPartner: noop, notifyUser: noop, notifyUsers: noop, notifyStaff: noop, partnerRecipients: async () => [] } });
  prod = await import('../src/controllers/production.controller.js');
});

beforeEach(() => {
  db = createFakeDb({
    orders: [{ id: 'o1', reference: 'SA-1', status: 'qc_passed', partner_id: 'p1', customer_id: 'c1' }],
    order_units: [{ id: 'u1', order_id: 'o1', line_no: 1, unit_title: 'Lawn', status: 'received', weight_kg: 0.8 }],
    job_cards: [{ id: 'j1', order_id: 'o1', unit_id: 'u1', stage: 'qc', qc_passed: true, approval_status: 'approved', unit_title: 'Lawn', partner_id: 'p1', position: 1 }],
    job_card_comments: [], order_unit_events: [], order_events: [],
  });
});

const call = (fn, req) => new Promise((resolve) => {
  const res = { status() { return this; }, json(body) { resolve({ body }); return this; } };
  fn({ userId: 'u', profile: { full_name: 'Tester' }, access: { isAdmin: true, permissions: new Set() }, ...req }, res, (err) => resolve({ err }));
});
const card = () => db.table('job_cards')[0];

test('a card cannot be dragged from QC straight to Packed', async () => {
  const r = await call(prod.moveCard, { params: { id: 'j1' }, body: { stage: 'packed' } });
  assert.match(r.err?.message || '', /Pressing next/);
  assert.equal(card().stage, 'qc');
});

test('Pressing needs a passed QC, and a card waiting for the customer cannot move on', async () => {
  card().qc_passed = false;
  assert.match((await call(prod.moveCard, { params: { id: 'j1' }, body: { stage: 'pressing' } })).err?.message || '', /not passed quality check/);
  card().qc_passed = true;
  card().approval_status = 'pending';
  assert.match((await call(prod.moveCard, { params: { id: 'j1' }, body: { stage: 'pressing' } })).err?.message || '', /waiting for the customer/);
});

test('the order cannot be packed before Pressing; sending it to Pressing first lets it be packed, with no weight asked', async () => {
  const early = await call(prod.packOrder, { params: { orderId: 'o1' }, body: {} });
  assert.match(early.err?.message || '', /finish Pressing before packing/);
  assert.equal(card().stage, 'qc');

  const sent = await call(prod.sendOrderToPressing, { params: { orderId: 'o1' }, body: {} });
  assert.equal(sent.err, undefined, sent.err?.message);
  assert.equal(card().stage, 'pressing');
  assert.equal(db.table('order_unit_events').some((e) => e.status === 'pressing'), true);

  const packed = await call(prod.packOrder, { params: { orderId: 'o1' }, body: {} });
  assert.equal(packed.err, undefined, packed.err?.message);
  assert.equal(card().stage, 'packed');
  assert.equal(db.table('orders')[0].weight_kg, 0.8, 'the order weight is the article weight from Receiving');
});
