/** Extra materials added during Cutting / Stitching: saved against the order, reviewed by the admin, charged once on the invoice. */
import { test, mock, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeDb } from './fake-supabase.mjs';

let db;
let svc;
let fin;
const dbProxy = new Proxy({}, { get: (_, key) => db[key] });
const noop = async () => {};

before(async () => {
  mock.module('../src/config/supabase.js', { namedExports: { supabaseAdmin: dbProxy, supabase: dbProxy } });
  mock.module('../src/services/notification.service.js', { namedExports: { notifyAdmins: noop, notifyPartner: noop, notifyUser: noop, notifyStaff: noop, partnerRecipients: async () => [] } });
  svc = await import('../src/services/extra-cost.service.js');
  fin = await import('../src/controllers/finance.controller.js');
});

beforeEach(() => {
  db = createFakeDb({
    orders: [{ id: 'o1', reference: 'SA-1', status: 'stitching', partner_id: 'p1', order_kind: 'order', destination_country: 'Pakistan' }],
    order_units: [{ id: 'u1', order_id: 'o1', line_no: 1, unit_title: 'Lawn', weight_kg: 0.8 }],
    job_cards: [{ id: 'j1', order_id: 'o1', unit_id: 'u1', stage: 'stitching', partner_id: 'p1' }],
    order_extra_costs: [], order_events: [], invoices: [], invoice_lines: [], shipping_rates: [], price_items: [],
  }, { uniques: { order_extra_costs: { when: (r) => !!r.client_key, key: (r) => `${r.order_id}|${r.client_key}` }, invoice_lines: { when: (r) => !!r.extra_cost_id, key: (r) => r.extra_cost_id } } });
});

const add = (body, key) => svc.createExtraCost({ orderId: 'o1', body: { name: 'Lining', quantity: 2, unit_price: 150, client_key: key, ...body }, profile: { full_name: 'Sara' }, userId: 'u-p' });

test('an item is saved against the order with its total worked out, who added it, and the stage it was added in', async () => {
  const { cost, duplicate } = await add({ notes: 'cotton' }, 'k1');
  assert.equal(duplicate, false);
  assert.equal(cost.total_pkr, 300);
  assert.equal(cost.order_id, 'o1');
  assert.equal(cost.stage, 'stitching');
  assert.equal(cost.status, 'pending');
  assert.equal(cost.added_by_name, 'Sara');
  assert.equal(db.table('orders')[0].reference, 'SA-1', 'the original order is untouched');
});

test('submitting the same item twice makes one entry', async () => {
  await add({}, 'same');
  const second = await add({}, 'same');
  assert.equal(second.duplicate, true);
  assert.equal(db.table('order_extra_costs').length, 1);
});

test('the rules: a name, a quantity above 0, a price, and only while an article is being cut or stitched', async () => {
  await assert.rejects(() => add({ name: ' ' }, 'a'), /name/i);
  await assert.rejects(() => add({ quantity: 0 }, 'b'), /quantity/i);
  await assert.rejects(() => add({ unit_price: -5 }, 'c'), /price/i);
  db.table('job_cards')[0].stage = 'qc';
  await assert.rejects(() => add({}, 'd'), /Cutting or Stitching/);
  db.table('job_cards')[0].stage = 'cutting';
  assert.equal((await add({}, 'e')).cost.stage, 'cutting');
  db.table('orders')[0].status = 'packed';
  await assert.rejects(() => add({}, 'f'), /no longer/);
});

test('only the partner that owns the item can change it, and only before the admin decides', async () => {
  const { cost } = await add({}, 'k');
  await assert.rejects(() => svc.updateExtraCost({ id: cost.id, body: { quantity: 3 }, access: { isAdmin: false, partnerId: 'other' } }), /another partner/);
  const updated = await svc.updateExtraCost({ id: cost.id, body: { quantity: 3 }, access: { isAdmin: false, partnerId: 'p1' } });
  assert.equal(updated.total_pkr, 450);
  await svc.decideExtraCost({ id: cost.id, decision: 'approve', userId: 'admin' });
  await assert.rejects(() => svc.updateExtraCost({ id: cost.id, body: { quantity: 4 }, access: { isAdmin: false, partnerId: 'p1' } }), /can no longer/);
  await assert.rejects(() => svc.deleteExtraCost({ id: cost.id, access: { isAdmin: false, partnerId: 'p1' } }), /can no longer/);
});

const call = (fn, req) => new Promise((resolve) => {
  const res = { status() { return this; }, json(body) { resolve({ body }); return this; } };
  fn(req, res, (err) => resolve({ err }));
});

test('the invoice takes only approved items, each once; the line carries the cost and the partner is paid back', async () => {
  const { cost } = await add({}, 'k');
  db.table('orders')[0].status = 'packed';
  const req = (lines) => ({ params: { orderId: 'o1' }, body: { currency: 'PKR', lines }, userId: 'admin-1', access: { isAdmin: true, permissions: new Set() } });
  const line = svc.extraCostLine(cost);
  assert.equal(line.customer_amount, 300);
  assert.equal(line.partner_amount, 300);

  const pending = await call(fin.saveInvoiceDraft, req([line]));
  assert.match(pending.err?.message || '', /approved/i, 'a pending item cannot be invoiced');

  await svc.decideExtraCost({ id: cost.id, decision: 'approve', userId: 'admin' });
  const twice = await call(fin.saveInvoiceDraft, req([line, line]));
  assert.match(twice.err?.message || '', /twice/i);

  const ok = await call(fin.saveInvoiceDraft, req([line]));
  assert.equal(ok.err, undefined, ok.err?.message);
  assert.equal(db.table('invoice_lines').filter((l) => l.extra_cost_id === cost.id).length, 1);
  // saving again replaces the lines: the cost is still counted once
  await call(fin.saveInvoiceDraft, req([line]));
  assert.equal(db.table('invoice_lines').filter((l) => l.extra_cost_id === cost.id).length, 1);
  assert.equal(db.table('invoices')[0].total_pkr, 300);

  await assert.rejects(() => svc.decideExtraCost({ id: cost.id, decision: 'reject', userId: 'admin' }), /on the invoice/);
});

test('express charges: one line each from the order prices, none when express is off, never twice, whatever the browser sends', async () => {
  const o = db.table('orders')[0];
  o.status = 'packed';
  Object.assign(o, { express_stitching: true, express_stitching_price: 1500, express_days: 3, express_shipping: true, express_shipping_price: 800, express_shipping_days: 2 });
  const req = (lines) => ({ params: { orderId: 'o1' }, body: { currency: 'PKR', lines }, userId: 'admin-1', access: { isAdmin: true, permissions: new Set() } });
  const base = { kind: 'other', label: 'Stitching', customer_amount: 1000 };
  const fake = [{ kind: 'express_stitching', label: 'Express stitching', customer_amount: 1 }, { kind: 'express_stitching', label: 'again', customer_amount: 1 }];
  const ok = await call(fin.saveInvoiceDraft, req([base, ...fake]));
  assert.equal(ok.err, undefined, ok.err?.message);
  const express = () => db.table('invoice_lines').filter((l) => l.kind.startsWith('express_'));
  assert.deepEqual(express().map((l) => [l.kind, l.customer_amount]).sort(), [['express_shipping', 800], ['express_stitching', 1500]]);
  assert.equal(db.table('invoices')[0].total_pkr, 3300);
  // saving again (regenerating) does not add them twice
  await call(fin.saveInvoiceDraft, req([base]));
  assert.equal(express().length, 2);
  assert.equal(db.table('invoices')[0].total_pkr, 3300);
  // express switched off: the charges leave the payable total
  Object.assign(o, { express_stitching: false, express_stitching_price: null, express_shipping: false, express_shipping_price: null });
  await call(fin.saveInvoiceDraft, req([base]));
  assert.equal(express().length, 0);
  assert.equal(db.table('invoices')[0].total_pkr, 1000);
});
