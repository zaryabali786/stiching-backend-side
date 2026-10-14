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
