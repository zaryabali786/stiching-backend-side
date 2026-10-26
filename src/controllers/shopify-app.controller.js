import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { supabaseAdmin } from '../config/supabase.js';
import { config } from '../config/env.js';
import { catchAsync, ApiResponse, BadRequestError, ConflictError } from '../utils/error.helper.js';
import { connectPaymentRule, connectProductMetafield, connectShipping, connectWebhooks, getActiveStore, normaliseShop, shopifyConfigured } from '../services/shopify.service.js';
import { APP_VERSION, CHANGELOG, orderNeedsAttention, orderStatus, permissionStatus, shopFromSessionToken, storePlan } from '../services/shopify-embedded.service.js';
import { mergeStoreSettings, setupLinks } from './shopify.controller.js';
import { smsEnabled } from '../services/sms.service.js';

/**
 * The Stitch&Ship page inside the brand's Shopify admin (Apps -> Stitch&Ship).
 *  - the page itself (a small HTML shell + app.js, no build step) is served to the iframe Shopify opens;
 *  - the page then calls /api/shopify/embedded/* with the session token Shopify gives it. No cookies, no login.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
export const APP_ASSETS_DIR = path.resolve(here, '../public/shopify-app');

let shell = null;
const loadShell = () => {
  if (!shell) shell = fs.readFileSync(path.join(APP_ASSETS_DIR, 'app.html'), 'utf8');
  return shell;
};

const escapeHtml = (v) => String(v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/** Shopify opens this URL inside the brand's admin. A store that has not installed yet is sent to the install, at the TOP of the window (Shopify refuses to show its approval screen in an iframe). */
export const serveApp = catchAsync(async (req, res) => {
  if (!shopifyConfigured()) throw new BadRequestError('The Shopify connection is not set up on the server yet.');
  const shop = normaliseShop(req.query.shop);
  if (shop) {
    const store = await getActiveStore(shop);
    if (!store) {
      const url = `${config.shopify.appUrl}/api/shopify/auth?shop=${encodeURIComponent(shop)}`;
      return res.status(200).type('html').send(`<!doctype html><meta charset="utf-8"><title>Stitch&amp;Ship</title><script>window.top.location.href=${JSON.stringify(url)};</script><p>Opening the Stitch&amp;Ship install…</p>`);
    }
  }
  // only this shop's admin (and Shopify's admin) may put the page in a frame
  res.set('Content-Security-Policy', `frame-ancestors https://admin.shopify.com ${shop ? `https://${shop}` : 'https://*.myshopify.com'}`);
  res.set('Cache-Control', 'no-store');
  return res.status(200).type('html').send(loadShell().replaceAll('%%API_KEY%%', escapeHtml(config.shopify.apiKey)).replaceAll('%%APP_VERSION%%', APP_VERSION));
});

// ───────────── the page's data calls ─────────────

/** Authorization: Bearer <session token>. Puts the store on req.shopifyStore. */
export const requireShopifySession = async (req, res, next) => {
  try {
    const token = String(req.get('authorization') || '').replace(/^Bearer\s+/i, '');
    const shop = await shopFromSessionToken(token);
    const store = shop ? await getActiveStore(shop) : null;
    if (!store) {
      // this header makes Shopify's App Bridge fetch a fresh token and try once more
      res.set('X-Shopify-Retry-Invalid-Session-Request', '1');
      return res.status(401).json({ success: false, statusCode: 401, message: 'Please reopen the app from your Shopify admin.' });
    }
    req.shopifyStore = store;
    return next();
  } catch (err) {
    return next(err);
  }
};

const STEPS = [
  { key: 'notifications', title: 'Order notifications', text: 'Shopify tells us when a Stitch&Ship order is placed.', auto: true },
  { key: 'tick_box', title: 'Product tick box', text: 'Adds "Stitch&Ship available" to every product so you choose what can be stitched.', auto: true },
  { key: 'shipping', title: 'Shipping method', text: 'Adds "Ship to Stitch & Ship" so these orders are sent to our atelier.', auto: true },
  { key: 'cart_badges', title: 'Turn on cart badges', text: 'Shows a small Stitch&Ship badge on stitching items in the cart.', link: 'cart_badges' },
  { key: 'product_block', title: 'Add the tick box to your product page', text: 'Lets the customer choose "Customise stitching with Stitch&Ship" on a product.', link: 'product_block' },
  { key: 'cart_notice', title: 'Cart page notice', text: 'Optional. A short note in the cart explaining the stitching option.', link: 'cart_notice', optional: true },
  { key: 'checkout_editor', title: 'Checkout badge below each product', text: 'Shows the Stitch&Ship badge at checkout. Needs Shopify Plus.', link: 'checkout_editor', plusOnly: true, optional: true },
];

const autoDone = (settings) => ({
  notifications: !!settings.webhooks?.ok,
  tick_box: !!settings.tick_box?.ok,
  shipping: !!settings.shipping?.method?.ok,
});

const autoError = (settings) => ({
  notifications: settings.webhooks?.ok ? null : settings.webhooks?.failed?.[0] || null,
  tick_box: settings.tick_box?.ok ? null : settings.tick_box?.error || null,
  shipping: settings.shipping?.method?.ok ? null : settings.shipping?.method?.error || null,
});

const buildState = async (store) => {
  const settings = store.settings || {};
  const [plan, orders] = await Promise.all([
    storePlan(store),
    supabaseAdmin.from('shopify_orders').select('state, address_state, hold_state, notified_at').eq('store_id', store.id).limit(500),
  ]);
  const rows = orders.data || [];
  const done = autoDone(settings);
  const errors = autoError(settings);
  const acked = settings.setup_done || {};
  const links = setupLinks(store.shop_domain);
  const isPlus = plan ? plan.plus || plan.development : null;
  const steps = STEPS.map((s) => {
    const locked = !!s.plusOnly && isPlus === false;
    return {
      key: s.key,
      title: s.title,
      text: s.text,
      kind: s.auto ? 'auto' : 'manual',
      optional: !!s.optional,
      locked,
      done: s.auto ? done[s.key] : !!acked[s.key],
      error: s.auto ? errors[s.key] : null,
      url: s.link && !locked ? links[s.link] : null,
    };
  });
  const countable = steps.filter((s) => !s.locked && !s.optional);
  const permissions = permissionStatus(store.scopes);
  return {
    shop: store.shop_domain,
    shop_name: plan?.shop_name || settings.brand_name || store.shop_domain,
    plan: plan ? { name: plan.name, plus: !!plan.plus, development: !!plan.development } : null,
    installed_at: store.installed_at,
    version: APP_VERSION,
    steps,
    progress: { done: countable.filter((s) => s.done).length + 1, total: countable.length + 1 },
    permissions,
    reauthorize_url: `${config.shopify.appUrl}/api/shopify/auth?shop=${encodeURIComponent(store.shop_domain)}`,
    settings: {
      sms_enabled: settings.sms_enabled === true,
      sms_available: smsEnabled(),
      cod_gateway_names: settings.cod_gateway_names || [],
      stitch_mode: settings.stitch_mode || 'customer',
    },
    counts: {
      orders: rows.length,
      waiting_for_sizes: rows.filter((r) => orderStatus(r).tone === 'info').length,
      attention: rows.filter(orderNeedsAttention).length,
    },
    changelog: CHANGELOG,
  };
};

/** GET /api/shopify/embedded/state */
export const getAppState = catchAsync(async (req, res) => ApiResponse.success(res, await buildState(req.shopifyStore)));

/** PUT /api/shopify/embedded/settings  body: { sms_enabled?, cod_gateway_names?, stitch_mode? } */
export const saveAppSettings = catchAsync(async (req, res) => {
  const store = req.shopifyStore;
  const body = req.body || {};
  // the page may change these three only; nothing else in the stored settings is theirs to write
  const incoming = {};
  if (typeof body.sms_enabled === 'boolean') incoming.sms_enabled = body.sms_enabled && smsEnabled();
  if (Array.isArray(body.cod_gateway_names)) incoming.cod_gateway_names = body.cod_gateway_names;
  if (body.stitch_mode !== undefined) incoming.stitch_mode = body.stitch_mode;
  const settings = mergeStoreSettings(store.settings, incoming);
  const { error } = await supabaseAdmin.from('shopify_stores').update({ settings, updated_at: new Date().toISOString() }).eq('id', store.id);
  if (error) throw error;
  return ApiResponse.success(res, await buildState({ ...store, settings }), 'Saved.');
});

const SETUP_ACTIONS = {
  notifications: async (store) => {
    const r = await connectWebhooks(store);
    return { ok: r.ok, error: r.failed?.[0] || null };
  },
  tick_box: async (store) => {
    const r = await connectProductMetafield(store);
    await connectPaymentRule(store);
    return { ok: r.ok, error: r.error };
  },
  shipping: async (store) => {
    await connectPaymentRule(store);
    const r = await connectShipping(store);
    const problem = !r.method.ok ? r.method.error : !r.rule.ok ? r.rule.error : null;
    return { ok: !problem, error: problem };
  },
};

/** POST /api/shopify/embedded/setup/:step  — run an automatic step again (after the brand approved a new permission). */
export const runSetupStep = catchAsync(async (req, res) => {
  const action = SETUP_ACTIONS[req.params.step];
  if (!action) throw new BadRequestError('Unknown setup step.');
  const result = await action(req.shopifyStore);
  const fresh = await getActiveStore(req.shopifyStore.shop_domain);
  return ApiResponse.success(res, { ...result, state: await buildState(fresh) }, result.ok ? 'Done.' : result.error || 'This step could not be completed.');
});

/** PUT /api/shopify/embedded/setup/:step/done  body: { done } — the brand ticks off a step that happens in the Shopify theme editor. */
export const markSetupStep = catchAsync(async (req, res) => {
  const step = STEPS.find((s) => s.key === req.params.step && !s.auto);
  if (!step) throw new ConflictError('This step is done by the app itself.');
  const store = req.shopifyStore;
  const settings = { ...(store.settings || {}), setup_done: { ...(store.settings?.setup_done || {}), [step.key]: req.body?.done !== false } };
  const { error } = await supabaseAdmin.from('shopify_stores').update({ settings, updated_at: new Date().toISOString() }).eq('id', store.id);
  if (error) throw error;
  return ApiResponse.success(res, await buildState({ ...store, settings }));
});

/** GET /api/shopify/embedded/orders — this store's Stitch&Ship orders, newest first. */
export const listAppOrders = catchAsync(async (req, res) => {
  const { data, error } = await supabaseAdmin
    .from('shopify_orders')
    .select('id, shopify_order_name, shopify_order_id, customer_email, state, address_state, hold_state, notified_at, created_at')
    .eq('store_id', req.shopifyStore.id)
    .order('created_at', { ascending: false })
    .limit(100);
  if (error) throw error;
  return ApiResponse.success(res, (data || []).map((r) => ({ id: r.id, name: r.shopify_order_name || r.shopify_order_id, customer_email: r.customer_email, created_at: r.created_at, status: orderStatus(r), needs_attention: orderNeedsAttention(r) })));
});
