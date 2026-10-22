/**
 * Cash on delivery for email orders: COD / Non-COD choice, the total read from the original email, the Stripe Checkout payment and
 * the editing rule. The database and Stripe are faked: nothing touches the live system and nothing is charged.
 */
import { test, mock, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeDb } from './fake-supabase.mjs';

let db;
let cod;
let hooks;
let notices;
let stripeState;
const dbProxy = new Proxy({}, { get: (_, key) => db[key] });
const note = (kind) => async (...args) => notices.push({ kind, args });

before(async () => {
  stripeState = { sessions: {}, byKey: {}, created: [], expired: [], intents: {}, intentByKey: {}, intentCreated: [], canceled: [], n: 0, enabled: true };
  mock.module('../src/config/supabase.js', { namedExports: { supabaseAdmin: dbProxy, supabase: dbProxy } });
  mock.module('../src/services/notification.service.js', {
    namedExports: { notifyAdmins: note('admins'), notifyPartner: note('partner'), notifyUser: note('user'), notifyUsers: note('users'), notifyStaff: note('staff'), partnerRecipients: async () => [] },
  });
  mock.module('../src/services/stripe.service.js', {
    namedExports: {
      isStripeEnabled: () => stripeState.enabled,
      toMinorUnits: (amount) => Math.round(Number(amount) * 100),
      invoiceCharge: () => ({}),
      createOrReusePaymentIntent: async () => ({}),
      retrievePaymentIntent: async (id) => {
        if (!stripeState.intents[id]) throw new Error('No such payment intent');
        return stripeState.intents[id];
      },
      cancelPaymentIntent: async (id) => {
        stripeState.canceled.push(id);
        if (stripeState.intents[id] && !['succeeded', 'canceled'].includes(stripeState.intents[id].status)) stripeState.intents[id].status = 'canceled';
      },
      createShopPaymentIntent: async () => ({}),
      createCodPaymentIntent: async (args) => {
        stripeState.intentCreated.push(args);
        const existing = stripeState.intentByKey[args.idempotencyKey];
        if (existing) return { intent: existing };
        const n = ++stripeState.n;
        const minor = Math.round(Number(args.amount) * 100);
        const intent = {
          id: `pi_cod_${n}`,
          client_secret: `pi_cod_${n}_secret_x`,
          status: 'requires_payment_method',
          amount: minor,
          amount_received: 0,
          currency: String(args.currency).toLowerCase(),
          metadata: { kind: 'cod', order_id: args.order.id, customer_id: args.order.customer_id },
        };
        stripeState.intents[intent.id] = intent;
        stripeState.intentByKey[args.idempotencyKey] = intent;
        return { intent, minor };
      },
      constructWebhookEvent: (raw, sig) => {
        if (sig !== 'good') throw new Error('bad signature');
        return JSON.parse(raw);
      },
      retrieveCheckoutSession: async (id) => {
        if (!stripeState.sessions[id]) throw new Error('No such session');
        return stripeState.sessions[id];
      },
      expireCheckoutSession: async (id) => {
        stripeState.expired.push(id);
        if (stripeState.sessions[id]) stripeState.sessions[id].status = 'expired';
      },
      createCheckoutSession: async (args) => {
        stripeState.created.push(args);
        const existing = stripeState.byKey[args.idempotencyKey];
        if (existing) return { session: existing };
        const n = ++stripeState.n;
        const session = {
          id: `cs_test_${n}`,
          url: `https://checkout.stripe.test/${n}`,
          status: 'open',
          payment_status: 'unpaid',
          amount_total: Math.round(Number(args.amount) * 100),
          currency: String(args.currency).toLowerCase(),
          client_reference_id: args.order.id,
          payment_intent: `pi_test_${n}`,
          metadata: { kind: 'cod', order_id: args.order.id, customer_id: args.order.customer_id },
        };
        stripeState.sessions[session.id] = session;
        stripeState.byKey[args.idempotencyKey] = session;
        return { session };
      },
    },
  });
  cod = await import('../src/services/cod-payment.service.js');
  hooks = await import('../src/controllers/payment.controller.js');
});

const EMAIL = ['Thanks for your order #1234', 'Subtotal: Rs. 4,000', 'Shipping: Rs. 200', 'Total: Rs. 4,200', 'Payment method: Visa'].join('\n');
const baseOrder = (extra = {}) => ({
  id: 'o1',
  reference: 'SA-1',
  status: 'draft',
  customer_id: 'c1',
  customer_name: 'A Customer',
  order_source: 'email',
  import_source: 'email',
  import_id: 'imp1',
  brand_payment_method: null,
  brand_order_total: 4200,
  brand_order_currency: 'PKR',
  payment_type: null,
  cod_payment_status: null,
  ...extra,
});
const order = () => db.table('orders')[0];
const customer = { id: 'c1', role: 'customer' };
const staff = { id: 's1', role: 'staff' };

beforeEach(() => {
  notices = [];
  stripeState.sessions = {};
  stripeState.byKey = {};
  stripeState.created = [];
  stripeState.expired = [];
  stripeState.intents = {};
  stripeState.intentByKey = {};
  stripeState.intentCreated = [];
  stripeState.canceled = [];
  stripeState.enabled = true;
  db = createFakeDb({
    orders: [baseOrder()],
    inbox_emails: [{ id: 'em1', import_id: 'imp1', body_text: EMAIL }],
    order_events: [],
    cod_amount_audit: [],
    cod_payments: [],
  });
});

// ───────────── reading the total ─────────────

test('the total payable is the Total line, never the sub-total, shipping, tax or an item count', () => {
  const text = ['Subtotal: Rs. 4,000', 'Shipping: Rs. 200', 'Tax (VAT): Rs. 0', 'Discount: Rs. 100', 'Total items: 3', 'Total (incl. tax): Rs. 4,100'].join('\n');
  const found = cod.findTotalsInText(text);
  assert.deepEqual(found.map((f) => f.value), [4100]);
  assert.equal(found[0].currency, 'PKR');
});

test('amounts are read with their decimals and separators', () => {
  assert.equal(cod.parseAmount('4,500.00'), 4500);
  assert.equal(cod.parseAmount('4500'), 4500);
  assert.equal(cod.parseAmount('1.234,50'), 1234.5);
  assert.equal(cod.parseAmount('12,50'), 12.5);
  assert.equal(cod.parseAmount('1,234,567'), 1234567);
  assert.equal(cod.parseAmount('abc'), null);
  assert.equal(cod.findTotalsInText('Grand total\nPKR 9,999.50')[0].value, 9999.5, 'the amount can be on the next line');
  assert.equal(cod.findTotalsInText('Total: 4,000 (3 items)')[0].value, 4000, 'the item count is not the amount');
});

test('a total the order reader and the email text agree on is extracted with its currency', () => {
  const r = cod.readCodAmount({ order: baseOrder(), emailText: EMAIL });
  assert.deepEqual({ a: r.amount, c: r.currency, s: r.status }, { a: 4200, c: 'PKR', s: 'extracted' });
});

test('missing, ambiguous or contradicting totals are not guessed: they need verification', () => {
  const none = cod.readCodAmount({ order: baseOrder({ brand_order_total: null }), emailText: 'Hello, thanks for shopping.' });
  assert.equal(none.status, 'needs_verification');
  assert.equal(none.amount, null);
  const many = cod.readCodAmount({ order: baseOrder(), emailText: 'Order total: Rs. 4,200\nGrand total: Rs. 5,000' });
  assert.equal(many.status, 'needs_verification', 'two different strong totals');
  const clash = cod.readCodAmount({ order: baseOrder({ brand_order_total: 3000 }), emailText: EMAIL });
  assert.equal(clash.status, 'needs_verification', 'the order reader and the text disagree');
  assert.match(clash.note, /differs/);
  const noCurrency = cod.readCodAmount({ order: baseOrder({ brand_order_currency: null }), emailText: 'Total: 4,200' });
  assert.equal(noCurrency.status, 'needs_verification', 'a bare number has no currency');
  const dollar = cod.readCodAmount({ order: baseOrder({ brand_order_currency: null }), emailText: 'Total: $120.00' });
  assert.equal(dollar.status, 'needs_verification', 'a "$" alone is not one currency');
});

test('only the order reader\'s total, with a clear currency, is accepted when the email has no labelled total', () => {
  const r = cod.readCodAmount({ order: baseOrder(), emailText: '' });
  assert.equal(r.status, 'extracted');
  assert.equal(r.source, 'email_ai');
});

// ───────────── COD / Non-COD ───────────────

test('choosing COD saves the type, the total read from the email, the currency and Unpaid', async () => {
  const { order: saved, changed } = await cod.setPaymentType({ order: order(), type: 'COD', actor: customer });
  assert.equal(changed, true);
  assert.equal(order().payment_type, 'COD');
  assert.equal(order().cod_amount, 4200);
  assert.equal(order().cod_currency, 'PKR');
  assert.equal(order().cod_amount_status, 'extracted');
  assert.equal(order().cod_payment_status, 'UNPAID');
  assert.equal(order().cod_email_ref, 'em1', 'the email the amount came from is kept');
  assert.equal(cod.codView(saved).can_pay, true);
  assert.equal(cod.codView(saved).locked, true);
  const again = await cod.setPaymentType({ order: order(), type: 'COD', actor: customer });
  assert.equal(again.changed, false, 'choosing twice does nothing');
  assert.equal(db.table('order_events').length, 1);
});

test('Non-COD changes nothing else: no Stripe step, no amount, editing is not locked', async () => {
  await cod.setPaymentType({ order: order(), type: 'NON_COD', actor: customer });
  assert.equal(order().payment_type, 'NON_COD');
  assert.equal(order().cod_amount ?? null, null);
  assert.equal(order().cod_payment_status ?? null, null);
  assert.equal(cod.isCodLocked(order()), false);
  assert.doesNotThrow(() => cod.assertCodEditable(order()));
  assert.equal(stripeState.created.length, 0);
});

test('a missing or unclear total marks the COD order as needing verification and blocks payment', async () => {
  db = createFakeDb({ orders: [baseOrder({ brand_order_total: null })], inbox_emails: [{ id: 'em1', import_id: 'imp1', body_text: 'No prices here' }], order_events: [], cod_amount_audit: [] });
  const { order: saved } = await cod.setPaymentType({ order: order(), type: 'COD', actor: customer });
  const view = cod.codView(saved);
  assert.equal(view.needs_verification, true);
  assert.equal(view.can_pay, false);
  assert.equal(view.amount, null);
  await assert.rejects(() => cod.createCodCheckout({ order: order(), customer: { email: 'a@b.c' } }), /still confirming the total/);
  assert.equal(stripeState.created.length, 0);
});

test('a customer cannot pick Non-COD when the email says cash on delivery, cannot leave COD, and cannot touch non-email orders', async () => {
  db.table('orders')[0].brand_payment_method = 'Cash on Delivery';
  await assert.rejects(() => cod.setPaymentType({ order: order(), type: 'NON_COD', actor: customer }), /says cash on delivery/);
  await cod.setPaymentType({ order: order(), type: 'COD', actor: customer });
  await assert.rejects(() => cod.setPaymentType({ order: order(), type: 'NON_COD', actor: customer }), /Only our team/);
  const moved = await cod.setPaymentType({ order: order(), type: 'NON_COD', actor: { ...staff, admin: true } });
  assert.equal(moved.changed, true, 'authorised staff can move an order away from COD');
  assert.equal(order().cod_payment_status ?? null, null);
  db = createFakeDb({ orders: [baseOrder({ order_source: 'customer', import_source: null, import_id: null })], order_events: [] });
  await assert.rejects(() => cod.setPaymentType({ order: order(), type: 'COD', actor: customer }), /came from an email/);
});

// ───────────── editing rules ───────────────

test('editing: COD unpaid or pending is blocked, COD paid and Non-COD follow the existing rules', () => {
  assert.throws(() => cod.assertCodEditable(baseOrder({ payment_type: 'COD', cod_payment_status: 'UNPAID' })), /Pay the total first/);
  assert.throws(() => cod.assertCodEditable(baseOrder({ payment_type: 'COD', cod_payment_status: 'PENDING' })), /Pay the total first/);
  assert.doesNotThrow(() => cod.assertCodEditable(baseOrder({ payment_type: 'COD', cod_payment_status: 'PAID' })));
  assert.doesNotThrow(() => cod.assertCodEditable(baseOrder({ payment_type: 'NON_COD' })));
});

test('an email that only mentions COD no longer locks editing by itself; a draft needs the choice before it can be created', () => {
  assert.doesNotThrow(() => cod.assertCodEditable(baseOrder({ status: 'submitted', brand_payment_method: 'Cash on Delivery' })), 'older orders are not restricted');
  assert.throws(() => cod.assertCodEditable(baseOrder({ status: 'draft', brand_payment_method: 'Cash on Delivery' })), /Choose COD or Non-COD/);
  assert.throws(() => cod.assertCodEditable(baseOrder({ status: 'draft' })), /Choose COD or Non-COD/, 'every email draft asks first, not only the ones that mention COD');
  assert.doesNotThrow(() => cod.assertCodEditable(baseOrder({ status: 'draft', payment_type: 'NON_COD' })), 'Non-COD: create the order');
  assert.throws(() => cod.assertCodEditable(baseOrder({ status: 'draft', payment_type: 'COD', cod_payment_status: 'UNPAID' })), /Pay the total first/, 'COD unpaid: pay first');
  assert.doesNotThrow(() => cod.assertCodEditable(baseOrder({ status: 'draft', payment_type: 'COD', cod_payment_status: 'PAID' })), 'COD paid: create the order');
  assert.equal(cod.isCodLocked(baseOrder({ brand_payment_method: 'Cash on Delivery' })), false);
  assert.equal(cod.isCodLocked(baseOrder()), false, 'orders that never chose are untouched');
});

// ───────────── staff verify or correct the total ───────────────

test('staff must give a reason; every change is audited; a correction retires the old payment page', async () => {
  await cod.setPaymentType({ order: order(), type: 'COD', actor: customer });
  await assert.rejects(() => cod.verifyCodAmount({ order: order(), amount: 4300, currency: 'PKR', reason: '', actor: staff }), /reason/);
  await assert.rejects(() => cod.verifyCodAmount({ order: order(), amount: 0, currency: 'PKR', reason: 'typo', actor: staff }), /above zero/);
  await assert.rejects(() => cod.verifyCodAmount({ order: order(), amount: 10, currency: 'rupee', reason: 'typo', actor: staff }), /3-letter/);

  const link = await cod.createCodCheckout({ order: order(), customer: { email: 'a@b.c' } });
  const result = await cod.verifyCodAmount({ order: order(), amount: '4,300.00', currency: 'pkr', reason: 'Email total includes gift wrap', actor: staff });
  assert.equal(result.status, 'corrected');
  assert.equal(order().cod_amount, 4300);
  assert.equal(order().cod_amount_status, 'corrected');
  assert.equal(order().cod_payment_status, 'UNPAID');
  assert.deepEqual(stripeState.expired, [link.sessionId], 'the page for the old amount is closed');
  assert.equal(stripeState.sessions[link.sessionId].status, 'expired');
  const [audit] = db.table('cod_amount_audit');
  assert.deepEqual({ o: audit.old_amount, n: audit.new_amount, c: audit.new_currency, by: audit.changed_by }, { o: 4200, n: 4300, c: 'PKR', by: 's1' });

  const same = await cod.verifyCodAmount({ order: order(), amount: 4300, currency: 'PKR', reason: 'Checked again', actor: staff });
  assert.equal(same.status, 'verified', 'confirming the same amount is a verification, not a correction');
  assert.equal(db.table('cod_amount_audit').length, 2);
});

test('staff enter the total when the email gave none; then payment becomes possible', async () => {
  db = createFakeDb({ orders: [baseOrder({ brand_order_total: null })], inbox_emails: [{ id: 'em1', import_id: 'imp1', body_text: 'nothing' }], order_events: [], cod_amount_audit: [] });
  await cod.setPaymentType({ order: order(), type: 'COD', actor: customer });
  assert.equal(cod.codView(order()).needs_verification, true);
  await cod.verifyCodAmount({ order: order(), amount: 5000, currency: 'USD', reason: 'Read from the PDF invoice', actor: staff });
  assert.equal(order().cod_amount_status, 'verified');
  assert.equal(cod.codView(order()).can_pay, true);
});

test('a paid order\'s amount can no longer be changed', async () => {
  await cod.setPaymentType({ order: order(), type: 'COD', actor: customer });
  db.table('orders')[0].cod_payment_status = 'PAID';
  await assert.rejects(() => cod.verifyCodAmount({ order: order(), amount: 1, currency: 'PKR', reason: 'late change', actor: staff }), /already paid/);
});

// ───────────── Pay Now ───────────────

test('Pay Now creates one Checkout Session for the verified amount; clicking again reuses it', async () => {
  await cod.setPaymentType({ order: order(), type: 'COD', actor: customer });
  const first = await cod.createCodCheckout({ order: order(), customer: { email: 'a@b.c' } });
  assert.equal(first.reused, false);
  assert.match(first.url, /^https:\/\/checkout\.stripe\.test\//);
  assert.equal(stripeState.created.length, 1);
  assert.equal(stripeState.created[0].amount, 4200, 'the amount comes from the saved total');
  assert.equal(stripeState.created[0].currency, 'PKR');
  assert.match(stripeState.created[0].successUrl, /\/pay-return\?result=success&order=o1$/);
  assert.equal(order().cod_payment_status, 'PENDING');
  assert.equal(order().cod_stripe_session_id, first.sessionId);

  const second = await cod.createCodCheckout({ order: order(), customer: { email: 'a@b.c' } });
  assert.equal(second.reused, true);
  assert.equal(second.sessionId, first.sessionId);
  assert.equal(stripeState.created.length, 1, 'no second payable session');
});

test('an expired page is replaced by a new session; a paid order cannot be paid again', async () => {
  await cod.setPaymentType({ order: order(), type: 'COD', actor: customer });
  const first = await cod.createCodCheckout({ order: order(), customer: {} });
  stripeState.sessions[first.sessionId].status = 'expired';
  const next = await cod.createCodCheckout({ order: order(), customer: {} });
  assert.notEqual(next.sessionId, first.sessionId);
  stripeState.sessions[next.sessionId].payment_status = 'paid';
  stripeState.sessions[next.sessionId].status = 'complete';
  await assert.rejects(() => cod.createCodCheckout({ order: order(), customer: {} }), /already paid/);
  assert.equal(order().cod_payment_status, 'PAID', 'asking again settled the paid session instead of opening a new one');
});

test('Pay Now needs Stripe, COD and a verified amount', async () => {
  await assert.rejects(() => cod.createCodCheckout({ order: order(), customer: {} }), /not a cash on delivery/);
  await cod.setPaymentType({ order: order(), type: 'COD', actor: customer });
  stripeState.enabled = false;
  await assert.rejects(() => cod.createCodCheckout({ order: order(), customer: {} }), /not available/);
});

// ───────────── payment confirmation ───────────────

const payFor = async () => {
  await cod.setPaymentType({ order: order(), type: 'COD', actor: customer });
  const link = await cod.createCodCheckout({ order: order(), customer: {} });
  return stripeState.sessions[link.sessionId];
};

test('only a paid session for this order and the verified amount marks it PAID, once', async () => {
  const session = await payFor();
  assert.equal((await cod.settleCodSession({ ...session, payment_status: 'unpaid' })).settled, false, 'an unpaid session proves nothing');
  assert.equal(order().cod_payment_status, 'PENDING');

  session.payment_status = 'paid';
  const done = await cod.settleCodSession(session);
  assert.equal(done.settled, true);
  assert.equal(order().cod_payment_status, 'PAID');
  assert.ok(order().cod_paid_at);
  assert.equal(order().cod_stripe_payment_intent, session.payment_intent);
  assert.equal(order().cod_paid_minor, 420000);
  assert.ok(notices.some((n) => n.kind === 'user'), 'the customer is told');

  const before = notices.length;
  const repeat = await cod.settleCodSession(session);
  assert.deepEqual({ s: repeat.settled, r: repeat.reason }, { s: false, r: 'already paid' }, 'a duplicate webhook does nothing');
  assert.equal(notices.length, before, 'and tells nobody twice');
  assert.equal(db.table('order_events').filter((e) => /payment received/i.test(e.note)).length, 1);
});

test('a payment that does not match the order is not marked paid and an administrator is told', async () => {
  const session = await payFor();
  session.payment_status = 'paid';
  const short = await cod.settleCodSession({ ...session, amount_total: 100 });
  assert.equal(short.settled, false);
  const other = await cod.settleCodSession({ ...session, id: 'cs_other' });
  assert.equal(other.settled, false, 'not this order\'s current session');
  const wrongKind = await cod.settleCodSession({ ...session, metadata: { kind: 'invoice' } });
  assert.equal(wrongKind.settled, false);
  assert.equal(order().cod_payment_status, 'PENDING');
  assert.ok(notices.filter((n) => n.kind === 'admins').length >= 2);
});

test('after the customer comes back, the server asks Stripe: unpaid stays unpaid, paid settles', async () => {
  const session = await payFor();
  assert.deepEqual(await cod.confirmCodPayment(order()), { paid: false, status: 'PENDING' });
  session.payment_status = 'paid';
  assert.deepEqual(await cod.confirmCodPayment(order()), { paid: true, status: 'PAID' });
  assert.equal(order().cod_payment_status, 'PAID');
  assert.deepEqual(await cod.confirmCodPayment(order()), { paid: true, status: 'PAID' });
});

test('a cancelled or expired payment keeps the order unpaid and locked, and it can be retried', async () => {
  const session = await payFor();
  session.status = 'expired';
  assert.deepEqual(await cod.confirmCodPayment(order()), { paid: false, status: 'UNPAID' });
  assert.equal(order().cod_payment_status, 'UNPAID');
  assert.equal(cod.isCodLocked(order()), true);
  const retry = await cod.createCodCheckout({ order: order(), customer: {} });
  assert.notEqual(retry.sessionId, session.id);
  const released = await cod.releaseCodSession(stripeState.sessions[retry.sessionId]);
  assert.equal(released.released, true);
  assert.equal(order().cod_payment_status, 'UNPAID');
});

test('paying unlocks editing', async () => {
  const session = await payFor();
  assert.throws(() => cod.assertCodEditable(order()), /Pay the total first/);
  session.payment_status = 'paid';
  await cod.settleCodSession(session);
  assert.doesNotThrow(() => cod.assertCodEditable(order()));
  assert.equal(cod.codView(order()).locked, false);
  assert.equal(cod.codView(order()).payment_status, 'PAID');
});

// ───────────── Stripe webhook ───────────────

const hook = async (event, signature = 'good') => {
  const res = { code: 200, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } };
  await hooks.stripeWebhook({ body: Buffer.from(JSON.stringify(event)), headers: { 'stripe-signature': signature } }, res);
  return res;
};

test('the webhook settles on checkout.session.completed, ignores duplicates, and rejects a bad signature', async () => {
  const session = await payFor();
  session.payment_status = 'paid';
  assert.equal((await hook({ type: 'checkout.session.completed', data: { object: session } }, 'forged')).code, 400);
  assert.equal(order().cod_payment_status, 'PENDING', 'a forged event changes nothing');
  assert.equal((await hook({ type: 'checkout.session.completed', data: { object: session } })).code, 200);
  assert.equal(order().cod_payment_status, 'PAID');
  const paidAt = order().cod_paid_at;
  assert.equal((await hook({ type: 'checkout.session.completed', data: { object: session } })).code, 200);
  assert.equal(order().cod_paid_at, paidAt, 'the second delivery changes nothing');
});

test('the webhook releases an expired session', async () => {
  const session = await payFor();
  await hook({ type: 'checkout.session.expired', data: { object: { ...session, status: 'expired' } } });
  assert.equal(order().cod_payment_status, 'UNPAID');
  assert.equal(cod.codView(order()).can_pay, true, 'the customer can pay again');
});

test('the view shown to the apps has the type, amount, currency and status but no Stripe ids', async () => {
  const session = await payFor();
  const view = cod.codView(order());
  assert.deepEqual(Object.keys(view).sort(), ['amount', 'amount_note', 'amount_status', 'can_choose', 'can_pay', 'currency', 'email_order', 'email_says_cod', 'locked', 'needs_verification', 'paid_at', 'payment_state', 'payment_status', 'payment_type', 'receive_block_reason', 'receive_blocked', 'shopify', 'source']);
  assert.equal(JSON.stringify(view).includes(session.id), false);
  assert.equal(/pi_|cs_test|secret/.test(JSON.stringify(view)), false, 'no Stripe reference or secret reaches the app');
});

test('before the database update 0041 is applied, choosing COD says so instead of a raw database error', async () => {
  const real = db.from;
  db.from = (name) => {
    const q = real(name);
    if (name !== 'orders') return q;
    const update = q.update.bind(q);
    q.update = (patch) => {
      const api = update(patch);
      if (!('payment_type' in patch)) return api;
      return { ...api, eq: () => ({ select: () => ({ maybeSingle: async () => ({ data: null, error: { message: "Could not find the 'payment_type' column of 'orders' in the schema cache" } }) }) }) };
    };
    return q;
  };
  await assert.rejects(() => cod.setPaymentType({ order: order(), type: 'NON_COD', actor: customer }), /database update 0041/);
  db.from = real;
});

test('discarding or cancelling closes an open payment page, and leaves other orders alone', async () => {
  const session = await payFor();
  await cod.retireCodCheckout({ ...order(), cod_payment_status: 'PENDING' });
  assert.deepEqual(stripeState.expired, [session.id]);
  stripeState.expired = [];
  await cod.retireCodCheckout(baseOrder({ payment_type: 'NON_COD' }));
  await cod.retireCodCheckout(baseOrder());
  assert.deepEqual(stripeState.expired, [], 'Non-COD and unchosen orders have no payment page to close');
});

test('list rows get the COD state (type, paid or not, total) so receiving staff see it at a glance', async () => {
  db = createFakeDb({
    orders: [
      baseOrder({ id: 'a', payment_type: 'COD', cod_payment_status: 'UNPAID', cod_amount: 4200, cod_currency: 'PKR', cod_amount_status: 'extracted' }),
      baseOrder({ id: 'b', payment_type: 'COD', cod_payment_status: 'PAID', cod_amount: 100, cod_currency: 'USD', cod_amount_status: 'verified' }),
      baseOrder({ id: 'c', payment_type: 'NON_COD' }),
      baseOrder({ id: 'd' }),
    ],
  });
  const rows = await cod.attachCodSummary([{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }]);
  const by = Object.fromEntries(rows.map((r) => [r.id, r.cod]));
  assert.deepEqual({ s: by.a.payment_status, amt: by.a.amount, cur: by.a.currency, locked: by.a.locked }, { s: 'UNPAID', amt: 4200, cur: 'PKR', locked: true });
  assert.deepEqual({ s: by.b.payment_status, locked: by.b.locked }, { s: 'PAID', locked: false });
  assert.equal(by.c.payment_type, 'NON_COD');
  assert.equal(by.d, undefined, 'orders that never chose get nothing');
});

// ───────────── paying inside the app (Stripe Payment Element) ─────────────

const intentFor = async () => {
  await cod.setPaymentType({ order: order(), type: 'COD', actor: customer });
  const start = await cod.startCodPayment({ order: order(), customer: { email: 'a@b.c' } });
  return { start, intent: stripeState.intents[start.paymentIntentId] };
};
const succeed = (intent) => {
  intent.status = 'succeeded';
  intent.amount_received = intent.amount;
  return intent;
};

test('Pay Now makes one PaymentIntent for the verified amount; opening the sheet again reuses it', async () => {
  const { start, intent } = await intentFor();
  assert.equal(start.reused, false);
  assert.ok(start.clientSecret.startsWith('pi_cod_'), 'the app gets the one-time secret of the Payment Element');
  assert.equal(start.amount, 4200);
  assert.equal(stripeState.intentCreated.length, 1);
  assert.equal(stripeState.intentCreated[0].amount, 4200, 'the amount comes from the saved total, never from the app');
  assert.equal(order().cod_payment_status, 'PENDING');
  assert.equal(order().cod_stripe_payment_intent, intent.id);
  assert.equal(db.table('cod_payments').length, 1, 'one history row');
  assert.equal(db.table('cod_payments')[0].status, 'pending');

  const again = await cod.startCodPayment({ order: order(), customer: {} });
  assert.equal(again.reused, true);
  assert.equal(again.paymentIntentId, intent.id);
  assert.equal(stripeState.intentCreated.length, 1, 'no second payable intent');
  assert.equal(db.table('cod_payments').length, 1);
});

test('an intent for an old amount is cancelled and replaced when the total changes', async () => {
  const { intent } = await intentFor();
  await cod.verifyCodAmount({ order: order(), amount: '5000', currency: 'PKR', reason: 'Email total was wrong', actor: staff });
  const next = await cod.startCodPayment({ order: order(), customer: {} });
  assert.notEqual(next.paymentIntentId, intent.id);
  assert.ok(stripeState.canceled.includes(intent.id), 'the old intent can no longer be paid');
  assert.equal(next.amount, 5000);
});

test('Pay Now in the app needs Stripe, COD, a verified amount, and an order that is not paid', async () => {
  await assert.rejects(() => cod.startCodPayment({ order: order(), customer: {} }), /not a cash on delivery/);
  await cod.setPaymentType({ order: order(), type: 'COD', actor: customer });
  stripeState.enabled = false;
  await assert.rejects(() => cod.startCodPayment({ order: order(), customer: {} }), /not available/);
  stripeState.enabled = true;
  db.table('orders')[0].cod_amount_status = 'needs_verification';
  await assert.rejects(() => cod.startCodPayment({ order: order(), customer: {} }), /still confirming/);
  db.table('orders')[0].cod_amount_status = 'extracted';
  db.table('orders')[0].cod_payment_status = 'PAID';
  await assert.rejects(() => cod.startCodPayment({ order: order(), customer: {} }), /already paid/);
});

test('only a succeeded intent of this order, with the verified amount, marks it PAID, once', async () => {
  const { intent } = await intentFor();
  assert.equal((await cod.settleCodIntent({ ...intent, status: 'processing' })).settled, false, 'a payment still processing proves nothing');
  assert.equal(order().cod_payment_status, 'PENDING');

  const done = await cod.settleCodIntent(succeed(intent));
  assert.equal(done.settled, true);
  assert.equal(order().cod_payment_status, 'PAID');
  assert.equal(order().cod_paid_minor, 420000);
  assert.ok(order().cod_paid_at);
  assert.equal(db.table('cod_payments')[0].status, 'succeeded');
  assert.ok(notices.some((n) => n.kind === 'user'), 'the customer is told');
  assert.ok(notices.some((n) => n.kind === 'admins'), 'the admins are told');
  assert.ok(db.table('order_events').some((e) => /payment received/i.test(e.note || '')), 'it is in the order history');

  const paidAt = order().cod_paid_at;
  const again = await cod.settleCodIntent(intent);
  assert.equal(again.settled, false);
  assert.equal(order().cod_paid_at, paidAt, 'a duplicate event changes nothing');
  assert.equal(notices.filter((n) => n.kind === 'user').length, 1, 'and does not notify twice');
});

test('a payment that does not match the order is not marked paid and an administrator is told', async () => {
  const { intent } = await intentFor();
  succeed(intent);
  intent.amount_received = 100;
  assert.equal((await cod.settleCodIntent(intent)).settled, false);
  intent.amount_received = intent.amount;
  assert.equal((await cod.settleCodIntent({ ...intent, id: 'pi_someone_else' })).settled, false, 'another intent id is not this order payment');
  assert.equal((await cod.settleCodIntent({ ...intent, metadata: { kind: 'invoice', order_id: 'o1' } })).settled, false);
  assert.equal(order().cod_payment_status, 'PENDING');
  assert.ok(notices.some((n) => n.kind === 'admins' && /Check payment/.test(JSON.stringify(n.args))));
});

test('"Check payment again" asks Stripe about the stored intent: it never charges and never trusts the app', async () => {
  const { intent } = await intentFor();
  const waiting = await cod.confirmCodPayment(order());
  assert.equal(waiting.paid, false);
  assert.equal(waiting.status, 'PENDING');
  assert.equal(stripeState.intentCreated.length, 1, 'checking creates nothing new');

  succeed(intent);
  const paid = await cod.confirmCodPayment(order());
  assert.equal(paid.paid, true);
  assert.equal(order().cod_payment_status, 'PAID');
});

test('a cancelled intent leaves the order Unpaid and blocked; a declined card keeps the same intent for a retry', async () => {
  const { intent } = await intentFor();
  await cod.releaseCodIntent({ ...intent, last_payment_error: { message: 'Your card was declined.' } });
  assert.equal(order().cod_payment_status, 'PENDING', 'a decline keeps the intent usable');
  assert.equal(db.table('cod_payments')[0].status, 'failed');
  assert.equal(db.table('cod_payments')[0].failure_message, 'Your card was declined.');
  assert.throws(() => cod.assertReceivable(order()), /Payment is required/);

  intent.status = 'canceled';
  await cod.releaseCodIntent(intent);
  assert.equal(order().cod_payment_status, 'UNPAID');
  assert.throws(() => cod.assertReceivable(order()), /Payment is required/);
  assert.equal(cod.codView(order()).can_pay, true, 'the customer can pay again');
});

test('the webhook settles a COD payment_intent.succeeded once, ignores duplicates, and rejects a forged one', async () => {
  const { intent } = await intentFor();
  succeed(intent);
  assert.equal((await hook({ type: 'payment_intent.succeeded', data: { object: intent } }, 'forged')).code, 400);
  assert.equal(order().cod_payment_status, 'PENDING', 'a forged event changes nothing');
  assert.equal((await hook({ type: 'payment_intent.succeeded', data: { object: intent } })).code, 200);
  assert.equal(order().cod_payment_status, 'PAID');
  const paidAt = order().cod_paid_at;
  assert.equal((await hook({ type: 'payment_intent.succeeded', data: { object: intent } })).code, 200);
  assert.equal(order().cod_paid_at, paidAt);
  assert.equal(db.table('cod_payments').length, 1, 'no duplicate payment record');
});

test('the webhook records a failed card and a cancelled intent', async () => {
  const { intent } = await intentFor();
  await hook({ type: 'payment_intent.payment_failed', data: { object: { ...intent, last_payment_error: { message: 'Insufficient funds.' } } } });
  assert.equal(db.table('cod_payments')[0].status, 'failed');
  assert.equal(order().cod_payment_status, 'PENDING');
  await hook({ type: 'payment_intent.canceled', data: { object: { ...intent, status: 'canceled' } } });
  assert.equal(order().cod_payment_status, 'UNPAID');
});

// ───────────── receiving needs a confirmed payment ─────────────

test('a COD order cannot be received until its payment is confirmed; Non-COD and older orders are not affected', async () => {
  const blocked = (o) => {
    try {
      cod.assertReceivable(o);
      return false;
    } catch {
      return true;
    }
  };
  assert.equal(blocked(order()), false, 'older order: no payment type, nothing changes');
  await cod.setPaymentType({ order: order(), type: 'NON_COD', actor: customer });
  assert.equal(blocked(order()), false, 'Non-COD: normal receiving');
  db.table('orders')[0].payment_type = null;
  await cod.setPaymentType({ order: order(), type: 'COD', actor: customer });
  assert.equal(blocked(order()), true, 'COD unpaid');
  db.table('orders')[0].cod_payment_status = 'PENDING';
  assert.equal(blocked(order()), true, 'payment started but not confirmed');
  assert.equal(cod.codView(order()).receive_blocked, true);
  assert.equal(cod.codView(order()).payment_state, 'processing');
  db.table('orders')[0].cod_payment_status = 'PAID';
  assert.equal(blocked(order()), false, 'paid: receiving is open without anyone touching the order');
  assert.equal(cod.codView(order()).receive_blocked, false);
  assert.equal(cod.codView(order()).payment_state, 'paid');
});

test('the receiving check also works from just the order id (what the receiving API uses)', async () => {
  await cod.setPaymentType({ order: order(), type: 'COD', actor: customer });
  await assert.rejects(() => cod.assertReceivableById('o1'), /Payment is required before receiving/);
  await cod.assertReceivableById('someone-elses-order'); // an unknown id is left to the caller's own not-found handling
  db.table('orders')[0].cod_payment_status = 'PAID';
  await cod.assertReceivableById('o1');
});

test('partner staff cannot turn an unpaid COD order into Non-COD to get around the payment; an admin can', async () => {
  await cod.setPaymentType({ order: order(), type: 'COD', actor: customer });
  await assert.rejects(() => cod.setPaymentType({ order: order(), type: 'NON_COD', actor: staff }), /Only an admin/);
  assert.equal(order().payment_type, 'COD');
  assert.throws(() => cod.assertReceivable(order()), /Payment is required/);
  await cod.setPaymentType({ order: order(), type: 'NON_COD', actor: { ...staff, admin: true } });
  assert.equal(order().payment_type, 'NON_COD');
});

test('staff marking an order COD tells the customer, with the same amount the customer will be asked to pay', async () => {
  const done = await cod.setPaymentType({ order: order(), type: 'COD', actor: staff });
  assert.equal(done.order.cod_amount, 4200);
  const note = notices.find((n) => n.kind === 'user');
  assert.ok(note, 'the customer is notified');
  assert.match(JSON.stringify(note.args), /Payment required/);
  const start = await cod.startCodPayment({ order: order(), customer: {} });
  assert.equal(start.amount, done.order.cod_amount, 'the client sees exactly the amount staff saw');
});

test('the customer choosing COD themselves is not notified about their own action', async () => {
  await cod.setPaymentType({ order: order(), type: 'COD', actor: customer });
  assert.equal(notices.filter((n) => n.kind === 'user').length, 0);
});

test('a Shopify order that Shopify reports as fully paid cannot be marked COD (no second charge)', async () => {
  db.table('orders')[0].external_source = 'shopify';
  db.table('orders')[0].shopify_financial_status = 'paid';
  db.table('orders')[0].shopify_outstanding = 0;
  await assert.rejects(() => cod.setPaymentType({ order: order(), type: 'COD', actor: staff }), /fully paid/);
  assert.equal(order().payment_type, null);
});

test('a COD amount for a partly paid Shopify order is what Shopify says is outstanding, not the whole total', async () => {
  Object.assign(db.table('orders')[0], { external_source: 'shopify', shopify_financial_status: 'partially_paid', shopify_outstanding: 1200, brand_order_total: 4200, brand_order_currency: 'PKR' });
  const done = await cod.setPaymentType({ order: order(), type: 'COD', actor: staff });
  assert.equal(done.order.cod_amount, 1200);
  assert.equal(done.order.cod_currency, 'PKR');
  assert.equal(done.order.cod_amount_status, 'verified');
  assert.equal(cod.codView(order()).can_pay, true);
});

test('when Shopify later shows the order as paid, an unpaid COD order becomes Non-COD and its open payment is closed; a payment already made here is kept', async () => {
  const { intent } = await intentFor();
  const res = await cod.markPaidAtShopify(order());
  assert.equal(res.changed, true);
  assert.equal(order().payment_type, 'NON_COD');
  assert.equal(order().cod_payment_status, null);
  assert.ok(stripeState.canceled.includes(intent.id), 'the open intent can no longer be paid');
  assert.doesNotThrow(() => cod.assertReceivable(order()));

  db.table('orders')[0].payment_type = 'COD';
  db.table('orders')[0].cod_payment_status = 'PAID';
  assert.equal((await cod.markPaidAtShopify(order())).changed, false, 'the customer already paid here: kept');
  assert.equal(order().payment_type, 'COD');
});
