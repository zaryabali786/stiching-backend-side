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

// ───────────── the "Stitch&Ship available" tick box on products ─────────────

/** Fakes Shopify's GraphQL endpoint with one answer per call; records what was asked. */
const withShopify = async (answer, run) => {
  const real = globalThis.fetch;
  const asked = [];
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    asked.push({ url, body });
    return { ok: true, status: 200, json: async () => answer(body) };
  };
  try {
    return await run(asked);
  } finally {
    globalThis.fetch = real;
  }
};
const aStore = () => ({ id: 'st1', shop_domain: 'my-brand.myshopify.com', access_token_enc: sh.encryptToken('shpat_x'), settings: {} });

test('the tick box is created once per store, as an app-owned boolean on products the brand can edit', async () => {
  await withShopify(() => ({ data: { metafieldDefinitionCreate: { createdDefinition: { id: 'gid://shopify/MetafieldDefinition/1' }, userErrors: [] } } }), async (asked) => {
    const result = await sh.ensureProductMetafield(aStore());
    assert.deepEqual(result, { ok: true, error: null });
    const d = asked[0].body.variables.definition;
    assert.equal(d.namespace, '$app:stitchship');
    assert.equal(d.key, 'enabled');
    assert.equal(d.type, 'boolean');
    assert.equal(d.ownerType, 'PRODUCT');
    assert.equal(d.access.admin, 'MERCHANT_READ_WRITE');
    assert.equal(d.access.storefront, 'PUBLIC_READ');
  });
});

test('creating the tick box again is fine (already there), other Shopify refusals are reported', async () => {
  await withShopify(() => ({ data: { metafieldDefinitionCreate: { createdDefinition: null, userErrors: [{ message: 'Key is in use', code: 'TAKEN' }] } } }), async () => {
    assert.equal((await sh.ensureProductMetafield(aStore())).ok, true);
  });
  await withShopify(() => ({ data: { metafieldDefinitionCreate: { createdDefinition: null, userErrors: [{ message: 'Type is invalid', code: 'INVALID_TYPE' }] } } }), async () => {
    const r = await sh.ensureProductMetafield(aStore());
    assert.equal(r.ok, false);
    assert.match(r.error, /Type is invalid/);
  });
});

test('a store that has not approved write_products is told exactly what to do, and nothing throws', async () => {
  await withShopify(() => ({ errors: [{ message: 'Access denied for metafieldDefinitionCreate field. Required access: `write_products` access scope.', extensions: { code: 'ACCESS_DENIED' } }] }), async () => {
    const r = await sh.ensureProductMetafield(aStore());
    assert.equal(r.ok, false);
    assert.match(r.error, /write_products/);
    assert.match(r.error, /install link again/);
  });
});

test('the store status records whether the tick box is ready', async () => {
  db = createFakeDb({ shopify_stores: [{ id: 'st1', shop_domain: 'my-brand.myshopify.com', settings: { webhooks: { ok: true } } }] });
  await withShopify(() => ({ data: { metafieldDefinitionCreate: { createdDefinition: { id: 'x' }, userErrors: [] } } }), async () => {
    const store = { ...aStore(), settings: { webhooks: { ok: true } } };
    const status = await sh.connectProductMetafield(store);
    assert.equal(status.ok, true);
    const saved = db.table('shopify_stores')[0].settings;
    assert.equal(saved.tick_box.ok, true);
    assert.equal(saved.webhooks.ok, true, 'the other settings are kept');
  });
});

test('which products are enabled is read from Shopify, in one request, and only a ticked box counts', async () => {
  const answer = (body) => ({
    data: {
      nodes: body.variables.ids.map((id) => ({ id, metafield: id.endsWith('/1') ? { value: 'true' } : id.endsWith('/2') ? { value: 'false' } : null })),
    },
  });
  await withShopify(answer, async (asked) => {
    const set = await sh.productsStitchEnabled(aStore(), [1, 2, 3, 1, null]);
    assert.deepEqual([...set], ['1']);
    assert.equal(asked.length, 1, 'one request for all products');
    assert.deepEqual(asked[0].body.variables.ids, ['gid://shopify/Product/1', 'gid://shopify/Product/2', 'gid://shopify/Product/3']);
    assert.match(asked[0].body.query, /\$app:stitchship/);
  });
  await withShopify(() => assert.fail('no products: no request'), async () => {
    assert.equal((await sh.productsStitchEnabled(aStore(), [])).size, 0);
  });
});

// ───────────── taking the stitching lines off the original order ─────────────

const calcLines = [
  { id: 'c1', title: 'Suit', sku: 'S1', quantity: 1, variant: { id: 'gid://shopify/ProductVariant/11' } },
  { id: 'c2', title: 'Scarf', sku: null, quantity: 2, variant: { id: 'gid://shopify/ProductVariant/12' } },
  { id: 'c3', title: 'Suit', sku: 'S1', quantity: 1, variant: { id: 'gid://shopify/ProductVariant/11' } },
];
const suit = { variant_id: 11, sku: 'S1', title: 'Suit', quantity: 1 };
const scarf = { variant_id: 12, sku: null, title: 'Scarf', quantity: 2 };

test('each line to remove is matched to its own line in the editor, exactly (variant, SKU, title, quantity), each used once', () => {
  assert.deepEqual(sh.matchCalculatedLines([suit, scarf], calcLines), ['c1', 'c2']);
  assert.deepEqual(sh.matchCalculatedLines([suit, suit], calcLines), ['c1', 'c3'], 'two identical lines are two different lines');
});

test('a line that cannot be matched exactly stops everything before anything is changed', () => {
  for (const bad of [{ ...suit, variant_id: 99 }, { ...suit, quantity: 3 }, { ...scarf, title: 'Other' }]) {
    assert.throws(() => sh.matchCalculatedLines([bad], calcLines), /nothing was changed/);
  }
  assert.throws(() => sh.matchCalculatedLines([suit, suit, suit], calcLines), /nothing was changed/);
});

const begin = () => ({ data: { orderEditBegin: { calculatedOrder: { id: 'gid://shopify/CalculatedOrder/9', lineItems: { nodes: calcLines } }, userErrors: [] } } });

test('the edit: open one session, set every line to zero without restocking, commit once without telling the customer', async () => {
  const answer = (body) => {
    if (/orderEditBegin/.test(body.query)) return begin();
    if (/orderEditSetQuantity/.test(body.query)) return { data: { orderEditSetQuantity: { calculatedOrder: { id: 'x' }, userErrors: [] } } };
    return { data: { orderEditCommit: { order: { id: 'o', currentTotalPriceSet: { shopMoney: { amount: '86.00' } } }, userErrors: [] } } };
  };
  await withShopify(answer, async (asked) => {
    const r = await sh.removeLinesFromOrder(aStore(), 'gid://shopify/Order/5001', [suit, scarf], 'moved');
    assert.equal(r.total_cents, 8600);
    assert.equal(asked.length, 4, 'begin, two lines, commit');
    assert.deepEqual(asked.slice(1, 3).map((a) => a.body.variables.lineItemId), ['c1', 'c2']);
    assert.match(asked[1].body.query, /quantity: 0, restock: false/);
    assert.match(asked[3].body.query, /notifyCustomer: false/);
    assert.equal(asked[3].body.variables.note, 'moved');
  });
});

test('if a line cannot be matched, the editor is opened but nothing is staged or committed', async () => {
  await withShopify(begin, async (asked) => {
    await assert.rejects(() => sh.removeLinesFromOrder(aStore(), 'gid://shopify/Order/5001', [{ variant_id: 99, sku: 'X', title: 'Ghost', quantity: 1 }], 'moved'), /nothing was changed/);
    assert.equal(asked.length, 1, 'only the begin call: no line was set, no commit');
  });
});

test('Shopify refusing an edit is reported and the order is not committed', async () => {
  const answer = (body) => (/orderEditBegin/.test(body.query) ? begin() : { data: { orderEditSetQuantity: { calculatedOrder: null, userErrors: [{ message: 'Line item already fulfilled' }] } } });
  await withShopify(answer, async (asked) => {
    await assert.rejects(() => sh.removeLinesFromOrder(aStore(), 'gid://shopify/Order/5001', [suit], 'moved'), /already fulfilled/);
    assert.ok(!asked.some((a) => /orderEditCommit/.test(a.body.query)));
  });
});

test('the new order is created without sending anything to the customer, touching stock or charging anyone', async () => {
  const answer = () => ({ data: { orderCreate: { order: { id: 'gid://shopify/Order/8', name: '#1101', currentTotalPriceSet: { shopMoney: { amount: '44.00' } }, displayFinancialStatus: 'PAID' }, userErrors: [] } } });
  await withShopify(answer, async (asked) => {
    const made = await sh.createShopifyOrder(aStore(), { lineItems: [] });
    assert.deepEqual(made, { id: 'gid://shopify/Order/8', name: '#1101', total_cents: 4400, financial_status: 'paid' });
    assert.deepEqual(asked[0].body.variables.options, { inventoryBehaviour: 'BYPASS', sendReceipt: false, sendFulfillmentReceipt: false });
  });
  await withShopify(() => ({ data: { orderCreate: { order: null, userErrors: [{ message: 'Line items is invalid' }] } } }), async () => {
    await assert.rejects(() => sh.createShopifyOrder(aStore(), {}), /Line items is invalid/);
  });
});

test('an earlier new order is found by its source identifier', async () => {
  await withShopify(() => ({ data: { orders: { nodes: [{ id: 'gid://shopify/Order/8', name: '#1101', currentTotalPriceSet: { shopMoney: { amount: '44.00' } }, displayFinancialStatus: 'PAID' }] } } }), async (asked) => {
    const found = await sh.findOrderBySourceIdentifier(aStore(), 'stitchship-split-5001');
    assert.equal(found.name, '#1101');
    assert.equal(asked[0].body.variables.q, 'source_identifier:stitchship-split-5001');
  });
  await withShopify(() => ({ data: { orders: { nodes: [] } } }), async () => {
    assert.equal(await sh.findOrderBySourceIdentifier(aStore(), 'stitchship-split-1'), null);
  });
});
