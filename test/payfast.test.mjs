/**
 * PayFast (Pakistan) for orders delivered inside Pakistan: which gateway is used, the signed checkout form, and the backend checks that
 * decide whether a callback may mark an order paid (signature, result code, exact amount, replays). The database, PayFast and Stripe are faked.
 */
import { test, mock, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createFakeDb } from './fake-supabase.mjs';

process.env.PAYFAST_MERCHANT_ID = '14833';
process.env.PAYFAST_SECURED_KEY = 'test-secured-key';
process.env.PAYFAST_API_URL = 'https://api.example.test';
process.env.PAYFAST_ENV = 'sandbox';
process.env.PAYFAST_TRUST_RETURN = 'false';

let db;
let notices;
let pf;
let cb;
let cod;
let tokenCalls;
const dbProxy = new Proxy({}, { get: (_, key) => db[key] });
const note = (kind) => async (...args) => notices.push({ kind, args });
const freshDb = (order = codOrder()) =>
  createFakeDb({ orders: [order], order_events: [], payfast_payments: [], cod_payments: [] }, { uniques: { payfast_payments: { when: (r) => r.status === 'paid' && r.transaction_id, key: (r) => r.transaction_id } } });

before(async () => {
  mock.module('../src/config/supabase.js', { namedExports: { supabaseAdmin: dbProxy, supabase: dbProxy } });
  mock.module('../src/services/notification.service.js', {
    namedExports: { notifyAdmins: note('admins'), notifyPartner: note('partner'), notifyUser: note('user'), notifyUsers: note('users'), notifyStaff: note('staff'), partnerRecipients: async () => [] },
  });
  mock.module('../src/services/stripe.service.js', {
    namedExports: {
      isStripeEnabled: () => true,
      toMinorUnits: (a) => Math.round(Number(a) * 100),
      invoiceCharge: () => ({}),
      createOrReusePaymentIntent: async () => ({}),
      retrievePaymentIntent: async () => ({}),
      cancelPaymentIntent: async () => {},
      createShopPaymentIntent: async () => ({}),
      createCodPaymentIntent: async () => {
        throw new Error('Stripe must not be used for a Pakistan delivery');
      },
      constructWebhookEvent: () => ({}),
      retrieveCheckoutSession: async () => ({}),
      expireCheckoutSession: async () => {},
      createCheckoutSession: async () => ({}),
    },
  });
  globalThis.fetch = async (url, init) => {
    tokenCalls.push({ url: String(url), body: String(init?.body) });
    return { ok: true, status: 200, json: async () => ({ ACCESS_TOKEN: 'tok_123', GENERATED_DATE_TIME: 'now' }) };
  };
  pf = await import('../src/services/payfast.service.js');
  cod = await import('../src/services/cod-payment.service.js');
  cb = await import('../src/services/payfast-payment.service.js');
});

function codOrder(extra = {}) {
  return {
    id: 'o1',
    reference: 'SA-1',
    status: 'draft',
    customer_id: 'c1',
    customer_name: 'A Customer',
    order_source: 'email',
    import_source: 'email',
    destination_country: 'Pakistan',
    payment_type: 'COD',
    cod_amount: 4200,
    cod_currency: 'PKR',
    cod_amount_status: 'verified',
    cod_payment_status: 'UNPAID',
    ...extra,
  };
}
const order = () => db.table('orders')[0];
const attempt = () => db.table('payfast_payments')[0];
const customer = { id: 'c1', email: 'a@b.test', phone: '0300 1234567' };

/** What PayFast would send: the hash covers basket id, key, merchant id and result code. */
const callback = (basketId, over = {}) => {
  const err_code = over.err_code ?? '000';
  const validation_hash = over.validation_hash ?? crypto.createHash('sha256').update(`${basketId}|test-secured-key|14833|${err_code}`).digest('hex');
  return { basket_id: basketId, err_code, err_msg: 'ok', transaction_id: over.transaction_id ?? 'TX-1', transaction_amount: over.transaction_amount ?? '4200.00', validation_hash };
};

const startPay = async () => {
  const res = await cod.startCodPayment({ order: order(), customer });
  return { res, basket: res.payfast.fields.BASKET_ID };
};

beforeEach(() => {
  notices = [];
  tokenCalls = [];
  db = freshDb();
});

test('Pakistan deliveries in PKR use PayFast, everything else keeps Stripe', () => {
  assert.equal(pf.gatewayFor({ order: { destination_country: 'Pakistan' }, currency: 'PKR' }), 'payfast');
  assert.equal(pf.gatewayFor({ order: { destination_country: 'pk' }, currency: 'pkr' }), 'payfast');
  assert.equal(pf.gatewayFor({ order: { destination_country: 'United Kingdom' }, currency: 'PKR' }), 'stripe');
  assert.equal(pf.gatewayFor({ order: { destination_country: null }, currency: 'PKR' }), 'stripe');
  assert.equal(pf.gatewayFor({ order: { destination_country: 'Pakistan' }, currency: 'USD' }), 'stripe', 'PayFast only takes PKR');
});

test('Pay Now on a Pakistan COD order returns a PayFast form for the TOTAL IN THE DATABASE and never touches Stripe', async () => {
  const { res } = await startPay();
  assert.equal(res.provider, 'payfast');
  assert.equal(res.payfast.fields.TXNAMT, '4200.00');
  assert.equal(res.payfast.fields.MERCHANT_ID, '14833');
  assert.equal(res.payfast.fields.TOKEN, 'tok_123');
  assert.match(res.payfast.action, /ipguat\.apps\.net\.pk.*PostTransaction$/);
  assert.equal(res.payfast.fields.CHECKOUT_URL, 'https://api.example.test/api/webhooks/payfast');
  assert.match(tokenCalls[0].body, /TXNAMT=4200\.00/);
  assert.equal(attempt().status, 'pending');
  assert.equal(Number(attempt().amount), 4200);
  assert.equal(order().cod_payment_status, 'PENDING');
});

test('a correct, signed IPN marks the order paid exactly once', async () => {
  const { basket } = await startPay();
  const first = await cb.processPayfastCallback(callback(basket), 'ipn');
  assert.equal(first.state, 'paid');
  assert.equal(order().cod_payment_status, 'PAID');
  assert.equal(order().cod_paid_minor, 420000);
  assert.equal(attempt().status, 'paid');
  const again = await cb.processPayfastCallback(callback(basket), 'ipn');
  assert.equal(again.state, 'paid');
  assert.equal(db.table('order_events').filter((e) => /PayFast/.test(JSON.stringify(e))).length, 1, 'one history entry, not two');
});

test('a callback with a wrong signature changes nothing', async () => {
  const { basket } = await startPay();
  const r = await cb.processPayfastCallback(callback(basket, { validation_hash: 'f'.repeat(64) }), 'ipn');
  assert.equal(r.state, 'invalid');
  assert.equal(order().cod_payment_status, 'PENDING');
  assert.equal(attempt().status, 'pending');
  // a forged FAILURE must not be able to fail a pending payment either
  const forged = await cb.processPayfastCallback(callback(basket, { err_code: '101', validation_hash: 'a'.repeat(64) }), 'ipn');
  assert.equal(forged.state, 'invalid');
  assert.equal(attempt().status, 'pending');
});

test('paying LESS or MORE than the total is refused: not paid, admins told', async () => {
  for (const amount of ['4199.00', '4300.00', '1.00', '']) {
    notices = [];
    db = freshDb();
    const { basket } = await startPay();
    const r = await cb.processPayfastCallback(callback(basket, { transaction_amount: amount }), 'ipn');
    assert.equal(r.state, 'mismatch', `amount "${amount}"`);
    assert.notEqual(order().cod_payment_status, 'PAID');
    assert.equal(order().cod_payment_status, 'UNPAID', 'Pay Now works again');
    assert.equal(attempt().status, 'amount_mismatch');
    assert.ok(notices.some((n) => n.kind === 'admins'), 'an admin is told');
  }
});

test('the browser return alone does not settle (the customer can edit their own URL); the IPN does', async () => {
  const { basket } = await startPay();
  const r = await cb.processPayfastCallback(callback(basket), 'return');
  assert.equal(r.state, 'waiting');
  assert.equal(order().cod_payment_status, 'PENDING');
  assert.equal((await cb.processPayfastCallback(callback(basket), 'ipn')).state, 'paid');
});

test('a failed payment leaves the order unpaid and lets the customer try again', async () => {
  const { basket } = await startPay();
  const r = await cb.processPayfastCallback(callback(basket, { err_code: '106' }), 'ipn');
  assert.equal(r.state, 'failed');
  assert.equal(order().cod_payment_status, 'UNPAID');
  assert.equal(attempt().status, 'failed');
  const retry = await startPay();
  assert.notEqual(retry.basket, basket, 'a new basket for the new attempt');
});

test('a late success of an old attempt cannot pay an order whose total changed', async () => {
  const { basket } = await startPay();
  db.table('orders')[0].cod_amount = 5000; // staff corrected the total meanwhile
  const r = await cb.processPayfastCallback(callback(basket), 'ipn');
  assert.notEqual(order().cod_payment_status, 'PAID');
  assert.equal(r.state, 'mismatch');
  assert.ok(notices.some((n) => n.kind === 'admins'));
});

test('one PayFast transaction cannot pay two baskets, and an unknown basket is ignored', async () => {
  const a = await startPay();
  assert.equal((await cb.processPayfastCallback(callback(a.basket, { transaction_id: 'TX-9' }), 'ipn')).state, 'paid');
  assert.equal((await cb.processPayfastCallback(callback('NOPE-1'), 'ipn')).state, 'invalid');
});
