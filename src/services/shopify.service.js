import crypto from 'node:crypto';
import { supabaseAdmin } from '../config/supabase.js';
import { config } from '../config/env.js';
import { AppError, BadRequestError } from '../utils/error.helper.js';

/**
 * Talking to Shopify: the keys, the signatures Shopify puts on what it sends us, the install (OAuth) steps, and the few Admin API
 * calls the stitching option needs (hold / release a shipment, add a tag, correct an address, read the product pictures).
 * The stores' access tokens are stored encrypted; nothing here ever prints a token.
 */

export const shopifyConfigured = () => !!(config.shopify.apiKey && config.shopify.apiSecret && config.shopify.tokenKey && config.shopify.appUrl);

/** "my-brand.myshopify.com" from anything a person might type, or null. */
export const normaliseShop = (value) => {
  const s = String(value ?? '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  return /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(s) ? s : null;
};

// ───────────── encrypted access tokens (AES-256-GCM) ─────────────

const tokenKey = () => {
  const raw = config.shopify.tokenKey;
  if (!raw) throw new AppError('SHOPIFY_TOKEN_KEY is not set on the server.', 503);
  const buf = /^[0-9a-f]{64}$/i.test(raw) ? Buffer.from(raw, 'hex') : Buffer.from(raw, 'base64');
  if (buf.length !== 32) throw new AppError('SHOPIFY_TOKEN_KEY must be 32 bytes (64 hex characters or 44 base64 characters).', 503);
  return buf;
};

export const encryptToken = (plain) => {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', tokenKey(), iv);
  const enc = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64'), cipher.getAuthTag().toString('base64'), enc.toString('base64')].join('.');
};

export const decryptToken = (blob) => {
  const [v, iv, tag, enc] = String(blob || '').split('.');
  if (v !== 'v1' || !iv || !tag || !enc) throw new AppError('The stored Shopify token is not readable.', 500);
  const decipher = crypto.createDecipheriv('aes-256-gcm', tokenKey(), Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(enc, 'base64')), decipher.final()]).toString('utf8');
};

// ───────────── signatures ─────────────

const safeEqual = (a, b) => {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

/** Shopify signs every webhook: base64 HMAC-SHA256 of the exact bytes, with the app's secret. */
export const verifyWebhookHmac = (rawBody, headerValue) => {
  if (!config.shopify.apiSecret || !headerValue) return false;
  const digest = crypto.createHmac('sha256', config.shopify.apiSecret).update(rawBody).digest('base64');
  return safeEqual(digest, headerValue);
};

/** The install redirect carries `hmac`: hex HMAC-SHA256 of the other query parameters, sorted, with the app's secret. */
export const verifyOAuthHmac = (query) => {
  const { hmac, ...rest } = query || {};
  if (!config.shopify.apiSecret || !hmac) return false;
  const message = Object.keys(rest)
    .sort()
    .map((k) => `${k}=${Array.isArray(rest[k]) ? rest[k].join(',') : rest[k]}`)
    .join('&');
  return safeEqual(crypto.createHmac('sha256', config.shopify.apiSecret).update(message).digest('hex'), hmac);
};

const STATE_TTL_MS = 10 * 60 * 1000;
const sign = (text) => crypto.createHmac('sha256', config.shopify.apiSecret).update(text).digest('base64url');

/** A signed, expiring `state` for the install redirect (it also proves the callback belongs to the shop we sent away). */
export const makeInstallState = (shop, now = Date.now()) => {
  const body = Buffer.from(JSON.stringify({ shop, n: crypto.randomBytes(8).toString('hex'), t: now })).toString('base64url');
  return `${body}.${sign(body)}`;
};

export const readInstallState = (state, now = Date.now()) => {
  const [body, sig] = String(state || '').split('.');
  if (!body || !sig || !safeEqual(sign(body), sig)) return null;
  try {
    const data = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    return now - data.t <= STATE_TTL_MS ? data : null;
  } catch {
    return null;
  }
};

export const buildInstallUrl = (shop) => {
  const redirect = `${config.shopify.appUrl}/api/shopify/auth/callback`;
  const q = new URLSearchParams({ client_id: config.shopify.apiKey, scope: config.shopify.scopes, redirect_uri: redirect, state: makeInstallState(shop) });
  return `https://${shop}/admin/oauth/authorize?${q.toString()}`;
};

/** The brand approved the install: exchange the temporary code for the store's permanent token and keep it (encrypted). */
export const completeInstall = async ({ shop, code }) => {
  const res = await fetch(`https://${shop}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ client_id: config.shopify.apiKey, client_secret: config.shopify.apiSecret, code }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) throw new BadRequestError('Shopify did not give the app its access. Please start the install again.');
  const row = {
    shop_domain: shop,
    access_token_enc: encryptToken(data.access_token),
    scopes: String(data.scope || ''),
    status: 'active',
    installed_at: new Date().toISOString(),
    uninstalled_at: null,
    updated_at: new Date().toISOString(),
  };
  const { data: store, error } = await supabaseAdmin.from('shopify_stores').upsert(row, { onConflict: 'shop_domain' }).select('*').single();
  if (error) throw error;
  await connectWebhooks(store);
  return store;
};

// ───────────── webhooks of one store ─────────────

/** The notifications we want from every store. With the classic install flow they are registered per store, through the API. */
export const WEBHOOK_TOPICS = ['ORDERS_CREATE', 'ORDERS_UPDATED', 'ORDERS_CANCELLED', 'APP_UNINSTALLED'];

const WEBHOOK_CREATE = `mutation($topic: WebhookSubscriptionTopic!, $sub: WebhookSubscriptionInput!) { webhookSubscriptionCreate(topic: $topic, webhookSubscription: $sub) { webhookSubscription { id } userErrors { field message } } }`;

/**
 * Subscribe a store to the notifications. A subscription that already exists (the install ran twice) counts as done.
 * @returns {Promise<{ ok: boolean, failed: string[] }>}
 */
export const registerWebhooks = async (store, callbackUrl = `${config.shopify.appUrl}/api/webhooks/shopify`) => {
  const failed = [];
  for (const topic of WEBHOOK_TOPICS) {
    try {
      const res = await shopifyGraphql(store, WEBHOOK_CREATE, { topic, sub: { callbackUrl, format: 'JSON' } });
      const errs = res?.webhookSubscriptionCreate?.userErrors || [];
      const onlyTaken = errs.length > 0 && errs.every((e) => /already been taken|already exists/i.test(e.message || ''));
      if (errs.length && !onlyTaken) failed.push(`${topic}: ${errs.map((e) => e.message).join('; ')}`);
    } catch (err) {
      failed.push(`${topic}: ${err.message}`);
    }
  }
  return { ok: failed.length === 0, failed };
};

/** Registers the webhooks and writes the result on the store (settings.webhooks), so the admin page can show it. Never throws. */
export const connectWebhooks = async (store) => {
  let result;
  try {
    result = await registerWebhooks(store);
  } catch (err) {
    result = { ok: false, failed: [err.message] };
  }
  const status = { ok: result.ok, at: new Date().toISOString(), failed: result.failed.slice(0, 4) };
  const settings = { ...(store.settings || {}), webhooks: status };
  await supabaseAdmin.from('shopify_stores').update({ settings, updated_at: new Date().toISOString() }).eq('id', store.id);
  store.settings = settings;
  if (!result.ok) console.warn(`[Shopify] webhooks of ${store.shop_domain} could not all be registered:`, result.failed.join(' | '));
  return status;
};

export const getActiveStore = async (shopDomain) => {
  const shop = normaliseShop(shopDomain);
  if (!shop) return null;
  const { data } = await supabaseAdmin.from('shopify_stores').select('*').eq('shop_domain', shop).eq('status', 'active').maybeSingle();
  return data || null;
};

// ───────────── Admin API ─────────────

export class ShopifyError extends Error {
  constructor(message, status = 502) {
    super(message);
    this.name = 'ShopifyError';
    this.status = status;
  }
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** One GraphQL call to a store. Retries when Shopify says "slow down"; throws ShopifyError for anything else. */
export const shopifyGraphql = async (store, query, variables = {}) => {
  const token = decryptToken(store.access_token_enc);
  const url = `https://${store.shop_domain}/admin/api/${config.shopify.apiVersion}/graphql.json`;
  let lastError = 'Shopify did not answer.';
  for (let attempt = 0; attempt < 3; attempt++) {
    let res;
    try {
      res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': token }, body: JSON.stringify({ query, variables }) });
    } catch (err) {
      lastError = `Shopify could not be reached: ${err.message}`;
      await wait(500 * (attempt + 1));
      continue;
    }
    if (res.status === 429) {
      await wait(Math.min(5000, Number(res.headers.get('retry-after') || 1) * 1000));
      lastError = 'Shopify is busy (rate limited).';
      continue;
    }
    if (!res.ok) throw new ShopifyError(`Shopify answered ${res.status}.`, res.status);
    const json = await res.json().catch(() => ({}));
    if (json.errors?.length) {
      if (json.errors.some((e) => e?.extensions?.code === 'THROTTLED')) {
        await wait(1000 * (attempt + 1));
        lastError = 'Shopify is busy (throttled).';
        continue;
      }
      throw new ShopifyError(json.errors.map((e) => e.message).join('; '));
    }
    return json.data;
  }
  throw new ShopifyError(lastError);
};

const userErrors = (result, what) => {
  const errs = result?.userErrors || [];
  if (errs.length) throw new ShopifyError(`${what}: ${errs.map((e) => e.message).join('; ')}`, 422);
};

const FULFILLMENT_ORDERS = `query($id: ID!) { order(id: $id) { id fulfillmentOrders(first: 20) { nodes { id status } } } }`;
const HOLD = `mutation($id: ID!, $hold: FulfillmentOrderHoldInput!) { fulfillmentOrderHold(id: $id, fulfillmentHold: $hold) { fulfillmentHold { id } userErrors { field message } } }`;
const RELEASE = `mutation($id: ID!, $holdIds: [ID!]) { fulfillmentOrderReleaseHold(id: $id, holdIds: $holdIds) { userErrors { field message } } }`;
const TAGS_ADD = `mutation($id: ID!, $tags: [String!]!) { tagsAdd(id: $id, tags: $tags) { userErrors { field message } } }`;
const ORDER_UPDATE = `mutation($input: OrderInput!) { orderUpdate(input: $input) { userErrors { field message } } }`;
const LINE_ITEMS = `query($id: ID!) { order(id: $id) { lineItems(first: 50) { nodes { id sku image { url } product { onlineStoreUrl } } } } }`;

/** Stop the brand from shipping this order until we have checked the address. Returns [{ fo, hold }] for releasing it later. */
export const holdFulfillment = async (store, orderGid, reasonNotes) => {
  const data = await shopifyGraphql(store, FULFILLMENT_ORDERS, { id: orderGid });
  const open = (data?.order?.fulfillmentOrders?.nodes || []).filter((f) => ['OPEN', 'SCHEDULED', 'IN_PROGRESS'].includes(f.status));
  const holds = [];
  for (const fo of open) {
    const res = await shopifyGraphql(store, HOLD, { id: fo.id, hold: { reason: 'OTHER', reasonNotes: String(reasonNotes).slice(0, 250), notifyMerchant: false } });
    userErrors(res.fulfillmentOrderHold, 'Could not hold the shipment');
    holds.push({ fo: fo.id, hold: res.fulfillmentOrderHold.fulfillmentHold?.id });
  }
  return holds;
};

export const releaseFulfillment = async (store, holds) => {
  for (const h of holds || []) {
    const res = await shopifyGraphql(store, RELEASE, { id: h.fo, holdIds: h.hold ? [h.hold] : null });
    userErrors(res.fulfillmentOrderReleaseHold, 'Could not release the shipment');
  }
};

export const addOrderTag = async (store, orderGid, tag) => {
  const res = await shopifyGraphql(store, TAGS_ADD, { id: orderGid, tags: [tag] });
  userErrors(res.tagsAdd, 'Could not tag the order');
};

/** Put the Stitch&Ship atelier as the shipping address (only ever done with the customer's consent). */
export const updateShippingAddress = async (store, orderGid, address) => {
  const res = await shopifyGraphql(store, ORDER_UPDATE, { input: { id: orderGid, shippingAddress: address } });
  userErrors(res.orderUpdate, 'Could not change the shipping address');
};

/** Pictures and product pages of the order's lines, by line item id. Best effort: an empty map when Shopify refuses. */
export const fetchLineItemDetails = async (store, orderGid) => {
  try {
    const data = await shopifyGraphql(store, LINE_ITEMS, { id: orderGid });
    const map = new Map();
    for (const n of data?.order?.lineItems?.nodes || []) {
      const numeric = String(n.id).split('/').pop();
      map.set(numeric, { image_url: n.image?.url || null, url: n.product?.onlineStoreUrl || null });
    }
    return map;
  } catch {
    return new Map();
  }
};

// ───────────── payment facts and clothing eligibility (read only) ─────────────

const ORDER_FINANCIALS = `query($id: ID!) { order(id: $id) {
  displayFinancialStatus
  totalReceivedSet { shopMoney { amount } }
  totalRefundedSet { shopMoney { amount } }
  totalOutstandingSet { shopMoney { amount } }
  transactions(first: 100) { id kind status amountSet { shopMoney { amount } } }
  refunds(first: 50) { id totalRefundedSet { shopMoney { amount } } refundLineItems(first: 100) { nodes { lineItem { id } subtotalSet { shopMoney { amount } } totalTaxSet { shopMoney { amount } } } } }
} }`;

const centsOf = (money) => Math.round(Number(money?.shopMoney?.amount || 0) * 100);

/**
 * What Shopify itself says was collected and refunded for one order, from its transactions (the authoritative record, not the webhook).
 * Throws when Shopify cannot be reached: the caller keeps the payment as "not verified" and retries later.
 * @returns {{ financial_status: string, total_received: number, total_refunded: number, outstanding: number, transactions_ok: boolean, refunds: object[] }} amounts in major units
 */
export const fetchOrderFinancials = async (store, orderGid) => {
  const data = await shopifyGraphql(store, ORDER_FINANCIALS, { id: orderGid });
  const o = data?.order;
  if (!o) throw new ShopifyError('Shopify did not return the order.', 404);
  const ok = (t) => String(t.status).toUpperCase() === 'SUCCESS';
  // money in = successful sales and captures; money out = successful refunds
  const received = (o.transactions || []).filter((t) => ok(t) && ['SALE', 'CAPTURE'].includes(String(t.kind).toUpperCase())).reduce((n, t) => n + centsOf(t.amountSet), 0);
  const refunded = (o.transactions || []).filter((t) => ok(t) && String(t.kind).toUpperCase() === 'REFUND').reduce((n, t) => n + centsOf(t.amountSet), 0);
  return {
    financial_status: String(o.displayFinancialStatus || '').toLowerCase(),
    // Shopify's own totals are kept next to the transaction sums: they must agree for the payment to count as verified
    total_received: received / 100,
    total_refunded: refunded / 100,
    outstanding: centsOf(o.totalOutstandingSet) / 100,
    transactions_ok: received === centsOf(o.totalReceivedSet),
    refunds: (o.refunds || []).map((r) => ({
      total: centsOf(r.totalRefundedSet),
      lines: (r.refundLineItems?.nodes || []).map((n) => ({ line_id: String(n.lineItem?.id || '').split('/').pop(), cents: centsOf(n.subtotalSet) + centsOf(n.totalTaxSet) })),
    })),
  };
};

const COLLECTION_BY_HANDLE = `query($handle: String!) { collectionByIdentifier(identifier: { handle: $handle }) { id } }`;
const PRODUCT_IN_COLLECTION = `query($id: ID!, $collection: ID!) { product(id: $id) { id inCollection(id: $collection) } }`;
const collectionCache = new Map();

/** The clothing collection the brand configured (a handle, a numeric id or a gid) as a gid; null when nothing is configured or it does not exist. */
export const resolveCollectionGid = async (store, configured) => {
  const value = String(configured || '').trim();
  if (!value) return null;
  if (/^gid:\/\/shopify\/Collection\/\d+$/.test(value)) return value;
  if (/^\d+$/.test(value)) return `gid://shopify/Collection/${value}`;
  const key = `${store.id}:${value.toLowerCase()}`;
  if (collectionCache.has(key)) return collectionCache.get(key);
  const data = await shopifyGraphql(store, COLLECTION_BY_HANDLE, { handle: value.toLowerCase() });
  const gid = data?.collectionByIdentifier?.id || null;
  if (gid) collectionCache.set(key, gid);
  return gid;
};

/**
 * Which of these products (numeric ids) belong to the collection. Asked of Shopify itself, so a customer cannot make a product eligible
 * by editing the page. Throws when Shopify cannot be reached.
 * @returns {Promise<Set<string>>}
 */
export const productsInCollection = async (store, productIds, collectionGid) => {
  const eligible = new Set();
  for (const id of [...new Set(productIds.filter(Boolean).map(String))]) {
    const data = await shopifyGraphql(store, PRODUCT_IN_COLLECTION, { id: `gid://shopify/Product/${id}`, collection: collectionGid });
    if (data?.product?.inCollection === true) eligible.add(id);
  }
  return eligible;
};
