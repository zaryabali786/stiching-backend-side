/**
 * Splitting a mixed Shopify order into its Stitch&Ship part and its normal part, in our records: what each group is worth and how much of the
 * ONE real payment covers it. Pure arithmetic, nothing touches Shopify or the database. The five-product example: A and B are stitching,
 * C, D and E are normal.
 */
import { test, mock, before } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeDb } from './fake-supabase.mjs';

let split;
const db = createFakeDb({});
const dbProxy = new Proxy({}, { get: (_, key) => db[key] });

before(async () => {
  mock.module('../src/config/supabase.js', { namedExports: { supabaseAdmin: dbProxy, supabase: dbProxy } });
  split = await import('../src/services/shopify-split.service.js');
});

const line = (id, price, quantity, extra = {}) => ({ id, title: `Product ${id}`, variant_title: 'M', sku: `SKU-${id}`, product_id: 900 + id, variant_id: 800 + id, price, quantity, discount_allocations: [], tax_lines: [], ...extra });
// A 100.00 x1 (tax 10.00) | B 50.00 x2 (10.00 off, tax 9.00) | C 30.00 (tax 3.00) | D 20.00 (2.00 off, tax 1.80) | E 10.00 x3 (tax 3.00) | shipping 15.00 (tax 1.50)
const order = (extra = {}) => ({
  id: 5001,
  name: '#1005',
  currency: 'PKR',
  taxes_included: false,
  financial_status: 'paid',
  total_price: '311.30',
  line_items: [
    line(1, '100.00', 1, { tax_lines: [{ price: '10.00' }] }),
    line(2, '50.00', 2, { discount_allocations: [{ amount: '10.00' }], tax_lines: [{ price: '9.00' }] }),
    line(3, '30.00', 1, { tax_lines: [{ price: '3.00' }] }),
    line(4, '20.00', 1, { discount_allocations: [{ amount: '2.00' }], tax_lines: [{ price: '1.80' }] }),
    line(5, '10.00', 3, { tax_lines: [{ price: '3.00' }] }),
  ],
  shipping_lines: [{ price: '15.00', discounted_price: '15.00', tax_lines: [{ price: '1.50' }] }],
  ...extra,
});
const STITCH = ['1', '2'];
const alloc = (o = order(), ids = STITCH) => split.allocateOrder(o, ids);
const verified = (received, refunded = 0, refunds = [], status = 'paid') => ({ financial_status: status, total_received: received, total_refunded: refunded, transactions_ok: true, refunds });

test('shareOut always adds up to the whole, whatever the weights', () => {
  assert.deepEqual(split.shareOut(100, [1, 1, 1]), [34, 33, 33]);
  assert.deepEqual(split.shareOut(0, [5, 5]), [0, 0]);
  assert.deepEqual(split.shareOut(7, [0, 0], 1), [0, 7], 'no weights: everything to the fallback');
  for (let n = 0; n < 300; n++) {
    const total = Math.floor(Math.random() * 100000);
    const weights = [Math.floor(Math.random() * 90000), Math.floor(Math.random() * 90000), Math.floor(Math.random() * 90000)];
    assert.equal(split.shareOut(total, weights).reduce((a, b) => a + b, 0), total);
  }
});

test('the five-product order: each group has its own products, subtotal, discounts, taxes, shipping and total', () => {
  const a = alloc();
  assert.equal(a.mixed, true);
  const s = a.groups.stitchship;
  const n = a.groups.normal;
  assert.deepEqual(s.line_ids, ['1', '2']);
  assert.deepEqual(n.line_ids, ['3', '4', '5']);
  assert.deepEqual(s.lines.map((l) => [l.title, l.variant_id, l.sku, l.quantity]), [['Product 1', 801, 'SKU-1', 1], ['Product 2', 802, 'SKU-2', 2]], 'variants and quantities are kept');
  assert.equal(s.subtotal, 200);
  assert.equal(s.discounts, 10);
  assert.equal(s.taxes, 19);
  assert.equal(n.subtotal, 80);
  assert.equal(n.discounts, 2);
  assert.equal(n.taxes, 7.8);
  // shipping 15.00 and its tax 1.50 are shared by what each group is worth after discounts (190.00 : 78.00)
  assert.equal(s.shipping, 10.63);
  assert.equal(n.shipping, 4.37);
  assert.equal(s.shipping_tax, 1.06);
  assert.equal(n.shipping_tax, 0.44);
  assert.equal(s.total, 220.69);
  assert.equal(n.total, 90.61);
  assert.equal(a.currency, 'PKR');
});

test('the two groups reconcile with the checkout total, to the cent', () => {
  const a = alloc();
  assert.equal(a.order_total, 311.3);
  assert.equal(a.allocated_total, 311.3);
  assert.equal(a.unallocated, 0);
  assert.equal(a.reconciled, true);
  assert.equal(Math.round((a.groups.stitchship.total + a.groups.normal.total) * 100), 31130);
});

test('anything Shopify counted that no line owns (a tip, duties) is shown, not hidden in a group', () => {
  const a = alloc(order({ total_price: '316.30' }));
  assert.equal(a.reconciled, false);
  assert.equal(a.unallocated, 5);
  assert.equal(a.allocated_total, 311.3);
});

test('prices that already include tax: the tax is part of the price, not added again', () => {
  const o = order({ taxes_included: true, total_price: String((20000 - 1000 + 8000 - 200 + 1500) / 100) });
  const a = alloc(o);
  assert.equal(a.groups.stitchship.taxes, 19, 'the tax is still reported');
  assert.equal(a.groups.stitchship.total, 190 + a.groups.stitchship.shipping, 'but the total does not add it');
  assert.equal(a.reconciled, true);
});

test('an order with only stitching lines is not mixed: one group, all the shipping', () => {
  const o = order({ line_items: order().line_items.slice(0, 2), total_price: '240.00' });
  const a = alloc(o);
  assert.equal(a.mixed, false);
  assert.equal(a.groups.normal.line_ids.length, 0);
  assert.equal(a.groups.normal.total, 0);
  assert.equal(a.groups.stitchship.shipping, 15);
});

// ───────────── the payment ─────────────

test('fully paid and verified by Shopify\'s transactions: each group is covered by its share of the one payment', () => {
  const a = alloc();
  const fin = split.readFinancials(order(), verified(311.3));
  assert.equal(fin.verified, true);
  const p = split.allocatePayment(a, fin);
  assert.deepEqual(p.groups.stitchship, { amount_paid: 220.69, outstanding: 0, refunded: 0, payment_status: 'paid' });
  assert.deepEqual(p.groups.normal, { amount_paid: 90.61, outstanding: 0, refunded: 0, payment_status: 'paid' });
  assert.equal(p.original_received, 311.3, 'the original payment is counted once');
  assert.equal(p.groups.stitchship.amount_paid + p.groups.normal.amount_paid, 311.3);
  assert.equal(p.payment_verified, true);
});

test('unpaid: nothing is paid, the whole of each group is outstanding', () => {
  const o = order({ financial_status: 'pending' });
  const p = split.allocatePayment(alloc(o), split.readFinancials(o, verified(0, 0, [], 'pending')));
  assert.equal(p.groups.stitchship.payment_status, 'unpaid');
  assert.equal(p.groups.stitchship.outstanding, 220.69);
  assert.equal(p.groups.normal.outstanding, 90.61);
});

test('partly paid: the payment is shared by what each group is worth and neither group is called paid', () => {
  const o = order({ financial_status: 'partially_paid' });
  const p = split.allocatePayment(alloc(o), split.readFinancials(o, verified(100, 0, [], 'partially_paid')));
  assert.equal(p.groups.stitchship.amount_paid, 70.89);
  assert.equal(p.groups.normal.amount_paid, 29.11);
  assert.equal(p.groups.stitchship.amount_paid + p.groups.normal.amount_paid, 100);
  assert.equal(p.groups.stitchship.payment_status, 'partially_paid');
  assert.equal(p.groups.normal.payment_status, 'partially_paid');
  assert.equal(Math.round((p.groups.stitchship.outstanding + p.groups.normal.outstanding) * 100), 21130);
});

test('a refunded line belongs to its group; money not tied to a line is shared by total', () => {
  const o = order({ financial_status: 'partially_refunded' });
  const refunds = [{ total: 11000, lines: [{ line_id: '1', cents: 11000 }] }];
  const p = split.allocatePayment(alloc(o), split.readFinancials(o, verified(311.3, 110, refunds, 'partially_refunded')));
  assert.equal(p.groups.stitchship.refunded, 110);
  assert.equal(p.groups.stitchship.payment_status, 'partially_refunded');
  assert.equal(p.groups.normal.refunded, 0);
  assert.equal(p.groups.normal.payment_status, 'paid', 'the other group is untouched');
  const shipping = split.allocatePayment(alloc(o), split.readFinancials(o, verified(311.3, 15, [{ total: 1500, lines: [] }], 'partially_refunded')));
  assert.equal(shipping.groups.stitchship.refunded + shipping.groups.normal.refunded, 15, 'a shipping refund is shared and adds up');
});

test('fully refunded: both groups say refunded and nothing refunded twice', () => {
  const o = order({ financial_status: 'refunded' });
  const refunds = [{ total: 31130, lines: order().line_items.map((l) => ({ line_id: String(l.id), cents: 0 })) }];
  const p = split.allocatePayment(alloc(o), split.readFinancials(o, verified(311.3, 311.3, refunds, 'refunded')));
  assert.equal(p.groups.stitchship.payment_status, 'refunded');
  assert.equal(p.groups.normal.payment_status, 'refunded');
  assert.equal(p.groups.stitchship.refunded, 220.69);
  assert.equal(p.groups.normal.refunded, 90.61);
});

test('without Shopify\'s transactions nothing is called verified paid: "paid_unverified" at best', () => {
  const o = order();
  const fin = split.readFinancials(o, null);
  assert.equal(fin.verified, false);
  const p = split.allocatePayment(alloc(o), fin);
  assert.equal(p.groups.stitchship.payment_status, 'paid_unverified');
  assert.equal(p.payment_verified, false);
});

test('transactions that do not add up to Shopify\'s own total are not verified', () => {
  const o = order();
  const fin = split.readFinancials(o, { ...verified(311.3), transactions_ok: false });
  assert.equal(fin.verified, false);
});

test('an unclear Shopify status or no figures: payment verification is pending, never paid', () => {
  for (const status of ['voided', 'authorized_weird', '']) {
    const o = order({ financial_status: status });
    const p = split.allocatePayment(alloc(o), split.readFinancials(o, null));
    assert.equal(p.groups.stitchship.payment_status, 'verification_pending', `status "${status}"`);
    assert.equal(p.groups.stitchship.amount_paid, null);
    assert.equal(p.groups.stitchship.outstanding, null);
  }
  const partlyNoFigures = order({ financial_status: 'partially_paid' });
  assert.equal(split.allocatePayment(alloc(partlyNoFigures), split.readFinancials(partlyNoFigures, null)).groups.normal.payment_status, 'verification_pending');
});

test('pending and authorized (not collected) are unpaid, not unknown', () => {
  for (const status of ['pending', 'authorized']) {
    const o = order({ financial_status: status });
    const p = split.allocatePayment(alloc(o), split.readFinancials(o, null));
    assert.equal(p.groups.stitchship.payment_status, 'unpaid', status);
    assert.equal(p.groups.stitchship.amount_paid, 0);
  }
});

test('refunds in the webhook order (no transaction list) are read per line too', () => {
  const o = order({ financial_status: 'partially_refunded', refunds: [{ refund_line_items: [{ line_item_id: 3, subtotal: '30.00', total_tax: '3.00' }], transactions: [{ kind: 'refund', status: 'success', amount: '33.00' }] }] });
  const p = split.allocatePayment(alloc(o), split.readFinancials(o, null));
  assert.equal(p.groups.normal.refunded, 33);
  assert.equal(p.groups.stitchship.refunded, 0);
});
