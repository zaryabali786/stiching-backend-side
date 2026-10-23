import crypto from 'node:crypto';
import { supabaseAdmin } from '../config/supabase.js';
import { config } from '../config/env.js';
import { AppError, BadRequestError } from '../utils/error.helper.js';
import { atelierCountryCode, loadShipTo } from './ship-to.service.js';

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
  await connectProductMetafield(store);
  await connectPaymentRule(store);
  await connectShipping(store);
  return store;
};

// ───────────── webhooks of one store ─────────────

/** The notifications we want from every store. With the classic install flow they are registered per store, through the API. */
export const WEBHOOK_TOPICS = ['ORDERS_CREATE', 'ORDERS_UPDATED', 'ORDERS_CANCELLED', 'APP_UNINSTALLED', 'REFUNDS_CREATE', 'PRODUCTS_UPDATE', 'PRODUCTS_DELETE'];

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

// ───────────── the "Stitch&Ship available" tick box on every product ─────────────

const METAFIELD_CREATE = `mutation($definition: MetafieldDefinitionInput!) { metafieldDefinitionCreate(definition: $definition) { createdDefinition { id } userErrors { field message code } } }`;

/**
 * Create the product tick box "Stitch&Ship available" in a store (an app-owned boolean metafield, namespace $app:stitchship, key enabled).
 * The brand then sees it on every product's page in the Shopify admin; the product-page block and this server both look at it.
 * Shopify does not take a declared product metafield from an app that completes its own install, so it is created through the API.
 * Already there counts as done. Needs the write_products permission (a store installed before it was asked for has to approve it).
 * @returns {Promise<{ ok: boolean, error: string|null }>}
 */
export const ensureProductMetafield = async (store) => {
  try {
    const res = await shopifyGraphql(store, METAFIELD_CREATE, {
      definition: {
        name: 'Stitch&Ship available',
        namespace: '$app:stitchship',
        key: 'enabled',
        type: 'boolean',
        ownerType: 'PRODUCT',
        description: "Tick to offer customised stitching with Stitch&Ship on this product's page.",
        access: { admin: 'MERCHANT_READ_WRITE', storefront: 'PUBLIC_READ' },
        pin: true,
      },
    });
    const errs = res?.metafieldDefinitionCreate?.userErrors || [];
    const taken = errs.length > 0 && errs.every((e) => e.code === 'TAKEN' || /already (in use|exists|been taken)/i.test(e.message || ''));
    if (errs.length && !taken) return { ok: false, error: errs.map((e) => e.message).join('; ') };
    return { ok: true, error: null };
  } catch (err) {
    const denied = /access denied|write_products|scope|permission/i.test(err.message || '');
    return { ok: false, error: denied ? 'Needs the write_products permission: the brand must open the install link again and approve it.' : err.message };
  }
};

/**
 * The atelier address as a shop metafield (app-owned, publicly readable) so the checkout extension can fill it in without any network access.
 * Written again whenever the tick box is (re)created and whenever a Stitch&Ship order is processed, so an edited address follows.
 */
export const syncAtelierMetafield = async (store, atelier) => {
  try {
    await shopifyGraphql(store, METAFIELD_CREATE, {
      definition: { name: 'Stitch&Ship atelier address', namespace: '$app:stitchship', key: 'atelier', type: 'json', ownerType: 'SHOP', access: { admin: 'MERCHANT_READ', storefront: 'PUBLIC_READ' } },
    }).catch(() => undefined); // already there is fine
    const shop = await shopifyGraphql(store, 'query { shop { id } }');
    const value = JSON.stringify({ name: atelier.shipToName || 'Stitch&Ship Atelier', company: atelier.shipToCompany || '', address: atelier.shipToAddress || '', address2: atelier.shipToAddress2 || '', city: atelier.shipToCity || '', phone: atelier.shipToPhone || '', country: atelier.shipToCountry || '', countryCode: atelierCountryCode(atelier, store), state: atelier.shipToState || '', provinceCode: atelier.shipToProvinceCode || '', zip: atelier.shipToZip || '' });
    const res = await shopifyGraphql(store, 'mutation($m: [MetafieldsSetInput!]!) { metafieldsSet(metafields: $m) { userErrors { message } } }', {
      m: [{ ownerId: shop.shop.id, namespace: '$app:stitchship', key: 'atelier', type: 'json', value }],
    });
    const errs = res?.metafieldsSet?.userErrors || [];
    return errs.length ? { ok: false, error: errs.map((e) => e.message).join('; ') } : { ok: true, error: null };
  } catch (err) {
    return { ok: false, error: err.message };
  }
};

/** The admin changed the atelier address: every active store gets it for its checkout (one failing store never stops the others). */
export const syncAtelierEverywhere = async () => {
  const atelier = await loadShipTo();
  const { data: stores } = await supabaseAdmin.from('shopify_stores').select('*').eq('status', 'active');
  const results = [];
  for (const store of stores || []) {
    results.push({ shop: store.shop_domain, ...(await syncAtelierMetafield(store, atelier)) });
    // the shipping method's description carries the address: an existing method follows the new address (it is never created here)
    if (store.settings?.shipping?.method?.ok) await ensureShippingMethod(store, atelier).catch(() => undefined);
  }
  return results;
};

/** Creates the tick box and writes the result on the store (settings.tick_box), so the admin page can show it. Never throws. */
export const connectProductMetafield = async (store) => {
  const result = await ensureProductMetafield(store);
  const atelier = await loadShipTo().catch(() => null);
  if (atelier) await syncAtelierMetafield(store, atelier);
  const settings = { ...(store.settings || {}), tick_box: { ok: result.ok, at: new Date().toISOString(), error: result.error } };
  await supabaseAdmin.from('shopify_stores').update({ settings, updated_at: new Date().toISOString() }).eq('id', store.id);
  store.settings = settings;
  if (!result.ok) console.warn(`[Shopify] the tick box of ${store.shop_domain} could not be created:`, result.error);
  return settings.tick_box;
};

// ───────────── the payment rule: no COD / bank transfer for a Stitch&Ship order ─────────────

const RULE_TITLE = 'Stitch&Ship: online payment only';
const RULE_FUNCTION_HANDLE = 'stitchship-payments';

/**
 * Switch on the app's payment customization (the function in extensions/stitchship-payments) in a store. Already there counts as done; one that
 * was switched off is switched on again. Needs the write_payment_customizations permission (a store installed before it was asked for has to
 * approve it), and Shopify only runs the function on a development store or Shopify Plus.
 * @returns {Promise<{ ok: boolean, error: string|null }>}
 */
export const ensurePaymentRule = async (store) => {
  try {
    const found = await shopifyGraphql(store, 'query { paymentCustomizations(first: 50) { nodes { id title enabled } } }');
    const rule = (found?.paymentCustomizations?.nodes || []).find((n) => n.title === RULE_TITLE);
    if (rule) {
      if (rule.enabled) return { ok: true, error: null };
      const res = await shopifyGraphql(store, 'mutation($ids: [ID!]!) { paymentCustomizationActivation(ids: $ids, enabled: true) { userErrors { message } } }', { ids: [rule.id] });
      const errs = res?.paymentCustomizationActivation?.userErrors || [];
      return errs.length ? { ok: false, error: errs.map((e) => e.message).join('; ') } : { ok: true, error: null };
    }
    const res = await shopifyGraphql(store, 'mutation($input: PaymentCustomizationInput!) { paymentCustomizationCreate(paymentCustomization: $input) { paymentCustomization { id } userErrors { message } } }', {
      input: { title: RULE_TITLE, enabled: true, functionHandle: RULE_FUNCTION_HANDLE },
    });
    const errs = res?.paymentCustomizationCreate?.userErrors || [];
    return errs.length ? { ok: false, error: errs.map((e) => e.message).join('; ') } : { ok: true, error: null };
  } catch (err) {
    const denied = /access denied|payment_customizations|scope|permission/i.test(err.message || '');
    return { ok: false, error: denied ? 'Needs the write_payment_customizations permission: the brand must open the install link again and approve it.' : err.message };
  }
};

/** Switches the payment rule on and writes the result on the store (settings.payment_rule), so the admin page can show it. Never throws. */
export const connectPaymentRule = async (store) => {
  const result = await ensurePaymentRule(store);
  const settings = { ...(store.settings || {}), payment_rule: { ok: result.ok, at: new Date().toISOString(), error: result.error } };
  await supabaseAdmin.from('shopify_stores').update({ settings, updated_at: new Date().toISOString() }).eq('id', store.id);
  store.settings = settings;
  if (!result.ok) console.warn(`[Shopify] the payment rule of ${store.shop_domain} could not be switched on:`, result.error);
  return settings.payment_rule;
};

// ───────────── the shipping method "Ship to Stitch & Ship" ─────────────

export const SHIP_METHOD_NAME = 'Ship to Stitch & Ship';
const DELIVERY_RULE_TITLE = 'Stitch&Ship: only the Stitch&Ship shipping method';
const DELIVERY_FUNCTION_HANDLE = 'stitchship-delivery';

/** The text under the method at the checkout: why it is the only choice, where the parcel goes, and how long it takes. */
export const shippingDescription = (atelier) => {
  const place = [atelier?.shipToCity, atelier?.shipToState, atelier?.shipToZip].filter(Boolean).join(', ');
  const address = [atelier?.shipToName, atelier?.shipToCompany, atelier?.shipToAddress, atelier?.shipToAddress2, place, atelier?.shipToCountry].filter(Boolean).join(', ');
  return `This order includes a Stitch&Ship product, which needs to be delivered to our stitching atelier${address ? `: ${address}` : ''}. 2-5 working days.`.slice(0, 500);
};

// Shopify refuses a query whose cost is over 1000, so the profiles are read one at a time: first the list, then each profile with its zones and rates.
const PROFILE_LIST_QUERY = `query { deliveryProfiles(first: 25) { nodes { id name default } } }`;
const profileQuery = (zones, methods) => `query($id: ID!) { deliveryProfile(id: $id) { id name default profileLocationGroups { locationGroup { id } locationGroupZones(first: ${zones}) { nodes {
  zone { id name countries { code { countryCode restOfWorld } } }
  methodDefinitions(first: ${methods}) { nodes { id name description active rateProvider { __typename ... on DeliveryRateDefinition { price { amount currencyCode } } } methodConditions { field operator conditionCriteria { __typename ... on MoneyV2 { amount currencyCode } ... on Weight { value unit } } } } }
} } } } }`;

/** One profile with its zones and rates; asks for less (fewer zones and rates at once) when Shopify says the query costs too much. */
const readProfile = async (store, id) => {
  let last = null;
  for (const [zones, methods] of [[25, 25], [10, 10], [4, 4]]) {
    try {
      const res = await shopifyGraphql(store, profileQuery(zones, methods), { id });
      return res?.deliveryProfile || null;
    } catch (err) {
      if (!/max cost|exceeds the single query/i.test(err.message || '')) throw err;
      last = err;
    }
  }
  throw last;
};

const PROFILE_UPDATE = `mutation($id: ID!, $profile: DeliveryProfileInput!) { deliveryProfileUpdate(id: $id, profile: $profile) { profile { id } userErrors { field message } } }`;

/** One rate of the Pakistan zone as the input for a new method (same price, same price / weight conditions). */
const copyOfRate = (m, description) => {
  const priceConditions = [];
  const weightConditions = [];
  for (const c of m.methodConditions || []) {
    const crit = c.conditionCriteria || {};
    if (c.field === 'TOTAL_PRICE' && crit.amount != null) priceConditions.push({ operator: c.operator, criteria: { amount: crit.amount, currencyCode: crit.currencyCode } });
    if (c.field === 'TOTAL_WEIGHT' && crit.value != null) weightConditions.push({ operator: c.operator, criteria: { value: crit.value, unit: crit.unit } });
  }
  return {
    name: SHIP_METHOD_NAME,
    description,
    active: true,
    rateDefinition: { price: { amount: m.rateProvider.price.amount, currencyCode: m.rateProvider.price.currencyCode } },
    ...(priceConditions.length ? { priceConditionsToCreate: priceConditions } : {}),
    ...(weightConditions.length ? { weightConditionsToCreate: weightConditions } : {}),
  };
};

/**
 * Put the method "Ship to Stitch & Ship" into ONE zone of ONE shipping profile with the same rates and rules as that zone's own: the cheapest
 * named rate is copied with all its price / weight steps. The method already there only gets its description (the atelier address) refreshed.
 */
const addMethodToZone = async (store, profile, target, description) => {
  const methods = (target.zone.methodDefinitions?.nodes || []).filter((m) => m.rateProvider?.__typename === 'DeliveryRateDefinition');
  const ours = methods.filter((m) => m.name === SHIP_METHOD_NAME);
  const zoneInput = { id: target.zone.zone.id };
  if (ours.length) {
    const stale = ours.filter((m) => m.description !== description);
    if (!stale.length) return { ok: true, error: null, created: 0, updated: 0 };
    zoneInput.methodDefinitionsToUpdate = stale.map((m) => ({ id: m.id, description }));
  } else {
    const own = methods.filter((m) => m.active);
    if (!own.length) return { ok: false, error: `Zone "${target.zone.zone.name}" of the shipping profile "${profile.name}" has no active rate to copy.` };
    const price = (m) => Number(m.rateProvider.price.amount);
    const cheapest = own.reduce((a, b) => (price(b) < price(a) ? b : a));
    zoneInput.methodDefinitionsToCreate = own.filter((m) => m.name === cheapest.name).map((m) => copyOfRate(m, description));
  }
  const res = await shopifyGraphql(store, PROFILE_UPDATE, { id: profile.id, profile: { locationGroupsToUpdate: [{ id: target.groupId, zonesToUpdate: [zoneInput] }] } });
  const errs = res?.deliveryProfileUpdate?.userErrors || [];
  if (errs.length) return { ok: false, error: errs.map((e) => e.message).join('; ') };
  return { ok: true, error: null, created: zoneInput.methodDefinitionsToCreate?.length || 0, updated: zoneInput.methodDefinitionsToUpdate?.length || 0 };
};

/** What the store has, in a sentence: "General profile: Domestic (PK, AE), Rest of world (rest of world)". */
const describeZones = (profiles) =>
  profiles
    .map((p) => {
      const zones = (p.profileLocationGroups || []).flatMap((g) => g.locationGroupZones?.nodes || []);
      const text = zones.map((z) => `${z.zone?.name} (${(z.zone?.countries || []).map((c) => (c.code?.restOfWorld ? 'rest of world' : c.code?.countryCode)).join(', ') || 'no countries'})`).join(', ');
      return `${p.name || 'profile'}: ${text || 'no zones'}`;
    })
    .join(' | ');

/**
 * The older way a store keeps its shipping: shipping PROFILES with zones (Settings > Shipping and delivery). In every profile the zone that
 * holds Pakistan is used, else the "Rest of world" zone, which is what covers Pakistan then. Needs the write_shipping permission.
 */
const ensureShippingViaProfiles = async (store, description) => {
  try {
    const list = await shopifyGraphql(store, PROFILE_LIST_QUERY);
    const profiles = [];
    for (const p of list?.deliveryProfiles?.nodes || []) {
      const full = await readProfile(store, p.id);
      if (full) profiles.push(full);
    }
    if (!profiles.length) return { ok: false, error: 'The store has no shipping profile.' };
    const results = [];
    for (const profile of profiles) {
      let pk = null;
      let world = null;
      for (const group of profile.profileLocationGroups || []) {
        for (const z of group.locationGroupZones?.nodes || []) {
          const countries = z.zone?.countries || [];
          if (countries.some((c) => c.code?.countryCode === 'PK')) pk = pk || { groupId: group.locationGroup.id, zone: z };
          else if (countries.some((c) => c.code?.restOfWorld)) world = world || { groupId: group.locationGroup.id, zone: z };
        }
      }
      const target = pk || world;
      if (target) results.push(await addMethodToZone(store, profile, target, description));
    }
    if (!results.length) return { ok: false, error: `No shipping zone of the store covers Pakistan (not even "Rest of world"). Add Pakistan to a zone in Settings > Shipping and delivery, then try again. The store has: ${describeZones(profiles)}.`.slice(0, 700) };
    const done = results.filter((r) => r.ok);
    if (!done.length) return { ok: false, error: results.map((r) => r.error).join(' ').slice(0, 700) };
    return { ok: true, error: null, created: done.reduce((n, r) => n + (r.created || 0), 0), updated: done.reduce((n, r) => n + (r.updated || 0), 0) };
  } catch (err) {
    const denied = /access denied|shipping|scope|permission/i.test(err.message || '');
    return { ok: false, error: denied ? 'Needs the write_shipping permission: the brand must open the install link again and approve it.' : err.message };
  }
};

// ───── market-driven shipping: the shipping options live in the Markets of the store (Settings > Markets) ─────

const MARKETS_QUERY = `query { markets(first: 50) { nodes { id name status conditions { regionsCondition { regions(first: 25) { nodes { ... on MarketRegionCountry { code } } } } } } } }`;
const MARKET_SHIPPING_QUERY = `query($id: ID!) { market(id: $id) { id name delivery { shipping { isEnabled optionDefinitions(first: 25) { nodes { __typename id currency isActive freeDeliveryMinimumValue { amount currencyCode }
  ... on DeliveryFlatRateOptionDefinition { name description rateGroups(first: 10) { nodes { rate { price { amount currencyCode } transitTimeMinSeconds transitTimeMaxSeconds } } } } } } } } } }`;
const MARKET_UPDATE = `mutation($id: ID!, $input: MarketUpdateInput!) { marketUpdate(id: $id, input: $input) { market { id } userErrors { field message } } }`;
const TRANSIT_MIN_SECONDS = 2 * 24 * 3600; // 2-5 working days
const TRANSIT_MAX_SECONDS = 5 * 24 * 3600;

/** Add the method to one market, a copy of its cheapest active flat-rate option (price, free-delivery threshold), or refresh its description. */
const addMethodToMarket = async (store, market, description) => {
  const shipping = market.delivery?.shipping;
  if (!shipping) return { ok: false, error: `The market "${market.name}" takes its shipping from its parent market. Add a shipping option to the "${market.name}" market itself, then try again.` };
  if (shipping.isEnabled === false) return { ok: false, error: `Shipping is switched off for the market "${market.name}".` };
  const options = shipping.optionDefinitions?.nodes || [];
  const ours = options.filter((o) => o.name === SHIP_METHOD_NAME);
  let shippingInput;
  if (ours.length) {
    const stale = ours.filter((o) => o.description !== description);
    if (!stale.length) return { ok: true, error: null, created: 0, updated: 0 };
    shippingInput = { optionDefinitionsToUpdate: stale.map((o) => ({ flatRate: { id: o.id, description } })) };
  } else {
    const flat = options.filter((o) => o.__typename === 'DeliveryFlatRateOptionDefinition' && o.isActive && (o.rateGroups?.nodes || []).length);
    if (!flat.length) return { ok: false, error: `The market "${market.name}" has no active flat-rate shipping option to copy (weight and order-value options cannot be copied automatically).` };
    const low = (o) => Math.min(...o.rateGroups.nodes.map((g) => Number(g.rate.price.amount)));
    const src = flat.reduce((a, c) => (low(c) < low(a) ? c : a));
    shippingInput = {
      optionDefinitionsToCreate: [
        {
          flatRate: {
            name: SHIP_METHOD_NAME,
            description,
            currency: src.currency,
            isActive: true,
            ...(src.freeDeliveryMinimumValue ? { freeDeliveryMinimumValue: { amount: src.freeDeliveryMinimumValue.amount, currencyCode: src.freeDeliveryMinimumValue.currencyCode } } : {}),
            rateGroups: src.rateGroups.nodes.map((g) => ({ rate: { price: { amount: g.rate.price.amount, currencyCode: g.rate.price.currencyCode }, transitTimeMinSeconds: TRANSIT_MIN_SECONDS, transitTimeMaxSeconds: TRANSIT_MAX_SECONDS } })),
          },
        },
      ],
    };
  }
  const res = await shopifyGraphql(store, MARKET_UPDATE, { id: market.id, input: { delivery: { shipping: shippingInput } } });
  const errs = res?.marketUpdate?.userErrors || [];
  if (errs.length) return { ok: false, error: errs.map((e) => e.message).join('; ') };
  return { ok: true, error: null, created: shippingInput.optionDefinitionsToCreate?.length || 0, updated: shippingInput.optionDefinitionsToUpdate?.length || 0 };
};

/**
 * A store on market-driven shipping keeps its shipping options in Markets (the profile API no longer shows them). The market that covers
 * Pakistan (a country region of PK, or a market named Pakistan) gets the method. `handled` is false when there is no such market (or Markets
 * cannot be read), so the profile way is tried next; `note` says why.
 */
const ensureShippingViaMarkets = async (store, description) => {
  try {
    const list = await shopifyGraphql(store, MARKETS_QUERY);
    const markets = list?.markets?.nodes || [];
    const covers = (m) => (m.conditions?.regionsCondition?.regions?.nodes || []).some((r) => r.code === 'PK') || /pakistan/i.test(m.name || '');
    const pk = markets.filter((m) => covers(m) && m.status !== 'DRAFT');
    if (!pk.length) return { handled: false, note: 'No market of the store covers Pakistan.' };
    const results = [];
    for (const m of pk) {
      const detail = await shopifyGraphql(store, MARKET_SHIPPING_QUERY, { id: m.id });
      if (detail?.market) results.push(await addMethodToMarket(store, detail.market, description));
    }
    if (!results.length) return { handled: false, note: 'The Pakistan market could not be read.' };
    const done = results.filter((r) => r.ok);
    if (done.length) return { handled: true, res: { ok: true, error: null, created: done.reduce((n, r) => n + (r.created || 0), 0), updated: done.reduce((n, r) => n + (r.updated || 0), 0) } };
    return { handled: true, res: { ok: false, error: results.map((r) => r.error).join(' ').slice(0, 700) } };
  } catch (err) {
    const denied = /access denied|markets|scope|permission/i.test(err.message || '');
    return { handled: false, note: denied ? 'Needs the write_markets permission: the brand must open the install link again and approve it.' : `Markets: ${err.message}` };
  }
};

/**
 * Create the method "Ship to Stitch & Ship" where the store ships to Pakistan, with the same rates and rules as the Pakistan market: in the
 * Pakistan market when the store uses market-driven shipping, else in its shipping profiles. Its description carries the atelier address.
 * @returns {Promise<{ ok: boolean, error: string|null, created?: number, updated?: number }>}
 */
export const ensureShippingMethod = async (store, atelier) => {
  const description = shippingDescription(atelier);
  const viaMarkets = await ensureShippingViaMarkets(store, description);
  if (viaMarkets.handled) return viaMarkets.res;
  const viaProfiles = await ensureShippingViaProfiles(store, description);
  if (viaProfiles.ok) return viaProfiles;
  return { ok: false, error: `${viaMarkets.note} ${viaProfiles.error}`.slice(0, 900) };
};

/**
 * Switch on the app's delivery customization (extensions/stitchship-delivery): in a Stitch&Ship cart only the "Ship to Stitch & Ship" method is
 * offered, in any other cart that method is hidden. Shopify runs it on a development store or Shopify Plus; on other plans it is created but idle.
 */
export const ensureDeliveryRule = async (store) => {
  try {
    const found = await shopifyGraphql(store, 'query { deliveryCustomizations(first: 50) { nodes { id title enabled } } }');
    const rule = (found?.deliveryCustomizations?.nodes || []).find((n) => n.title === DELIVERY_RULE_TITLE);
    if (rule) {
      if (rule.enabled) return { ok: true, error: null };
      const res = await shopifyGraphql(store, 'mutation($ids: [ID!]!) { deliveryCustomizationActivation(ids: $ids, enabled: true) { userErrors { message } } }', { ids: [rule.id] });
      const errs = res?.deliveryCustomizationActivation?.userErrors || [];
      return errs.length ? { ok: false, error: errs.map((e) => e.message).join('; ') } : { ok: true, error: null };
    }
    const res = await shopifyGraphql(store, 'mutation($input: DeliveryCustomizationInput!) { deliveryCustomizationCreate(deliveryCustomization: $input) { deliveryCustomization { id } userErrors { message } } }', {
      input: { title: DELIVERY_RULE_TITLE, enabled: true, functionHandle: DELIVERY_FUNCTION_HANDLE },
    });
    const errs = res?.deliveryCustomizationCreate?.userErrors || [];
    return errs.length ? { ok: false, error: errs.map((e) => e.message).join('; ') } : { ok: true, error: null };
  } catch (err) {
    const denied = /access denied|delivery_customizations|scope|permission/i.test(err.message || '');
    return { ok: false, error: denied ? 'Needs the write_delivery_customizations permission: the brand must open the install link again and approve it.' : err.message };
  }
};

/** Creates the shipping method and switches on the delivery rule; writes the result on the store (settings.shipping). Never throws. */
export const connectShipping = async (store) => {
  const atelier = await loadShipTo().catch(() => null);
  const method = await ensureShippingMethod(store, atelier);
  const rule = await ensureDeliveryRule(store);
  const settings = { ...(store.settings || {}), shipping: { method, rule, at: new Date().toISOString() } };
  await supabaseAdmin.from('shopify_stores').update({ settings, updated_at: new Date().toISOString() }).eq('id', store.id);
  store.settings = settings;
  if (!method.ok) console.warn(`[Shopify] the shipping method of ${store.shop_domain} could not be created:`, method.error);
  if (!rule.ok) console.warn(`[Shopify] the delivery rule of ${store.shop_domain} could not be switched on:`, rule.error);
  return settings.shipping;
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

const HOLDS_OF = `query($id: ID!) { fulfillmentOrder(id: $id) { id status fulfillmentHolds { id } } }`;
const RELEASE_ALL = `mutation($id: ID!) { fulfillmentOrderReleaseHold(id: $id) { userErrors { field message } } }`;

/**
 * Let go of the holds we placed. Shopify answered "internal error" once when the hold was named after the order had been edited, so a failed
 * release is tried once more, and then, only if our hold is the ONLY hold on that shipment, released without naming it (nobody else's hold
 * is ever released).
 */
export const releaseFulfillment = async (store, holds) => {
  for (const h of holds || []) {
    try {
      const res = await shopifyGraphql(store, RELEASE, { id: h.fo, holdIds: h.hold ? [h.hold] : null });
      userErrors(res.fulfillmentOrderReleaseHold, 'Could not release the shipment');
    } catch (first) {
      const current = await shopifyGraphql(store, HOLDS_OF, { id: h.fo }).catch(() => null);
      const open = current?.fulfillmentOrder?.fulfillmentHolds || [];
      if (current?.fulfillmentOrder && open.length === 0) continue; // already released
      if (open.length !== 1) throw first;
      const res = await shopifyGraphql(store, RELEASE_ALL, { id: h.fo });
      userErrors(res.fulfillmentOrderReleaseHold, 'Could not release the shipment');
    }
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

// ───────────── Stitch&Ship eligibility (read only) ─────────────

const centsOf = (money) => Math.round(Number(money?.shopMoney?.amount || 0) * 100);

const PRODUCTS_ENABLED = `query($ids: [ID!]!) { nodes(ids: $ids) { ... on Product { id metafield(namespace: "$app:stitchship", key: "enabled") { value } } } }`;

/**
 * Which of these products (numeric ids) have "Stitch&Ship available" ticked in the Shopify admin (the app's own product metafield,
 * namespace $app:stitchship, key enabled). Asked of Shopify itself, so a customer cannot make a product eligible by editing the page.
 * Throws when Shopify cannot be reached.
 * @returns {Promise<Set<string>>}
 */
export const productsStitchEnabled = async (store, productIds) => {
  const ids = [...new Set((productIds || []).filter(Boolean).map(String))];
  const enabled = new Set();
  if (!ids.length) return enabled;
  const data = await shopifyGraphql(store, PRODUCTS_ENABLED, { ids: ids.map((id) => `gid://shopify/Product/${id}`) });
  // what Shopify answered for each product (the value, or null when the box was never touched / the product is gone), for the log
  enabled.metafieldValues = new Map(ids.map((id) => [id, null]));
  for (const node of data?.nodes || []) {
    if (!node?.id) continue;
    const id = String(node.id).split('/').pop();
    enabled.metafieldValues.set(id, node.metafield?.value ?? null);
    if (node.metafield?.value === 'true') enabled.add(id);
  }
  return enabled;
};

// ───────────── notes on an order ─────────────

const ORDER_NOTE = `query($id: ID!) { order(id: $id) { id note currentTotalPriceSet { shopMoney { amount } } } }`;

/** The order's note (and current total, in cents). */
export const fetchOrderTotal = async (store, orderGid) => {
  const data = await shopifyGraphql(store, ORDER_NOTE, { id: orderGid });
  if (!data?.order) throw new ShopifyError('Shopify did not return the order.', 404);
  return { total_cents: centsOf(data.order.currentTotalPriceSet), note: data.order.note || '' };
};

/** Tag an order and add a line to its note (the note is read first, so nothing written by someone else is lost). */
export const tagAndNoteOrder = async (store, orderGid, tag, line) => {
  if (tag) await addOrderTag(store, orderGid, tag);
  if (!line) return;
  const { note } = await fetchOrderTotal(store, orderGid);
  if (note.includes(line)) return;
  const res = await shopifyGraphql(store, ORDER_UPDATE, { input: { id: orderGid, note: [note, line].filter(Boolean).join('\n') } });
  userErrors(res.orderUpdate, 'Could not write the order note');
};

/** An order as the REST API (and so the orders/create webhook) shapes it, found by its number ("#1015" or "1015"); null when there is none. */
export const fetchRestOrder = async (store, orderName) => {
  const name = `#${String(orderName).trim().replace(/^#/, '')}`;
  const url = `https://${store.shop_domain}/admin/api/${config.shopify.apiVersion}/orders.json?status=any&name=${encodeURIComponent(name)}`;
  const res = await fetch(url, { headers: { 'X-Shopify-Access-Token': decryptToken(store.access_token_enc) } });
  if (!res.ok) throw new ShopifyError(`Shopify answered ${res.status}.`, res.status);
  const json = await res.json();
  return (json.orders || []).find((o) => o.name === name) || null;
};
