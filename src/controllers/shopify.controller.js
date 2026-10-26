import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { supabaseAdmin } from '../config/supabase.js';
import { config } from '../config/env.js';
import { catchAsync, ApiResponse, BadRequestError, ConflictError, NotFoundError } from '../utils/error.helper.js';
import { buildInstallUrl, completeInstall, connectPaymentRule, connectProductMetafield, connectShipping, connectWebhooks, normaliseShop, readInstallState, shopFromInput, shopifyConfigured, verifyOAuthHmac, verifyWebhookHmac } from '../services/shopify.service.js';
import { confirmAtelierAddress, importShopifyOrder, resendCustomerEmail, retryShopifyOrder, shopifyQueue } from '../services/shopify-orders.service.js';
import { processWebhookEvent, recordWebhookEvent } from '../services/shopify-events.service.js';
import { atelierCountryName, loadShipTo, shipToView } from '../services/ship-to.service.js';
import { smsEnabled } from '../services/sms.service.js';

// ───────────── what the brand's browser and Shopify call (no login) ─────────────

const APP_ASSETS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../public/shopify-app');
const escapeHtml = (v) => String(v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);


/**
 * GET /api/shopify/auth?shop=<store>.myshopify.com — starts the install. Any Shopify store may install: the store is added here by itself when the
 * brand approves (completeInstall), so nobody has to add it first. An administrator can still add a store by hand and link it to a brand.
 */
export const shopifyInstall = catchAsync(async (req, res) => {
  if (!shopifyConfigured()) throw new BadRequestError('The Shopify connection is not set up on the server yet.');
  const shop = shopFromInput(req.query.shop);
  if (!shop) throw new BadRequestError('Enter the store address like my-brand.myshopify.com.');
  return res.redirect(302, buildInstallUrl(shop));
});

let installPage = null;

/** GET /api/shopify — the public install page: the one link to send to any brand. With ?shop= it goes straight to the install. */
export const shopifyLanding = catchAsync(async (req, res) => {
  if (!shopifyConfigured()) throw new BadRequestError('The Shopify connection is not set up on the server yet.');
  const typed = String(req.query.shop ?? '').trim();
  const shop = shopFromInput(typed);
  if (shop) return res.redirect(302, `${config.shopify.appUrl}/api/shopify/auth?shop=${encodeURIComponent(shop)}`);
  installPage = installPage || fs.readFileSync(path.join(APP_ASSETS_DIR, 'install.html'), 'utf8');
  const error = typed ? 'We could not read that address. Use the one that ends in .myshopify.com (Shopify admin → Settings → Domains), or just the first part of it.' : '';
  res.set('Cache-Control', 'no-store');
  return res.status(200).type('html').send(installPage.replace('%%ERROR%%', escapeHtml(error)).replace('%%VALUE%%', escapeHtml(typed)));
});

/** GET /api/shopify/auth/callback — Shopify sends the brand back here after they approved the app. */
export const shopifyInstallCallback = catchAsync(async (req, res) => {
  if (!shopifyConfigured()) throw new BadRequestError('The Shopify connection is not set up on the server yet.');
  const shop = normaliseShop(req.query.shop);
  const state = readInstallState(req.query.state);
  if (!shop || !state || state.shop !== shop || !verifyOAuthHmac(req.query) || !req.query.code) throw new BadRequestError('This install link is not valid or has expired. Please start the install again.');
  await completeInstall({ shop, code: String(req.query.code) });
  // the brand lands on the Stitch&Ship page inside its own Shopify admin (its setup guide), not on a plain "connected" page
  return res.redirect(302, `https://admin.shopify.com/store/${shop.replace(/\.myshopify\.com$/, '')}/apps/${config.shopify.apiKey}`);
});

/** GET /api/shopify/atelier — the address the product-page block shows and pre-fills. Public: it is the address on our parcels. */
export const getAtelierAddress = catchAsync(async (req, res) => {
  const a = await loadShipTo();
  res.set('Cache-Control', 'public, max-age=300');
  const v = shipToView(a);
  return ApiResponse.success(res, { name: v.name, company: v.company, address: v.address, address2: v.address2, city: v.city, phone: v.phone, country: v.country || atelierCountryName(a), countryCode: v.country_code || 'PK', state: v.state, provinceCode: v.province_code, zip: v.zip });
});

/**
 * POST /api/webhooks/shopify — Shopify's notifications. Mounted with the RAW body (see app.js): the signature is over the exact bytes.
 * The delivery is written down, Shopify gets its answer at once, and the work is done afterwards.
 */
export const shopifyWebhook = async (req, res) => {
  const raw = req.body;
  if (!Buffer.isBuffer(raw) || !verifyWebhookHmac(raw, req.get('x-shopify-hmac-sha256'))) return res.status(401).json({ received: false });
  let payload;
  try {
    payload = JSON.parse(raw.toString('utf8'));
  } catch {
    return res.status(400).json({ received: false });
  }
  const webhookId = req.get('x-shopify-webhook-id') || req.get('x-shopify-event-id') || `${req.get('x-shopify-topic')}:${req.get('x-shopify-shop-domain')}:${payload?.id ?? raw.length}:${req.get('x-shopify-triggered-at') ?? ''}`;
  try {
    const event = await recordWebhookEvent({ webhookId, topic: req.get('x-shopify-topic') || '', shop: req.get('x-shopify-shop-domain') || '', payload });
    res.status(200).json({ received: true });
    if (event) setImmediate(() => processWebhookEvent(event.id).catch((err) => console.warn('[Shopify] event failed:', err.message)));
  } catch (err) {
    console.error('[Shopify webhook] could not be recorded:', err.message);
    // not recorded: Shopify retries on any non-2xx
    return res.status(500).json({ received: false });
  }
  return undefined;
};

// ───────────── the customer ─────────────

/** POST /api/client/orders/:id/shopify/confirm-address — "yes, send it to your atelier". Only now is the brand's order address changed. */
export const confirmShopifyAddress = catchAsync(async (req, res) => {
  const { data: order } = await supabaseAdmin.from('orders').select('*').eq('id', req.params.id).eq('customer_id', req.userId).maybeSingle();
  if (!order) throw new NotFoundError('Order not found');
  if (order.external_source !== 'shopify') throw new ConflictError('This order does not come from a brand store.');
  const result = await confirmAtelierAddress({ order, actorId: req.userId });
  return ApiResponse.success(res, result, result.changed ? 'Thank you. The brand can now send your order to our atelier.' : 'Nothing to confirm.');
});

// ───────────── admin ─────────────

const publicStore = (s) => ({
  id: s.id,
  shop_domain: s.shop_domain,
  status: s.status,
  brand_id: s.brand_id,
  scopes: s.scopes,
  settings: s.settings || {},
  installed_at: s.installed_at,
  uninstalled_at: s.uninstalled_at,
  connected: s.status === 'active' && !!s.access_token_enc,
  install_url: shopifyConfigured() ? `${config.shopify.appUrl}/api/shopify/auth?shop=${encodeURIComponent(s.shop_domain)}` : null,
});

/** GET /api/admin/shopify/stores */
/** One-click links into the brand's Shopify admin for the theme / checkout setup of this app (Shopify's documented deep links). */
export const setupLinks = (shop) => {
  const key = config.shopify.apiKey;
  const handle = String(shop).replace(/\.myshopify\.com$/, '');
  const editor = `https://${shop}/admin/themes/current/editor`;
  return {
    cart_badges: `${editor}?context=apps&activateAppId=${key}/stitchship-cart-badges`,
    product_block: `${editor}?template=product&addAppBlockId=${key}/stitchship&target=mainSection`,
    cart_notice: `${editor}?template=cart&addAppBlockId=${key}/stitchship-cart-notice&target=mainSection`,
    checkout_editor: `https://admin.shopify.com/store/${handle}/settings/checkout/editor`,
  };
};

export const listShopifyStores = catchAsync(async (req, res) => {
  const { data, error } = await supabaseAdmin.from('shopify_stores').select('*, brand:brands!shopify_stores_brand_id_fkey(id, name)').order('created_at', { ascending: false });
  if (error) throw error;
  return ApiResponse.success(res, { configured: shopifyConfigured(), public_install_url: shopifyConfigured() ? `${config.shopify.appUrl}/api/shopify` : null, sms_configured: smsEnabled(), stores: (data || []).map((s) => ({ ...publicStore(s), setup_links: setupLinks(s.shop_domain), brand: Array.isArray(s.brand) ? s.brand[0] : s.brand })) });
});

/** POST /api/admin/shopify/stores  body: { shop, brand_id? } — register a store; the brand then installs the app with its link. */
export const addShopifyStore = catchAsync(async (req, res) => {
  const shop = normaliseShop(req.body?.shop);
  if (!shop) throw new BadRequestError('Enter the store address like my-brand.myshopify.com.');
  const { data, error } = await supabaseAdmin.from('shopify_stores').upsert({ shop_domain: shop, brand_id: req.body?.brand_id || null, updated_at: new Date().toISOString() }, { onConflict: 'shop_domain', ignoreDuplicates: false }).select('*').single();
  if (error) throw error;
  return ApiResponse.created(res, publicStore(data), 'Store added. Send its install link to the brand.');
});

/** The settings a person may change (an administrator, or the brand on its own Shopify page), checked and merged onto what is stored. */
export const mergeStoreSettings = (current, incoming) => {
  const names = Array.isArray(incoming.cod_gateway_names) ? incoming.cod_gateway_names.map((n) => String(n).trim().slice(0, 80)).filter(Boolean).slice(0, 10) : undefined;
  return {
    ...(current || {}),
    ...(names ? { cod_gateway_names: names } : {}),
    ...(incoming.brand_name ? { brand_name: String(incoming.brand_name).slice(0, 80) } : {}),
    ...(typeof incoming.sms_enabled === 'boolean' ? { sms_enabled: incoming.sms_enabled } : {}),
    // when an order is a Stitch&Ship order: 'customer' (default) = the customer ticked it on the product page AND the product's box is ticked; 'enabled' = the product's box alone
    ...(['enabled', 'customer'].includes(incoming.stitch_mode) ? { stitch_mode: incoming.stitch_mode } : {}),
  };
};

/** PATCH /api/admin/shopify/stores/:id  body: { brand_id?, settings? } */
export const updateShopifyStore = catchAsync(async (req, res) => {
  const patch = { updated_at: new Date().toISOString() };
  if (req.body?.brand_id !== undefined) patch.brand_id = req.body.brand_id || null;
  if (req.body?.settings && typeof req.body.settings === 'object') {
    const { data: current } = await supabaseAdmin.from('shopify_stores').select('settings').eq('id', req.params.id).maybeSingle();
    patch.settings = mergeStoreSettings(current?.settings, req.body.settings);
  }
  const { data, error } = await supabaseAdmin.from('shopify_stores').update(patch).eq('id', req.params.id).select('*').maybeSingle();
  if (error) throw error;
  if (!data) throw new NotFoundError('Store not found');
  return ApiResponse.success(res, publicStore(data), 'Store saved.');
});

/** POST /api/admin/shopify/stores/:id/webhooks — subscribe the store to the order notifications again (after a failed install step). */
export const reconnectShopifyWebhooks = catchAsync(async (req, res) => {
  const { data: store } = await supabaseAdmin.from('shopify_stores').select('*').eq('id', req.params.id).maybeSingle();
  if (!store) throw new NotFoundError('Store not found');
  if (store.status !== 'active' || !store.access_token_enc) throw new ConflictError('The store has not installed the app yet.');
  const status = await connectWebhooks(store);
  return ApiResponse.success(res, status, status.ok ? 'Webhooks connected.' : 'Some webhooks could not be connected.');
});

/** POST /api/admin/shopify/stores/:id/tick-box — create the "Stitch&Ship available" tick box on the store's products (again, after the brand approved the permission). */
export const createShopifyTickBox = catchAsync(async (req, res) => {
  const { data: store } = await supabaseAdmin.from('shopify_stores').select('*').eq('id', req.params.id).maybeSingle();
  if (!store) throw new NotFoundError('Store not found');
  if (store.status !== 'active' || !store.access_token_enc) throw new ConflictError('The store has not installed the app yet.');
  const status = await connectProductMetafield(store);
  await connectPaymentRule(store);
  await connectShipping(store);
  return ApiResponse.success(res, status, status.ok ? 'The tick box is ready on the products of the store.' : status.error);
});

/** POST /api/admin/shopify/stores/:id/shipping — create the "Ship to Stitch & Ship" method and switch on the payment and delivery rules (again, after the brand approved the new permissions). */
export const setupShopifyShipping = catchAsync(async (req, res) => {
  const { data: store } = await supabaseAdmin.from('shopify_stores').select('*').eq('id', req.params.id).maybeSingle();
  if (!store) throw new NotFoundError('Store not found');
  if (store.status !== 'active' || !store.access_token_enc) throw new ConflictError('The store has not installed the app yet.');
  await connectPaymentRule(store);
  const shipping = await connectShipping(store);
  const problem = !shipping.method.ok ? shipping.method.error : !shipping.rule.ok ? shipping.rule.error : null;
  return ApiResponse.success(res, { ok: !problem, error: problem, shipping }, problem || 'The shipping method is set up.');
});

/** GET /api/admin/shopify/queue — failed orders, held addresses, customers who were not emailed. */
export const getShopifyQueue = catchAsync(async (req, res) => ApiResponse.success(res, await shopifyQueue()));

export const retryShopifyOrderRequest = catchAsync(async (req, res) => {
  const result = await retryShopifyOrder(req.params.id);
  return ApiResponse.success(res, result, 'Tried again.');
});

export const resendShopifyEmailRequest = catchAsync(async (req, res) => {
  await resendCustomerEmail(req.params.id);
  return ApiResponse.success(res, null, 'Email sent.');
});

/** POST /api/admin/shopify/events/:id/retry — run a stuck delivery again right now. */
export const retryShopifyEvent = catchAsync(async (req, res) => ApiResponse.success(res, await processWebhookEvent(req.params.id), 'Tried again.'));

/** POST /api/admin/shopify/stores/:id/import { order: "#1015", force? } — bring an existing Shopify order into the app (no new Shopify order is made). */
export const importShopifyOrderRequest = catchAsync(async (req, res) => {
  const order = String(req.body?.order || '').trim();
  if (!order) throw new BadRequestError('Enter the Shopify order number.');
  return ApiResponse.success(res, await importShopifyOrder(req.params.id, order, { force: req.body?.force === true }), 'Imported.');
});
