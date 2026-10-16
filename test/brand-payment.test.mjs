/** Brand website orders: the payment type read from the confirmation email is saved as stated, never guessed, and never contradicted. */
import { test, mock, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeDb } from './fake-supabase.mjs';

let db;
let m;
let ai;
const dbProxy = new Proxy({}, { get: (_, key) => db[key] });
const noop = async () => {};

before(async () => {
  mock.module('../src/config/supabase.js', { namedExports: { supabaseAdmin: dbProxy, supabase: dbProxy } });
  mock.module('../src/services/notification.service.js', { namedExports: { notifyAdmins: noop, notifyPartner: noop, notifyUser: noop, notifyStaff: noop, partnerRecipients: async () => [] } });
  m = await import('../src/services/email-order-match.service.js');
  ai = await import('../src/services/ai.service.js');
});

beforeEach(() => {
  db = createFakeDb({ orders: [{ id: 'o1', reference: 'SA-1', status: 'draft', brand_payment_method: null, brand_payment_status: null }], order_events: [] });
});
const order = () => db.table('orders')[0];

test('the extractor keeps only a stated payment: unknown values become null, nothing is invented', () => {
  const a = ai.normaliseExtracted({ is_order: true, items: [], payment_method: 'Visa ending 4242', payment_status: 'paid' });
  assert.equal(a.payment_method, 'Visa ending 4242');
  assert.equal(a.payment_status, 'paid');
  const b = ai.normaliseExtracted({ is_order: true, items: [], payment_status: 'maybe' });
  assert.equal(b.payment_method, null);
  assert.equal(b.payment_status, null);
});

test('payment details are saved on the order once, a method is not overwritten, paid is never taken back', async () => {
  assert.deepEqual(await m.applyPaymentUpdate({ ...order() }, { payment_method: null, payment_status: null }), { changed: false }, 'an email that says nothing changes nothing (no assumed paid / COD)');
  await m.applyPaymentUpdate({ ...order() }, { payment_method: 'Credit card', payment_status: 'paid' });
  assert.equal(order().brand_payment_method, 'Credit card');
  assert.equal(order().brand_payment_status, 'paid');
  const again = await m.applyPaymentUpdate({ ...order() }, { payment_method: 'Credit card', payment_status: 'paid' });
  assert.equal(again.changed, false, 'the same email processed twice changes nothing');
  await m.applyPaymentUpdate({ ...order() }, { payment_method: 'Bank transfer', payment_status: 'pending' });
  assert.equal(order().brand_payment_method, 'Credit card', 'the first method stays');
  assert.equal(order().brand_payment_status, 'paid', 'a later "pending" cannot undo "paid"');
});

test('pending can be upgraded to paid by a later email; cash on delivery is recognised', async () => {
  await m.applyPaymentUpdate({ ...order() }, { payment_method: 'Bank transfer', payment_status: 'pending' });
  await m.applyPaymentUpdate({ ...order() }, { payment_method: null, payment_status: 'paid' });
  assert.equal(order().brand_payment_status, 'paid');
  assert.equal(m.isCod('Cash on Delivery'), true);
  assert.equal(m.isCod('COD'), true);
  assert.equal(m.isCod('Visa'), false);
});

test('payment is read from the order\'s own labelled line, never from a footer, a signature or a quoted old message', async () => {
  const body = ['Thanks for your order #1234', 'Payment method: Cash on Delivery (COD)', 'Total: PKR 4,000', '', 'Tip: we also accept Visa and bank transfer.', '-- ', 'Payment method: Visa'].join('\n');
  assert.equal(m.detectPaymentFromText(body), 'Cash on Delivery (COD)');
  assert.equal(m.detectPaymentFromText('Hello\nWe offer cash on delivery in some cities.\nTotal 100'), null, 'a sentence without a label decides nothing');
  assert.equal(m.detectPaymentFromText('> Payment method: Visa\nNew message'), null, 'a quoted earlier message is ignored');
  assert.equal(m.detectPaymentFromText('Order 1\n-- \nPayment method: Visa'), null, 'a signature is ignored');
});

test('reconcile: the labelled method fills a gap, a COD / non-COD disagreement leaves it unknown, COD is detected', async () => {
  const empty = m.reconcilePayment({ payment_method: null, payment_status: null }, 'Payment method: Bank transfer');
  assert.equal(empty.payment_method, 'Bank transfer');
  assert.equal(empty.payment_status, null, 'a method alone never means paid');
  const conflict = m.reconcilePayment({ payment_method: 'Visa ending 4242', payment_status: 'paid' }, 'Payment method: Cash on Delivery');
  assert.equal(conflict.payment_method, null);
  assert.equal(conflict.payment_status, null);
  const agree = m.reconcilePayment({ payment_method: 'Visa', payment_status: 'paid' }, 'Payment method: Credit card');
  assert.equal(agree.payment_method, 'Visa');
  const unknown = m.reconcilePayment({ payment_method: null, payment_status: null }, 'no payment details here');
  assert.equal(unknown.payment_method, null);
  assert.equal(m.isCod(m.reconcilePayment({ payment_method: null }, 'Payment type: COD').payment_method), true);
});

test('a later email with a non-COD method replaces COD on the order; the first non-COD method stays', async () => {
  db.table('orders')[0].brand_payment_method = 'Cash on Delivery';
  await m.applyPaymentUpdate({ ...order() }, { payment_method: 'Card', payment_status: null });
  assert.equal(order().brand_payment_method, 'Card');
  await m.applyPaymentUpdate({ ...order() }, { payment_method: 'Bank transfer', payment_status: null });
  assert.equal(order().brand_payment_method, 'Card');
  await m.applyPaymentUpdate({ ...order() }, { payment_method: 'Cash on Delivery', payment_status: null });
  assert.equal(order().brand_payment_method, 'Card', 'COD never replaces a real method');
});

test('email pictures: product pictures are kept in order, logos / icons / pixels / data and relative pictures are not', async () => {
  const { imageCandidates } = await import('../src/services/email-images.service.js');
  const html = `<img src="https://shop.com/logo.png" alt="Shop logo" width="200">
    <img src="https://cdn.shop.com/p/lawn.jpg" alt="Lawn 3pc Suit" width="300">
    <img src="https://track.shop.com/open.gif" width="1" height="1">
    <img src="data:image/png;base64,AAAA" alt="x">
    <img src="/relative.jpg" alt="x">
    <img src="cid:kurta123" alt="Cotton Kurta">`;
  const found = imageCandidates(html);
  assert.deepEqual(found.map((f) => f.alt), ['Lawn 3pc Suit', 'Cotton Kurta']);
  assert.equal(found[1].cid, 'kurta123');
});
