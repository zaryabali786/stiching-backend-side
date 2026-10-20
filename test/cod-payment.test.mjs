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
  stripeState = { sessions: {}, byKey: {}, created: [], expired: [], n: 0, enabled: true };
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
      retrievePaymentIntent: async () => ({}),
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
  stripeState.enabled = true;
  db = createFakeDb({
    orders: [baseOrder()],
    inbox_emails: [{ id: 'em1', import_id: 'imp1', body_text: EMAIL }],
    order_events: [],
    cod_amount_audit: [],
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
  const moved = await cod.setPaymentType({ order: order(), type: 'NON_COD', actor: staff });
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
  assert.deepEqual(Object.keys(view).sort(), ['amount', 'amount_note', 'amount_status', 'can_choose', 'can_pay', 'currency', 'email_order', 'email_says_cod', 'locked', 'needs_verification', 'paid_at', 'payment_status', 'payment_type']);
  assert.equal(JSON.stringify(view).includes(session.id), false);
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
