/**
 * The security basics of the Shopify connection: signatures, install state, store address, encrypted tokens, and the one-time
 * sign-in codes. No network: nothing here talks to Shopify, and the database is faked.
 */
import { test, mock, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createFakeDb } from './fake-supabase.mjs';

let db;
let sh;
let codes;
const dbProxy = new Proxy({}, { get: (_, key) => db[key] });
const SECRET = 'test-shopify-secret';

before(async () => {
  process.env.SHOPIFY_APP_API_KEY = 'test-key';
  process.env.SHOPIFY_APP_API_SECRET = SECRET;
  process.env.SHOPIFY_APP_URL = 'https://api.example.test';
  process.env.SHOPIFY_TOKEN_KEY = crypto.randomBytes(32).toString('hex');
  process.env.LOGIN_CODE_SECRET = 'test-login-secret';
  mock.module('../src/config/supabase.js', { namedExports: { supabaseAdmin: dbProxy, supabase: dbProxy } });
  sh = await import('../src/services/shopify.service.js');
  codes = await import('../src/services/login-code.service.js');
});

beforeEach(() => {
  db = createFakeDb({ login_codes: [] });
});

const hmacBase64 = (body, secret = SECRET) => crypto.createHmac('sha256', secret).update(body).digest('base64');

test('store addresses are only accepted as <name>.myshopify.com', () => {
  assert.equal(sh.normaliseShop('My-Brand.myshopify.com'), 'my-brand.myshopify.com');
  assert.equal(sh.normaliseShop('https://my-brand.myshopify.com/admin'), 'my-brand.myshopify.com');
  for (const bad of ['evil.com', 'my-brand.myshopify.com.evil.com', 'my brand.myshopify.com', '', null, 'https://x.myshopify.com@evil.com']) assert.equal(sh.normaliseShop(bad), null, String(bad));
});

test('a webhook is accepted only with Shopify\'s signature over the exact bytes', () => {
  const body = Buffer.from('{"id":1,"email":"a@b.c"}');
  assert.equal(sh.verifyWebhookHmac(body, hmacBase64(body)), true);
  assert.equal(sh.verifyWebhookHmac(body, hmacBase64(body, 'other-secret')), false, 'signed with another secret');
  assert.equal(sh.verifyWebhookHmac(Buffer.from('{"id":2}'), hmacBase64(body)), false, 'body changed after signing');
  assert.equal(sh.verifyWebhookHmac(body, ''), false);
  assert.equal(sh.verifyWebhookHmac(body, undefined), false);
  assert.equal(sh.verifyWebhookHmac(body, 'short'), false);
});

test('the install redirect is accepted only with Shopify\'s signature over the other parameters', () => {
  const q = { code: 'abc', shop: 'my-brand.myshopify.com', state: 'xyz', timestamp: '1700000000' };
  const message = Object.keys(q).sort().map((k) => `${k}=${q[k]}`).join('&');
  const hmac = crypto.createHmac('sha256', SECRET).update(message).digest('hex');
  assert.equal(sh.verifyOAuthHmac({ ...q, hmac }), true);
  assert.equal(sh.verifyOAuthHmac({ ...q, shop: 'evil.myshopify.com', hmac }), false, 'a changed parameter');
  assert.equal(sh.verifyOAuthHmac({ ...q }), false, 'no signature');
});

test('the install state is signed, bound to the shop and expires', () => {
  const state = sh.makeInstallState('my-brand.myshopify.com', 1_000_000);
  assert.equal(sh.readInstallState(state, 1_000_000 + 60_000).shop, 'my-brand.myshopify.com');
  assert.equal(sh.readInstallState(state, 1_000_000 + 11 * 60_000), null, 'older than 10 minutes');
  const [body, sig] = state.split('.');
  assert.equal(sh.readInstallState(`${body}.${sig.slice(0, -2)}xx`, 1_000_000), null, 'tampered signature');
  const forged = Buffer.from(JSON.stringify({ shop: 'evil.myshopify.com', n: '1', t: 1_000_000 })).toString('base64url');
  assert.equal(sh.readInstallState(`${forged}.${sig}`, 1_000_000), null, 'another shop with the old signature');
  assert.equal(sh.readInstallState('garbage', 1), null);
  const url = new URL(sh.buildInstallUrl('my-brand.myshopify.com'));
  assert.equal(url.hostname, 'my-brand.myshopify.com');
  assert.equal(url.searchParams.get('redirect_uri'), 'https://api.example.test/api/shopify/auth/callback');
  assert.match(url.searchParams.get('scope'), /write_merchant_managed_fulfillment_orders/);
});

test('access tokens are stored encrypted, each time differently, and a changed blob is refused', () => {
  const blob = sh.encryptToken('shpat_secret_token');
  assert.equal(blob.includes('shpat_secret_token'), false);
  assert.equal(sh.decryptToken(blob), 'shpat_secret_token');
  assert.notEqual(sh.encryptToken('shpat_secret_token'), blob, 'a fresh random value every time');
  const parts = blob.split('.');
  parts[3] = Buffer.from('tampered-data').toString('base64');
  assert.throws(() => sh.decryptToken(parts.join('.')));
  assert.throws(() => sh.decryptToken('nonsense'));
});

// ───────────── one-time sign-in codes ─────────────

test('a sign-in code works once, for its own email only', async () => {
  const code = await codes.issueLoginCode('ali@example.com');
  assert.match(code, /^\d{6}$/);
  assert.equal(db.table('login_codes')[0].code_hash.includes(code), false, 'only a hash is kept');
  assert.equal(await codes.redeemLoginCode({ email: 'sara@example.com', code }), false, 'another email');
  assert.equal(await codes.redeemLoginCode({ email: 'ali@example.com', code }), true);
  assert.equal(await codes.redeemLoginCode({ email: 'ali@example.com', code }), false, 'a used code is dead');
});

test('a wrong code is counted, five wrong tries lock it, an expired code fails', async () => {
  const code = await codes.issueLoginCode('ali@example.com');
  const wrong = code === '000000' ? '111111' : '000000';
  for (let i = 0; i < codes.MAX_ATTEMPTS; i++) assert.equal(await codes.redeemLoginCode({ email: 'ali@example.com', code: wrong }), false);
  assert.equal(await codes.redeemLoginCode({ email: 'ali@example.com', code }), false, 'locked even for the right code');

  db = createFakeDb({ login_codes: [] });
  const fresh = await codes.issueLoginCode('ali@example.com');
  db.table('login_codes')[0].expires_at = new Date(Date.now() - 1000).toISOString();
  assert.equal(await codes.redeemLoginCode({ email: 'ali@example.com', code: fresh }), false, 'expired');
  assert.equal(await codes.redeemLoginCode({ email: 'ali@example.com', code: 'abcdef' }), false, 'not 6 digits');
});

test('an email button token works once and only for its own email; codes are limited per email', async () => {
  const token = await codes.issueLoginCode('ali@example.com', { kind: 'link' });
  assert.equal(token.length, 48);
  assert.equal(await codes.redeemLoginCode({ email: 'sara@example.com', token }), false);
  assert.equal(await codes.redeemLoginCode({ email: 'ali@example.com', token: 'x'.repeat(48) }), false);
  assert.equal(await codes.redeemLoginCode({ email: 'ali@example.com', token }), true);
  assert.equal(await codes.redeemLoginCode({ email: 'ali@example.com', token }), false, 'single use');

  db = createFakeDb({ login_codes: [] });
  for (let i = 0; i < codes.MAX_REQUESTS_PER_HOUR; i++) await codes.issueLoginCode('busy@example.com');
  await assert.rejects(() => codes.issueLoginCode('busy@example.com'), /Too many/);
  await codes.issueLoginCode('other@example.com');
});

test('emails are normalised and checked', () => {
  assert.equal(codes.normaliseEmail('  Ali@Example.COM '), 'ali@example.com');
  assert.equal(codes.normaliseEmail('not an email'), null);
  assert.equal(codes.normaliseEmail('a@b'), null);
});

// ───────────── install and the store's webhooks ─────────────

const withFetch = async (fake, fn) => {
  const real = globalThis.fetch;
  globalThis.fetch = fake;
  try {
    return await fn();
  } finally {
    globalThis.fetch = real;
  }
};

test('the install keeps the token encrypted, registers the four order webhooks and records the result', async () => {
  db = createFakeDb({ shopify_stores: [{ shop_domain: 'my-brand.myshopify.com', status: 'pending' }] });
  const seen = [];
  const store = await withFetch(async (url, init) => {
    if (String(url).endsWith('/admin/oauth/access_token')) return { ok: true, json: async () => ({ access_token: 'shpat_live_token', scope: 'read_orders' }) };
    const body = JSON.parse(init.body);
    seen.push({ url: String(url), token: init.headers['X-Shopify-Access-Token'], topic: body.variables.topic, callback: body.variables.sub.callbackUrl, format: body.variables.sub.format });
    return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ data: { webhookSubscriptionCreate: { webhookSubscription: { id: 'gid://x' }, userErrors: [] } } }) };
  }, () => sh.completeInstall({ shop: 'my-brand.myshopify.com', code: 'abc' }));

  assert.equal(store.status, 'active');
  assert.equal(store.access_token_enc.includes('shpat_live_token'), false, 'the token is stored encrypted');
  assert.equal(sh.decryptToken(store.access_token_enc), 'shpat_live_token');
  assert.deepEqual(seen.map((s) => s.topic), ['ORDERS_CREATE', 'ORDERS_UPDATED', 'ORDERS_CANCELLED', 'APP_UNINSTALLED']);
  assert.ok(seen.every((s) => s.callback === 'https://api.example.test/api/webhooks/shopify' && s.format === 'JSON' && s.token === 'shpat_live_token'));
  assert.ok(seen.every((s) => s.url.startsWith('https://my-brand.myshopify.com/admin/api/')));
  const saved = db.table('shopify_stores')[0];
  assert.equal(saved.settings.webhooks.ok, true);
  assert.equal(db.table('shopify_stores').length, 1, 'an install of a store that is already registered updates it');
});

test('a webhook that already exists is fine; a real failure is recorded for the admin and does not stop the install', async () => {
  db = createFakeDb({ shopify_stores: [{ shop_domain: 'my-brand.myshopify.com', status: 'pending' }] });
  const store = await withFetch(async (url, init) => {
    if (String(url).endsWith('/admin/oauth/access_token')) return { ok: true, json: async () => ({ access_token: 'tok', scope: '' }) };
    const topic = JSON.parse(init.body).variables.topic;
    const userErrors = topic === 'ORDERS_CREATE' ? [{ message: 'Address for this topic has already been taken' }] : topic === 'ORDERS_UPDATED' ? [{ message: 'Missing scope read_orders' }] : [];
    return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ data: { webhookSubscriptionCreate: { userErrors } } }) };
  }, () => sh.completeInstall({ shop: 'my-brand.myshopify.com', code: 'abc' }));
  assert.equal(store.status, 'active', 'the install still succeeded');
  const saved = db.table('shopify_stores')[0];
  assert.equal(saved.settings.webhooks.ok, false);
  assert.equal(saved.settings.webhooks.failed.length, 1);
  assert.match(saved.settings.webhooks.failed[0], /ORDERS_UPDATED: Missing scope/);
});

test('Shopify refusing the code stops the install and stores nothing', async () => {
  db = createFakeDb({ shopify_stores: [] });
  await withFetch(async () => ({ ok: false, json: async () => ({}) }), async () => {
    await assert.rejects(() => sh.completeInstall({ shop: 'my-brand.myshopify.com', code: 'bad' }), /did not give the app its access/);
  });
  assert.equal(db.table('shopify_stores').length, 0);
});
