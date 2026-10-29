import { supabaseAdmin } from '../config/supabase.js';
import { config } from '../config/env.js';
import { BadRequestError, ForbiddenError, NotFoundError } from '../utils/error.helper.js';
import { adminActionsOf } from '../config/admin-modules.js';
import { approvedBrands } from './shop.service.js';
import { pageMeta } from '../utils/pagination.js';

/**
 * Where a notification leads when it is tapped (an optional extra of a Notification Center message).
 *
 *   page     a screen of the app (Orders, Production, ...), optionally one record of it (one order)
 *   product  one product of the Shop (opened through the existing product page; the Shop itself stays hidden)
 *   url      an approved route of the app, or an https address of an approved website
 *
 * The destination is validated when the notification is created and again, for the person who taps it, by `resolveDestination`:
 * every route is chosen from the table below (never taken from the request), a record is re-read, and the person's own role and
 * module permissions decide. A notification never gives anybody access: the page and its API still apply their own rules.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_URL = 500;

/** profiles.role -> the app that person uses */
const ROLE_APP = { customer: 'client', admin: 'admin', partner_staff: 'partner' };

/**
 * The screens a notification may open. `client` = Client app route; `admin` = Admin app route + the admin module it belongs to;
 * `partner` = partner portal route + the partner permission it needs. Keep in step with the routes of the apps.
 * `entity: 'order'` pages open one order (client: /app/orders/:id, admin: the Orders page with that order open).
 */
export const PAGES = {
  overview: { label: 'Home / Overview', client: { path: '/app/overview' }, admin: { path: '/admin/overview', module: 'overview' }, partner: { path: '/partner/overview', permission: 'overview.view' } },
  orders: { label: 'Orders', client: { path: '/app/orders' }, admin: { path: '/admin/orders', module: 'orders' }, partner: { path: '/partner/orders', permission: 'overview.view' } },
  order: { label: 'One order (order details)', entity: 'order', client: { path: '/app/orders/:id' }, admin: { path: '/admin/orders', query: 'ref', module: 'orders' } },
  approvals: { label: 'Approvals', client: { path: '/app/approvals' } },
  inbox: { label: 'Inbox', client: { path: '/app/inbox' } },
  sizes: { label: 'My sizes', client: { path: '/app/sizes' } },
  profile: { label: 'Profile', client: { path: '/app/profile' } },
  messages: { label: 'Messages', admin: { path: '/admin/messages', module: 'messages' }, partner: { path: '/partner/messages', permission: 'messages.view' } },
  support: { label: 'Support chat', admin: { path: '/admin/support', module: 'support' } },
  invoices: { label: 'Invoices', admin: { path: '/admin/invoices', module: 'invoices' } },
  customers: { label: 'Customers', admin: { path: '/admin/customers', module: 'customers' } },
  partners: { label: 'Partners and teams', admin: { path: '/admin/partners', module: 'partners' } },
  reports: { label: 'Reports', admin: { path: '/admin/reports', module: 'reports' } },
  warehouse: { label: 'Warehouse', admin: { path: '/admin/warehouse', module: 'warehouse' }, partner: { path: '/partner/warehouse', permission: 'warehouse.view' } },
  production: { label: 'Production', partner: { path: '/partner/production', permission: 'production.view' } },
  quality: { label: 'Quality check', partner: { path: '/partner/quality-check', permission: 'quality.view' } },
  receiving: { label: 'Receiving', partner: { path: '/partner/receiving', permission: 'receiving.view' } },
  teams: { label: 'Teams', partner: { path: '/partner/teams', permission: 'teams.view' } },
  earnings: { label: 'Earnings', partner: { path: '/partner/earnings', permission: 'earnings.view' } },
  notifications: { label: 'Notification Center', admin: { path: '/admin/notification-center', module: 'notification_center' }, partner: { path: '/partner/notification-center', permission: 'notifications.view' } },
};

/** Which apps a notification category reaches (staff = partner staff and restricted admin users). */
const CATEGORY_APPS = { clients: ['client'], staff: ['admin', 'partner'], partners: ['partner'] };

/** The apps a sender reaches: a partner's own staff only ever use the partner portal. */
const appsFor = (category, sender) => (sender === 'partner' ? ['partner'] : CATEGORY_APPS[category]);

const pageAllowedFor = (key, category, sender) => appsFor(category, sender).some((app) => !!PAGES[key]?.[app]);

/** The pages the form offers for a category, from the table above. */
export const pageOptions = (category, sender = 'admin') =>
  Object.entries(PAGES)
    .filter(([key]) => pageAllowedFor(key, category, sender))
    // an order can only be linked for clients: each client sees only their own orders
    .filter(([, p]) => !p.entity || category === 'clients')
    .map(([key, p]) => ({ key, label: p.label, entity: p.entity || null }));

// ───────────────────────────── URL checks ─────────────────────────────

const hostOf = (url) => { try { return new URL(url).hostname.toLowerCase(); } catch { return ''; } };

/** Websites a notification may open outside the app: the platform's own sites and NOTIFICATION_ALLOWED_HOSTS (comma separated). */
const allowedExternalHosts = () =>
  new Set(
    String(process.env.NOTIFICATION_ALLOWED_HOSTS || '')
      .split(',')
      .map((h) => h.trim().toLowerCase())
      .filter(Boolean),
  );

const ownHosts = () => new Set([hostOf(config.urls.clientApp), hostOf(config.urls.adminApp)].filter(Boolean));

/** A query key that looks like it carries a login or a secret: such an address is never stored or opened. */
const SECRET_PARAM = /^(access_?token|refresh_?token|id_?token|token|auth|authorization|api_?key|key|secret|password|session|jwt|code)$/i;

/** The static routes of every page (used to approve a typed route). */
const staticRoutes = () => {
  const out = new Map();
  for (const [key, p] of Object.entries(PAGES)) {
    for (const app of ['client', 'admin', 'partner']) if (p[app] && !p.entity) out.set(p[app].path, { key, app });
  }
  return out;
};

/**
 * A typed address, checked. Returns { kind: 'internal', path, ... } | { kind: 'external', url }.
 * Rejected: other schemes (javascript:, data:, ...), addresses with a login in them, secrets in the query, and any
 * outside website that is not on the approved list.
 */
export const parseUrl = (raw) => {
  const text = String(raw ?? '').trim();
  if (!text) throw new BadRequestError('Enter the address to open.');
  if (text.length > MAX_URL) throw new BadRequestError('The address is too long.');
  // eslint-disable-next-line no-control-regex
  if (/[\s\u0000-\u001f\\]/.test(text)) throw new BadRequestError('The address must not contain spaces or special characters.');

  let url;
  if (text.startsWith('/') && !text.startsWith('//')) {
    url = new URL(text, 'https://app.invalid');
    url.__internal = true;
  } else {
    if (/^[a-z][a-z0-9+.-]*:/i.test(text) && !/^https?:\/\//i.test(text)) throw new BadRequestError('Only https:// addresses and routes of the app are allowed.');
    try { url = new URL(text); } catch { throw new BadRequestError('This is not a valid address.'); }
    if (url.protocol !== 'https:') throw new BadRequestError('Only https:// addresses are allowed.');
    if (url.username || url.password) throw new BadRequestError('The address must not contain a user name or password.');
  }
  for (const key of url.searchParams.keys()) {
    if (SECRET_PARAM.test(key)) throw new BadRequestError('The address must not carry a token or secret.');
  }
  if (/(^|[?&#])(access_?token|id_?token|refresh_?token)=/i.test(url.hash.slice(1))) throw new BadRequestError('The address must not carry a token or secret.');

  if (url.__internal || ownHosts().has(url.hostname.toLowerCase())) {
    return { kind: 'internal', path: url.pathname.replace(/\/+$/, '') || '/', hasQuery: !!url.search };
  }
  if (!allowedExternalHosts().has(url.hostname.toLowerCase())) {
    throw new BadRequestError('This website is not on the list of approved destinations. Ask the platform owner to approve it, or link a page of the app instead.');
  }
  url.hash = '';
  return { kind: 'external', url: url.toString() };
};

// ───────────────────────────── products ─────────────────────────────

/** A product the Shop may show right now (sellable, not hidden, brand approved): the same rules as the Shop's own product page. */
const loadShowableProduct = async (id) => {
  if (!UUID.test(String(id))) throw new BadRequestError('Choose a product.');
  const brands = await approvedBrands();
  const { data: p } = await supabaseAdmin.from('shop_products').select('id, title, store_id, sellable, hidden, image_url').eq('id', id).maybeSingle();
  if (!p || !p.sellable || p.hidden || !brands.has(p.store_id)) throw new NotFoundError('This product is not available.');
  return p;
};

/**
 * A product from its id, or from an address: the app's own product route, or the brand's storefront address
 * (https://<store>.myshopify.com/products/<handle>), found through the store it belongs to.
 */
const productFrom = async (input) => {
  const given = String(input.product_id || '').trim();
  if (given) return loadShowableProduct(given);
  const text = String(input.url || '').trim();
  if (!text) throw new BadRequestError('Choose a product or enter its address.');
  const own = text.match(/^(?:https:\/\/[^/]+)?\/app\/shop\/product\/([0-9a-f-]{36})\/?$/i);
  if (own) return loadShowableProduct(own[1]);
  const parsed = parseStoreProductUrl(text);
  if (!parsed) throw new BadRequestError('This is not a product address of a connected brand. Choose the product from the list instead.');
  const { data: store } = await supabaseAdmin.from('shopify_stores').select('id').eq('shop_domain', parsed.host).maybeSingle();
  if (!store) throw new NotFoundError('This product is not available.');
  const { data: p } = await supabaseAdmin.from('shop_products').select('id').eq('store_id', store.id).eq('handle', parsed.handle).maybeSingle();
  if (!p) throw new NotFoundError('This product is not available.');
  return loadShowableProduct(p.id);
};

const parseStoreProductUrl = (text) => {
  let url;
  try { url = new URL(text); } catch { return null; }
  if (url.protocol !== 'https:' || url.username || url.password) return null;
  const m = url.pathname.match(/^\/products\/([a-z0-9][a-z0-9_-]*)\/?$/i);
  return m ? { host: url.hostname.toLowerCase(), handle: m[1].toLowerCase() } : null;
};

// ───────────────────────────── creating ─────────────────────────────

const productDestination = (p) => ({ type: 'product', product_id: p.id, store_id: p.store_id, label: p.title, ...(p.image_url ? { image_url: p.image_url } : {}) });

/**
 * The product's own picture, made ready to travel in a push: https only, and a brand's Shopify picture is asked for at a phone-sized
 * width (a push picture must stay small: the phone downloads it before showing the notification). '' = no usable picture.
 */
export const productPicture = (value) => {
  try {
    const url = new URL(String(value || ''));
    if (url.protocol !== 'https:' || url.username || url.password) return '';
    if (/(^|\.)cdn\.shopify\.com$/i.test(url.hostname) && !url.searchParams.has('width')) url.searchParams.set('width', '800');
    return url.toString();
  } catch {
    return '';
  }
};

const loadOrder = async (id) => {
  if (!UUID.test(String(id))) throw new BadRequestError('Choose an order.');
  const { data } = await supabaseAdmin.from('orders').select('id, reference, customer_id').eq('id', id).maybeSingle();
  if (!data) throw new NotFoundError('This order does not exist.');
  return data;
};

/**
 * The destination the sender asked for, validated and cleaned; null = no destination (the notification behaves as before).
 * `audience` is the already cleaned audience: an order link is only possible for the one client who owns the order.
 */
export const cleanDestination = async (raw, audience, sender = 'admin') => {
  if (raw === undefined || raw === null || raw === '' || raw.type === 'none') return null;
  if (typeof raw !== 'object') throw new BadRequestError('The destination is not valid.');
  const category = audience.category;

  if (raw.type === 'page') {
    const key = String(raw.page || '');
    const page = PAGES[key];
    if (!page || !pageAllowedFor(key, category, sender)) throw new BadRequestError('This page cannot be opened from a notification to this audience.');
    if (!page.entity) return { type: 'page', page: key, label: page.label };
    if (category !== 'clients') throw new BadRequestError('An order can only be linked for a client.');
    const order = await loadOrder(raw.entity_id);
    if (audience.mode !== 'selected' || audience.ids.length !== 1 || audience.ids[0] !== order.customer_id) {
      throw new BadRequestError('An order can only be linked in a notification to the one client who owns it.');
    }
    return { type: 'page', page: key, entity_type: 'order', entity_id: order.id, entity_ref: order.reference, label: `Order ${order.reference}` };
  }

  if (raw.type === 'product') {
    if (category !== 'clients') throw new BadRequestError('A product can only be linked in a notification to clients.');
    return productDestination(await productFrom(raw));
  }

  if (raw.type === 'url') {
    const parsed = parseUrl(raw.url);
    if (parsed.kind === 'external') return { type: 'url', url: parsed.url, external: true, label: hostOf(parsed.url) };
    if (parsed.hasQuery) throw new BadRequestError('Link a page of the app without extra parameters, or choose it from the page list.');
    const product = parsed.path.match(/^\/app\/shop\/product\/([0-9a-f-]{36})$/i);
    if (product) {
      if (category !== 'clients') throw new BadRequestError('A product can only be linked in a notification to clients.');
      return productDestination(await loadShowableProduct(product[1]));
    }
    const found = staticRoutes().get(parsed.path);
    if (!found || !appsFor(category, sender).includes(found.app)) throw new BadRequestError('This route is not an approved page for this audience.');
    return { type: 'url', url: parsed.path, external: false, page: found.key, label: PAGES[found.key].label };
  }
  throw new BadRequestError('Choose where the notification should open.');
};

// ───────────────────────────── resolving for one person ─────────────────────────────

const pathOf = (target, entity) => {
  const base = target.path.replace(':id', entity?.id || '');
  return target.query && entity?.ref ? `${base}?${target.query}=${encodeURIComponent(entity.ref)}` : base;
};

/**
 * The route (or outside address) of a destination for a person with this role, or null when that app has no such page.
 * Pure: no permission or record check (see resolveDestination).
 * @returns {{ link: string | null, external_url: string | null }}
 */
export const linkFor = (destination, role) => {
  const app = ROLE_APP[role];
  const none = { link: null, external_url: null };
  if (!destination || !app) return none;
  if (destination.type === 'product') return app === 'client' ? { link: `/app/shop/product/${destination.product_id}`, external_url: null } : none;
  if (destination.type === 'url') {
    if (destination.external) return { link: null, external_url: destination.url };
    const hit = staticRoutes().get(destination.url);
    return hit && hit.app === app ? { link: destination.url, external_url: null } : none;
  }
  const target = PAGES[destination.page]?.[app];
  if (!target) return none;
  return { link: pathOf(target, { id: destination.entity_id, ref: destination.entity_ref }), external_url: null };
};

/** The permission a person needs for the page behind a destination, per app (null = anyone signed in to that app). */
const pageOfDestination = (destination) => {
  if (destination.type === 'page') return PAGES[destination.page];
  if (destination.type === 'url' && !destination.external) return PAGES[destination.page];
  return null;
};

const mayOpenPage = (page, app, { profile, access }) => {
  if (!page || !page[app]) return false;
  if (app === 'admin') {
    const modules = adminActionsOf(profile); // null = a full admin
    const needed = page.admin.module;
    return modules === null || !needed || (modules.has(needed) && modules.get(needed).has('view'));
  }
  if (app === 'partner') {
    const needed = page.partner.permission;
    return !needed || !!access?.isAdmin || !!access?.permissions?.has(needed);
  }
  return true;
};

/**
 * What happens when THIS person taps THIS notification: checked now, with their current role and permissions, and the record read
 * again (it may have been deleted since). Throws a message the app shows as it is.
 * @returns {Promise<{ kind: 'none' } | { kind: 'internal', link: string } | { kind: 'external', url: string }>}
 */
export const resolveDestination = async (viewer, notification) => {
  const destination = notification.destination;
  if (!destination) return { kind: 'none' };
  const role = viewer.profile?.role;
  const app = ROLE_APP[role];
  const { link, external_url: externalUrl } = linkFor(destination, role);

  if (externalUrl) {
    // an address approved at creation can lose its approval later
    if (!allowedExternalHosts().has(hostOf(externalUrl)) && !ownHosts().has(hostOf(externalUrl))) throw new ForbiddenError('This link is no longer on the approved list.');
    return { kind: 'external', url: externalUrl };
  }
  if (!link) throw new ForbiddenError('This link is not available for your account.');

  if (destination.type === 'product') {
    try { await loadShowableProduct(destination.product_id); } catch { throw new NotFoundError('This product is no longer available.'); }
    return { kind: 'internal', link };
  }

  const page = pageOfDestination(destination);
  if (!mayOpenPage(page, app, viewer)) throw new ForbiddenError('You do not have permission to access this page.');

  if (destination.entity_type === 'order') {
    const { data: order } = await supabaseAdmin.from('orders').select('id, customer_id').eq('id', destination.entity_id).maybeSingle();
    if (!order) throw new NotFoundError('This order no longer exists.');
    // a customer only ever opens their own order; an admin needs the Orders module (checked above)
    if (app === 'client' && order.customer_id !== viewer.userId) throw new ForbiddenError('You do not have access to this order.');
  }
  return { kind: 'internal', link };
};

// ───────────────────────────── pickers for the form ─────────────────────────────

const LIKE = (v) => String(v || '').replace(/[,()*%\:"']/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60);

/** The brands whose products a client could be sent (connected and approved to sell): the filter of the product picker. */
export const searchProductBrands = async () => {
  const brands = await approvedBrands();
  return [...brands.values()].map((b) => ({ id: b.id, name: b.name })).sort((a, b) => a.name.localeCompare(b.name));
};

/**
 * Products a client could be sent, one page at a time (infinite scroll in the form), optionally of one brand: only what the Shop
 * may show (never hidden or unapproved ones), with the brand each belongs to.
 */
export const searchProducts = async (query) => {
  const search = LIKE(query.search);
  const page = Math.max(1, parseInt(query.page, 10) || 1);
  const limit = Math.min(30, Math.max(1, parseInt(query.limit, 10) || 12));
  const brands = await approvedBrands();
  const brand = String(query.brand || '');
  const storeIds = [...brands.keys()].filter((id) => !brand || id === brand);
  if (!storeIds.length) return { items: [], meta: pageMeta({ page, limit }, 0) };
  let q = supabaseAdmin
    .from('shop_products')
    .select('id, title, image_url, store_id', { count: 'exact' })
    .in('store_id', storeIds)
    .eq('sellable', true)
    .eq('hidden', false)
    .order('title')
    .order('id')
    .range((page - 1) * limit, page * limit - 1);
  if (search) q = q.ilike('title', `%${search}%`);
  const { data, count, error } = await q;
  if (error) throw error;
  return {
    items: (data || []).map((p) => ({ id: p.id, title: p.title, image_url: p.image_url, store_id: p.store_id, brand: brands.get(p.store_id)?.name || '' })),
    meta: pageMeta({ page, limit }, count),
  };
};

/** The orders of ONE client (the one the notification goes to), for the order picker. */
export const searchClientOrders = async (query) => {
  const clientId = String(query.client_id || '');
  if (!UUID.test(clientId)) throw new BadRequestError('Choose the client first.');
  const search = LIKE(query.search);
  let q = supabaseAdmin.from('orders').select('id, reference, status, brand, created_at').eq('customer_id', clientId).order('created_at', { ascending: false }).limit(20);
  if (search) q = q.ilike('reference', `%${search}%`);
  const { data, error } = await q;
  if (error) throw error;
  return data || [];
};
