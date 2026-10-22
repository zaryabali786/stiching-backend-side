/**
 * Shopify's webhook door: the signature, writing each delivery down once, answering at once, doing the work afterwards, retrying a
 * failed delivery, and the store events (uninstall, privacy requests). The order work itself is faked here (see shopify-orders.test).
 */
import { test, mock, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createFakeDb } from './fake-supabase.mjs';

let db;
let ctl;
let events;
let calls;
let behave;
const dbProxy = new Proxy({}, { get: (_, key) => db[key] });
const SECRET = 'test-shopify-secret';

before(async () => {
  process.env.SHOPIFY_APP_API_KEY = 'test-key';
  process.env.SHOPIFY_APP_API_SECRET = SECRET;
  process.env.SHOPIFY_APP_URL = 'https://api.example.test';
  process.env.SHOPIFY_TOKEN_KEY = crypto.randomBytes(32).toString('hex');
  mock.module('../src/config/supabase.js', { namedExports: { supabaseAdmin: dbProxy, supabase: dbProxy } });
  mock.module('../src/services/notification.service.js', {
    namedExports: { notifyAdmins: async (n) => calls.admins.push(n), notifyUser: async () => {}, notifyPartner: async () => {}, notifyUsers: async () => {}, notifyStaff: async () => {}, partnerRecipients: async () => [] },
  });
  const STORE = () => db.table('shopify_stores').find((s) => s.status === 'active') || null;
  mock.module('../src/services/shopify-orders.service.js', {
    namedExports: {
      getActiveStore: async () => STORE(),
      processOrderCreate: async (store, payload) => {
        if (behave.createFails) throw new Error('Shopify is down');
        calls.created.push({ store: store.shop_domain, id: payload.id });
        return { status: 'processed' };
      },
      processOrderUpdated: async (store, payload) => (calls.updated.push(payload.id), { status: 'updated' }),
      processOrderCancelled: async (store, payload) => (calls.cancelled.push(payload.id), { status: 'cancelled' }),
      confirmAtelierAddress: async () => ({ changed: true }),
      resendCustomerEmail: async () => ({}),
      importShopifyOrder: async () => ({}),
      retryShopifyOrder: async () => ({}),
      shopifyQueue: async () => [],
    },
  });
  ctl = await import('../src/controllers/shopify.controller.js');
  events = await import('../src/services/shopify-events.service.js');
});

beforeEach(() => {
  calls = { admins: [], created: [], updated: [], cancelled: [] };
  behave = {};
  db = createFakeDb(
    { shopify_stores: [{ id: 'st1', shop_domain: 'my-brand.myshopify.com', status: 'active', access_token_enc: 'enc' }], shopify_webhook_events: [] },
    { uniques: { shopify_webhook_events: { when: () => true, key: (r) => r.webhook_id } } }
  );
});

const delivery = async ({ body, topic = 'orders/create', id = 'wh-1', signature, shop = 'my-brand.myshopify.com' }) => {
  const raw = Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
  const headers = {
    'x-shopify-hmac-sha256': signature ?? crypto.createHmac('sha256', SECRET).update(raw).digest('base64'),
    'x-shopify-topic': topic,
    'x-shopify-shop-domain': shop,
    'x-shopify-webhook-id': id,
  };
  const res = { code: 200, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } };
  await ctl.shopifyWebhook({ body: raw, get: (h) => headers[h.toLowerCase()] }, res);
  // the work happens after the answer: let it run
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
  return res;
};

test('a delivery without Shopify\'s signature is refused and not recorded', async () => {
  assert.equal((await delivery({ body: { id: 1 }, signature: 'forged' })).code, 401);
  assert.equal((await delivery({ body: { id: 1 }, signature: '' })).code, 401);
  assert.equal(db.table('shopify_webhook_events').length, 0);
  assert.deepEqual(calls.created, []);
});

test('a signed delivery is answered 200, recorded, worked on afterwards, and its personal data is dropped', async () => {
  const res = await delivery({ body: { id: 5001, email: 'a@b.c' } });
  assert.equal(res.code, 200);
  assert.deepEqual(calls.created, [{ store: 'my-brand.myshopify.com', id: 5001 }]);
  const [e] = db.table('shopify_webhook_events');
  assert.equal(e.topic, 'orders/create');
  assert.ok(e.processed_at);
  assert.equal(e.payload, null);
  assert.equal(e.attempts, 1);
});

test('the same delivery sent again is answered 200 and not processed twice', async () => {
  await delivery({ body: { id: 5001 }, id: 'wh-same' });
  const again = await delivery({ body: { id: 5001 }, id: 'wh-same' });
  assert.equal(again.code, 200);
  assert.equal(calls.created.length, 1);
  assert.equal(db.table('shopify_webhook_events').length, 1);
});

test('a signed delivery that is not JSON is refused', async () => {
  assert.equal((await delivery({ body: 'not json at all', id: 'wh-bad' })).code, 400);
});

test('a failed delivery keeps its payload and error, and the retry runs it again until it works', async () => {
  behave.createFails = true;
  const res = await delivery({ body: { id: 7 }, id: 'wh-retry' });
  assert.equal(res.code, 200, 'Shopify is always answered; the retry is ours');
  let [e] = db.table('shopify_webhook_events');
  assert.equal(e.processed_at ?? null, null);
  assert.match(e.last_error, /Shopify is down/);
  assert.ok(e.payload, 'kept for the retry');

  // not older than a minute yet: left alone
  await events.retryOpenEvents();
  assert.equal(calls.created.length, 0);

  e.created_at = new Date(Date.now() - 5 * 60_000).toISOString();
  behave.createFails = false;
  await events.retryOpenEvents();
  [e] = db.table('shopify_webhook_events');
  assert.ok(e.processed_at);
  assert.equal(e.last_error, null);
  assert.deepEqual(calls.created, [{ store: 'my-brand.myshopify.com', id: 7 }]);
  assert.equal(e.attempts, 2);
});

test('after too many failures the admins are told and the retries stop', async () => {
  behave.createFails = true;
  await delivery({ body: { id: 8 }, id: 'wh-dead' });
  const e = db.table('shopify_webhook_events')[0];
  e.created_at = new Date(Date.now() - 5 * 60_000).toISOString();
  for (let i = 0; i < 8; i++) await events.retryOpenEvents();
  assert.equal(e.attempts, 6);
  assert.ok(calls.admins.some((a) => /Shopify event failed/.test(a.title)));
});

test('updates and cancellations are passed on; uninstalling removes the token', async () => {
  await delivery({ body: { id: 9 }, topic: 'orders/updated', id: 'u1' });
  await delivery({ body: { id: 9 }, topic: 'orders/cancelled', id: 'u2' });
  assert.deepEqual({ u: calls.updated, c: calls.cancelled }, { u: [9], c: [9] });
  await delivery({ body: {}, topic: 'app/uninstalled', id: 'u3' });
  const store = db.table('shopify_stores')[0];
  assert.equal(store.status, 'uninstalled');
  assert.equal(store.access_token_enc, null);
  assert.ok(store.uninstalled_at);
});

test('Shopify\'s privacy requests reach an administrator; unknown topics are ignored', async () => {
  await delivery({ body: { customer: { email: 'x@y.z' } }, topic: 'customers/data_request', id: 'p1' });
  await delivery({ body: {}, topic: 'customers/redact', id: 'p2' });
  assert.equal(calls.admins.length, 2);
  await delivery({ body: {}, topic: 'products/update', id: 'p3' });
  assert.equal(db.table('shopify_webhook_events').filter((e) => e.processed_at).length, 3);
});

test('an order for a store that is not connected does nothing', async () => {
  db.table('shopify_stores')[0].status = 'uninstalled';
  await delivery({ body: { id: 10 }, id: 'n1' });
  assert.deepEqual(calls.created, []);
});

test('the atelier address endpoint shows only the address, no secrets', async () => {
  db = createFakeDb({ platform_settings: [{ key: 'ship_to', value: { shipToName: 'Stitch&Ship Atelier', shipToAddress: 'House 12', shipToCity: 'Lahore', shipToPhone: '042' } }] });
  const out = { headers: {}, body: null, set(k, v) { this.headers[k] = v; }, status() { return this; }, json(b) { this.body = b; return this; } };
  ctl.getAtelierAddress({}, out, (e) => { throw e; });
  for (let i = 0; i < 5 && !out.body; i++) await new Promise((r) => setImmediate(r));
  assert.deepEqual(Object.keys(out.body.data).sort(), ['address', 'city', 'country', 'countryCode', 'name', 'phone']);
  assert.equal(out.body.data.city, 'Lahore');
});
