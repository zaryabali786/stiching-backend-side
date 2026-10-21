/**
 * The receiving API and the customer's approval calls refuse an unpaid COD order, whatever the app shows. The database and Stripe are
 * faked: nothing touches the live system and nothing is charged.
 */
import { test, mock, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeDb } from './fake-supabase.mjs';

let db;
let partner;
let client;
const dbProxy = new Proxy({}, { get: (_, key) => db[key] });
const noop = async () => undefined;

before(async () => {
  mock.module('../src/config/supabase.js', { namedExports: { supabaseAdmin: dbProxy, supabase: dbProxy } });
  mock.module('../src/services/notification.service.js', {
    namedExports: { notifyAdmins: noop, notifyPartner: noop, notifyUser: noop, notifyUsers: noop, notifyStaff: noop, partnerRecipients: async () => [] },
  });
  const realStripe = await import('../src/services/stripe.service.js');
  mock.module('../src/services/stripe.service.js', { namedExports: { ...realStripe, isStripeEnabled: () => false } });
  partner = await import('../src/controllers/partner.controller.js');
  client = await import('../src/controllers/client.controller.js');
});

const cod = (extra = {}) => ({
  id: 'o1',
  reference: 'SA-1',
  status: 'draft',
  customer_id: 'c1',
  partner_id: 'p1',
  order_source: 'email',
  payment_type: 'COD',
  cod_payment_status: 'UNPAID',
  cod_amount: 4200,
  cod_currency: 'PKR',
  cod_amount_status: 'verified',
  ...extra,
});

beforeEach(() => {
  db = createFakeDb({
    orders: [cod()],
    order_units: [{ id: 'u1', order_id: 'o1', status: 'pending', review_status: 'none', unit_title: 'Suit', weight_kg: 1 }],
    order_events: [],
    unit_events: [],
  });
});

/** catchAsync does not return its promise, so wait until the handler answers (res.json) or fails (next). */
const call = (handler, req) =>
  new Promise((resolve) => {
    const res = { code: 200, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; resolve({ res: this, error: null }); return this; } };
    handler({ headers: {}, query: {}, body: {}, ...req }, res, (error) => resolve({ res, error }));
  });
const unit = () => db.table('order_units')[0];

test('receiving every article of an unpaid COD order is refused by the API, and nothing changes', async () => {
  for (const status of ['UNPAID', 'PENDING']) {
    db.table('orders')[0].cod_payment_status = status;
    const { error } = await call(partner.receiveAllUnits, { params: { orderId: 'o1' }, userId: 's1' });
    assert.ok(error, `refused while ${status}`);
    assert.equal(error.statusCode, 409);
    assert.match(error.message, /Payment is required before receiving/);
    assert.equal(unit().status, 'pending', 'the article was not received');
  }
});

test('the customer cannot approve an unpaid COD order, one article or all', async () => {
  const asCustomer = { params: { id: 'o1' }, userId: 'c1', profile: { id: 'c1' } };
  for (const [handler, body] of [
    [client.approveParcel, {}],
    [client.reviewArticle, { decision: 'approve' }],
    [client.approveClientOrder, {}],
  ]) {
    const { error } = await call(handler, { ...asCustomer, params: { ...asCustomer.params, unitId: 'u1' }, body });
    assert.ok(error);
    assert.equal(error.statusCode, 409);
    assert.match(error.message, /Payment is required/);
  }
});

test('another customer cannot reach this order through the approval calls', async () => {
  const { error } = await call(client.approveParcel, { params: { id: 'o1' }, userId: 'someone-else', profile: { id: 'someone-else' } });
  assert.equal(error.statusCode, 404);
});

test('once the payment is confirmed, the same call is no longer refused for payment', async () => {
  db.table('orders')[0].cod_payment_status = 'PAID';
  const { error } = await call(partner.receiveAllUnits, { params: { orderId: 'o1' }, userId: 's1' });
  assert.ok(!error || !/Payment is required/.test(error.message), 'not refused for payment');
  assert.equal(unit().status, 'received', 'the article is received');
});

test('a Non-COD order is received as before', async () => {
  Object.assign(db.table('orders')[0], { payment_type: 'NON_COD', cod_payment_status: null });
  const { error } = await call(partner.receiveAllUnits, { params: { orderId: 'o1' }, userId: 's1' });
  assert.ok(!error || !/Payment is required/.test(error.message));
  assert.equal(unit().status, 'received');
});
