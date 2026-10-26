import { jwtVerify } from 'jose';
import { config } from '../config/env.js';
import { normaliseShop, shopifyGraphql } from './shopify.service.js';

/**
 * The Stitch&Ship page the brand sees INSIDE its Shopify admin (Apps -> Stitch&Ship). Shopify gives that page a short-lived "session token"
 * (a JWT signed with the app's secret); every call the page makes to this server carries it, and it is the only thing that says which store is asking.
 */

/** The shop (<name>.myshopify.com) a valid session token was issued for, or null. Wrong signature, wrong app, expired = null. */
export const shopFromSessionToken = async (token, now = new Date()) => {
  if (!token || !config.shopify.apiSecret || !config.shopify.apiKey) return null;
  try {
    const { payload } = await jwtVerify(String(token), new TextEncoder().encode(config.shopify.apiSecret), {
      algorithms: ['HS256'],
      audience: config.shopify.apiKey,
      clockTolerance: 10,
      currentDate: now,
    });
    const dest = normaliseShop(payload.dest);
    const iss = normaliseShop(payload.iss);
    return dest && iss === dest ? dest : null;
  } catch {
    return null;
  }
};

// ───────────── permissions, in the brand's words ─────────────

export const PERMISSION_GROUPS = [
  { key: 'orders', title: 'Orders', why: 'Receive your Stitch&Ship orders and tag them in Shopify.', scopes: ['read_orders', 'write_orders'] },
  { key: 'customers', title: 'Customer email', why: 'Match an order to its customer so we can send the "add your sizes" link.', scopes: ['read_customers'] },
  { key: 'products', title: 'Products', why: 'Show product pictures and add the "Stitch&Ship available" tick box to your products.', scopes: ['read_products', 'write_products'] },
  { key: 'fulfilment', title: 'Shipping holds', why: 'Pause shipping until the customer has confirmed the address.', scopes: ['read_merchant_managed_fulfillment_orders', 'write_merchant_managed_fulfillment_orders'] },
  { key: 'payments', title: 'Payment rule', why: 'Show online payment only (no cash on delivery or bank transfer) on Stitch&Ship orders.', scopes: ['write_payment_customizations'] },
  { key: 'shipping', title: 'Shipping method', why: 'Add the "Ship to Stitch & Ship" method and show only that method on Stitch&Ship orders.', scopes: ['write_shipping', 'write_delivery_customizations', 'write_markets'] },
];

/** Shopify may leave out a read scope when the write scope of the same thing is granted (write implies read). */
const has = (granted, scope) => granted.has(scope) || (scope.startsWith('read_') && granted.has(`write_${scope.slice(5)}`));

/** The permissions the app asks for, which are granted, and which the brand still has to approve. */
export const permissionStatus = (grantedScopes) => {
  const granted = new Set(String(grantedScopes || '').split(',').map((s) => s.trim()).filter(Boolean));
  const required = config.shopify.scopes.split(',').map((s) => s.trim()).filter(Boolean);
  const missing = required.filter((s) => !has(granted, s));
  const groups = PERMISSION_GROUPS.map((g) => ({ key: g.key, title: g.title, why: g.why, granted: g.scopes.every((s) => has(granted, s)) }));
  return { groups, missing, up_to_date: missing.length === 0 };
};

// ───────────── what's new ─────────────

export const APP_VERSION = '1.1.0';

/** Newest first. A new entry here shows as a banner on the Home page until the brand closes it, and stays on the "What's new" page. */
export const CHANGELOG = [
  { id: '2026-10-embedded-app', date: '2026-10-26', tag: 'New', title: 'Stitch&Ship now lives inside your Shopify admin', body: 'Open Apps → Stitch&Ship to see your setup guide, your permissions, your settings and your Stitch&Ship orders in one place.' },
  { id: '2026-10-shipping-method', date: '2026-10-23', tag: 'Improved', title: 'The "Ship to Stitch & Ship" shipping method is added for you', body: 'The app creates the method and shows only that method on Stitch&Ship orders, so customers cannot pick the wrong delivery.' },
  { id: '2026-10-tick-box', date: '2026-10-20', tag: 'Improved', title: '"Stitch&Ship available" tick box on every product', body: 'Choose which products can be stitched. The product page block only shows on ticked products.' },
];

// ───────────── the store's plan ─────────────

const planCache = new Map();
const PLAN_TTL_MS = 60 * 60 * 1000;

/** { name, plus } of the store, or null when Shopify cannot be asked right now. Cached for an hour. */
export const storePlan = async (store) => {
  const hit = planCache.get(store.shop_domain);
  if (hit && Date.now() - hit.at < PLAN_TTL_MS) return hit.plan;
  try {
    const data = await shopifyGraphql(store, '{ shop { name plan { displayName shopifyPlus partnerDevelopment } } }');
    const p = data?.shop?.plan;
    const plan = { shop_name: data?.shop?.name || null, name: p?.displayName || null, plus: !!p?.shopifyPlus, development: !!p?.partnerDevelopment };
    planCache.set(store.shop_domain, { at: Date.now(), plan });
    return plan;
  } catch {
    return null;
  }
};

// ───────────── an order, in the brand's words ─────────────

/** { label, tone } shown on the Orders page. Tones: success | warning | critical | neutral | info. */
export const orderStatus = (r) => {
  if (r.state === 'cancelled') return { label: 'Cancelled', tone: 'neutral' };
  if (r.state === 'failed') return { label: 'We could not take this order in', tone: 'critical' };
  if (r.state?.startsWith('split')) return { label: 'Check in Shopify', tone: 'neutral' };
  if (r.address_state === 'address_mismatch' && r.hold_state === 'held') return { label: 'On hold: waiting for the customer to confirm the address', tone: 'warning' };
  if (r.hold_state === 'failed') return { label: 'Check the shipment in Shopify', tone: 'critical' };
  if (r.state === 'draft_created' && !r.notified_at) return { label: 'Customer not emailed yet', tone: 'warning' };
  if (r.state === 'draft_created') return { label: 'Waiting for the customer\'s sizes', tone: 'info' };
  return { label: 'Received', tone: 'success' };
};

export const orderNeedsAttention = (r) => ['critical', 'warning'].includes(orderStatus(r).tone);
