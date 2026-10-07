/**
 * Tests card payments end to end against Stripe's TEST mode and the running backend.
 *   API_ORIGIN=http://localhost:5001 STRIPE_WEBHOOK_SECRET=<the secret the server was started with> npm run test:stripe
 * It creates throwaway orders with issued invoices (prefix "STRIPE TEST") and removes them afterwards.
 * "Paying" uses Stripe's built-in test payment methods (pm_card_visa, pm_card_chargeDeclined), no real card.
 */
import 'dotenv/config';
import Stripe from 'stripe';
import { supabaseAdmin } from '../src/config/supabase.js';

const ORIGIN = process.env.API_ORIGIN || 'http://localhost:5000';
const BASE = `${ORIGIN}/api`;
const PASSWORD = process.env.SEED_PASSWORD || 'Test@12345';
const WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

let failures = 0;
const ok = (m) => console.log(`  ✓ ${m}`);
const fail = (m) => {
  failures++;
  console.log(`  ✗ ${m}`);
};
const expect = (c, m) => (c ? ok(m) : fail(m));
const section = (t) => console.log(`\n${t}`);

async function call(token, method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token && { Authorization: `Bearer ${token}` }) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(`${method} ${path} → ${res.status}: ${json.message}`), { status: res.status, body: json });
  return json;
}
const rejects = async (label, promise, status) => {
  try {
    await promise;
    fail(`${label}: should have failed`);
  } catch (e) {
    expect(e.status === status, `${label} → ${e.status} ${(e.body?.message || e.message).slice(0, 80)}`);
  }
};
const login = async (email) => (await call(null, 'POST', '/auth/login', { email, password: PASSWORD })).data;

const created = [];
async function makeOrder(customer, { currency = 'GBP', totalForeign = 70.99, totalPkr = 26200 } = {}) {
  const { data: order, error } = await supabaseAdmin
    .from('orders')
    .insert({ customer_id: customer.user.id, customer_name: customer.user.full_name || 'Test', customer_code: customer.user.customer_code, brand: 'STRIPE TEST', status: 'awaiting_payment' })
    .select('*')
    .single();
  if (error) throw new Error(`could not create the test order: ${error.message}`);
  created.push(order.id);
  const { data: invoice, error: invErr } = await supabaseAdmin
    .from('invoices')
    .insert({ order_id: order.id, status: 'issued', currency, fx_rate: totalForeign ? Math.round((totalPkr / totalForeign) * 10000) / 10000 : 1, subtotal_pkr: totalPkr, total_pkr: totalPkr, total_foreign: totalForeign, issued_at: new Date().toISOString() })
    .select('*')
    .single();
  if (invErr) throw new Error(`could not create the test invoice: ${invErr.message}`);
  return { order, invoice };
}
const state = async (orderId) => {
  const { data: o } = await supabaseAdmin.from('orders').select('status, paid_at').eq('id', orderId).single();
  const { data: i } = await supabaseAdmin.from('invoices').select('status').eq('order_id', orderId).single();
  const { data: p } = await supabaseAdmin.from('payments').select('status, provider_ref, method').eq('order_id', orderId);
  return { order: o.status, invoice: i.status, payments: p };
};
const signedWebhook = (event, secret = WEBHOOK_SECRET) => {
  const payload = JSON.stringify(event);
  return { payload, signature: stripe.webhooks.generateTestHeaderString({ payload, secret }) };
};
const sendWebhook = async (event, { secret, signature } = {}) => {
  const { payload, signature: sig } = signedWebhook(event, secret);
  const res = await fetch(`${BASE}/webhooks/stripe`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'stripe-signature': signature ?? sig }, body: payload });
  return { status: res.status, body: await res.json().catch(() => ({})) };
};

async function main() {
  section('Setup');
  const customer = await login('customer@v360.test');
  const partner = await login('partner@v360.test');
  const C = customer.tokens.accessToken;
  const P = partner.tokens.accessToken;
  const cfg = (await call(null, 'GET', '/config')).data;
  expect(cfg.payments?.stripe?.enabled === true && /^pk_test_/.test(cfg.payments.stripe.publishableKey), 'public config exposes only the publishable key');
  expect(!JSON.stringify(cfg).includes('sk_'), 'secret key is not exposed anywhere in /config');
  const balance = await stripe.balance.retrieve();
  expect(balance.livemode === false, 'the keys are TEST mode keys (no real money)');

  section('Starting a payment');
  const a = await makeOrder(customer);
  const started = (await call(C, 'POST', `/client/orders/${a.order.id}/payment-intent`)).data;
  expect(/^pi_/.test(started.paymentIntentId) && /_secret_/.test(started.clientSecret), 'payment intent created with a client secret');
  const remote = await stripe.paymentIntents.retrieve(started.paymentIntentId);
  expect(remote.amount === 7099 && remote.currency === 'gbp', `Stripe has GBP 70.99 (amount ${remote.amount} ${remote.currency})`);
  expect(remote.metadata.order_id === a.order.id && remote.metadata.invoice_id === a.invoice.id, 'order and invoice ids travel in the payment metadata');
  const again = (await call(C, 'POST', `/client/orders/${a.order.id}/payment-intent`)).data;
  expect(again.paymentIntentId === started.paymentIntentId, 'reopening the sheet reuses the same payment intent');
  let s = await state(a.order.id);
  expect(s.payments.length === 1 && s.payments[0].status === 'pending', 'one pending payment row');
  await rejects('another role cannot start a customer payment', call(P, 'POST', `/client/orders/${a.order.id}/payment-intent`), 403);
  await rejects('unknown order', call(C, 'POST', '/client/orders/00000000-0000-0000-0000-000000000000/payment-intent'), 404);
  await rejects('simulated payment is refused now that Stripe is on', call(C, 'POST', `/client/orders/${a.order.id}/pay`), 400);
  const notYet = (await call(C, 'POST', `/client/orders/${a.order.id}/payment-intent/confirm`, { payment_intent_id: started.paymentIntentId })).data;
  expect(notYet.paid === false && notYet.status === 'requires_payment_method', 'confirming before paying changes nothing');
  await rejects('garbage reference', call(C, 'POST', `/client/orders/${a.order.id}/payment-intent/confirm`, { payment_intent_id: 'nope' }), 400);

  section('Changed invoice gets a fresh payment intent');
  await supabaseAdmin.from('invoices').update({ total_foreign: 80.0 }).eq('id', a.invoice.id);
  const fresh = (await call(C, 'POST', `/client/orders/${a.order.id}/payment-intent`)).data;
  expect(fresh.paymentIntentId !== started.paymentIntentId && fresh.amount === 80, 'a new intent for the new amount');
  expect((await stripe.paymentIntents.retrieve(started.paymentIntentId)).status === 'canceled', 'the outdated intent was cancelled at Stripe');

  section('Paying with a test card, confirmed by the app');
  await stripe.paymentIntents.confirm(fresh.paymentIntentId, { payment_method: 'pm_card_visa' });
  const done = (await call(C, 'POST', `/client/orders/${a.order.id}/payment-intent/confirm`, { payment_intent_id: fresh.paymentIntentId })).data;
  expect(done.paid === true && done.settled === true, 'server asked Stripe and settled the invoice');
  s = await state(a.order.id);
  expect(s.order === 'paid' && s.invoice === 'paid', 'order = paid, invoice = paid');
  expect(s.payments.filter((p) => p.status === 'succeeded').length === 1 && s.payments.find((p) => p.status === 'succeeded').method === 'card', 'one succeeded card payment recorded');
  const again2 = (await call(C, 'POST', `/client/orders/${a.order.id}/payment-intent/confirm`, { payment_intent_id: fresh.paymentIntentId })).data;
  expect(again2.paid === true && again2.settled === false, 'confirming twice is harmless');
  await rejects('cannot pay an already paid order', call(C, 'POST', `/client/orders/${a.order.id}/payment-intent`), 400);
  const cn = (await call(C, 'GET', '/notifications?limit=50')).data.filter((n) => n.order_id === a.order.id && /Payment confirmed/.test(n.title));
  expect(cn.length === 1, 'customer got exactly one "Payment confirmed" notification');

  section('Webhook');
  if (!WEBHOOK_SECRET) {
    fail('STRIPE_WEBHOOK_SECRET must be set for this test (use the same value the server runs with)');
  } else {
    const b = await makeOrder(customer, { currency: 'USD', totalForeign: 120, totalPkr: 33600 });
    const bi = (await call(C, 'POST', `/client/orders/${b.order.id}/payment-intent`)).data;
    await stripe.paymentIntents.confirm(bi.paymentIntentId, { payment_method: 'pm_card_visa' });
    const paidIntent = await stripe.paymentIntents.retrieve(bi.paymentIntentId);
    const event = { id: 'evt_test_1', object: 'event', type: 'payment_intent.succeeded', data: { object: paidIntent } };
    const bad = await sendWebhook(event, { signature: 't=1,v1=deadbeef' });
    expect(bad.status === 400, `forged signature rejected (${bad.status})`);
    const wrongSecret = await sendWebhook(event, { secret: 'whsec_somebody_else' });
    expect(wrongSecret.status === 400, 'signature made with another secret rejected');
    expect((await state(b.order.id)).order === 'awaiting_payment', 'rejected webhooks changed nothing');
    const good = await sendWebhook(event);
    expect(good.status === 200 && good.body.received === true, 'correctly signed webhook accepted');
    s = await state(b.order.id);
    expect(s.order === 'paid' && s.invoice === 'paid', 'the webhook alone marked the order paid (tab closed / app killed case)');
    const dup = await sendWebhook(event);
    const viaApp = (await call(C, 'POST', `/client/orders/${b.order.id}/payment-intent/confirm`, { payment_intent_id: bi.paymentIntentId })).data;
    s = await state(b.order.id);
    expect(dup.status === 200 && viaApp.paid === true && s.payments.filter((p) => p.status === 'succeeded').length === 1, 'webhook retry + app confirm after it: still one payment');
    const notes = (await call(C, 'GET', '/notifications?limit=50')).data.filter((n) => n.order_id === b.order.id && /Payment confirmed/.test(n.title));
    expect(notes.length === 1, 'still exactly one notification');
    const unrelated = await sendWebhook({ id: 'evt_2', object: 'event', type: 'charge.refunded', data: { object: {} } });
    expect(unrelated.status === 200, 'event types we do not use are acknowledged');
    const foreign = await sendWebhook({ id: 'evt_3', object: 'event', type: 'payment_intent.succeeded', data: { object: { id: 'pi_not_ours', metadata: {}, amount: 100, currency: 'usd' } } });
    expect(foreign.status === 200, 'a payment that is not ours is ignored without an error');

    section('Declined card');
    const d = await makeOrder(customer, { currency: 'GBP', totalForeign: 25, totalPkr: 9000 });
    const di = (await call(C, 'POST', `/client/orders/${d.order.id}/payment-intent`)).data;
    let declined = null;
    try {
      await stripe.paymentIntents.confirm(di.paymentIntentId, { payment_method: 'pm_card_chargeDeclined' });
    } catch (e) {
      declined = e;
    }
    expect(declined?.code === 'card_declined', 'Stripe declines the test card');
    const afterDecline = (await call(C, 'POST', `/client/orders/${d.order.id}/payment-intent/confirm`, { payment_intent_id: di.paymentIntentId })).data;
    expect(afterDecline.paid === false && afterDecline.status === 'requires_payment_method' && !!afterDecline.error, `app is told it failed: "${afterDecline.error}"`);
    s = await state(d.order.id);
    expect(s.order === 'awaiting_payment' && s.invoice === 'issued', 'order stays awaiting payment after a decline');
    const failNote = (await call(C, 'GET', '/notifications?limit=50')).data.find((n) => n.order_id === d.order.id && /Payment failed/.test(n.title));
    expect(!!failNote, 'customer notified of the failed payment');
    const retry = (await call(C, 'POST', `/client/orders/${d.order.id}/payment-intent`)).data;
    expect(!!retry.clientSecret, 'customer can try again');
    await stripe.paymentIntents.confirm(retry.paymentIntentId, { payment_method: 'pm_card_visa' });
    await call(C, 'POST', `/client/orders/${d.order.id}/payment-intent/confirm`, { payment_intent_id: retry.paymentIntentId });
    s = await state(d.order.id);
    expect(s.order === 'paid', 'a second attempt with a good card succeeds');

    section('Wrong amount is not accepted as payment');
    const m = await makeOrder(customer, { currency: 'GBP', totalForeign: 50, totalPkr: 18000 });
    const mi = (await call(C, 'POST', `/client/orders/${m.order.id}/payment-intent`)).data;
    await stripe.paymentIntents.confirm(mi.paymentIntentId, { payment_method: 'pm_card_visa' });
    await supabaseAdmin.from('invoices').update({ total_foreign: 90 }).eq('id', m.invoice.id); // invoice changed after paying
    await call(C, 'POST', `/client/orders/${m.order.id}/payment-intent/confirm`, { payment_intent_id: mi.paymentIntentId });
    s = await state(m.order.id);
    expect(s.invoice === 'issued' && s.order === 'awaiting_payment', 'payment below the invoice total does not mark it paid');
    const adminToken = (await login('admin@v360.test')).tokens.accessToken;
    const alert = (await call(adminToken, 'GET', '/notifications?limit=50')).data.find((n) => /Check payment for/.test(n.title) && n.order_id === m.order.id);
    expect(!!alert, 'admins are alerted to review it');

    section('PKR invoices');
    const k = await makeOrder(customer, { currency: 'PKR', totalForeign: 0, totalPkr: 26200 });
    try {
      const ki = (await call(C, 'POST', `/client/orders/${k.order.id}/payment-intent`)).data;
      const kr = await stripe.paymentIntents.retrieve(ki.paymentIntentId);
      expect(kr.currency === 'pkr' && kr.amount === 2620000, `PKR 26,200 accepted by Stripe (${kr.amount} ${kr.currency})`);
    } catch (e) {
      console.log(`  ! Stripe did not accept a PKR charge for this account: ${e.message}`);
    }
  }
}

async function cleanup() {
  section('Cleanup');
  for (const id of created) await supabaseAdmin.from('orders').delete().eq('id', id);
  await supabaseAdmin.from('notifications').delete().like('title', '%Check payment for%').like('body', '%pi_%');
  ok(`removed ${created.length} test orders (invoices, payments and notifications cascade)`);
}

try {
  await main();
} catch (e) {
  fail(`unexpected error: ${e.message}`);
  console.log(e.stack?.split('\n').slice(0, 4).join('\n'));
}
await cleanup();
console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll checks passed');
process.exit(failures ? 1 : 0);
