/**
 * Where a notification leads: validating the destination when it is created, turning it into the right route for each kind of
 * person, and re-checking it (permissions, the record, the product) for the person who taps it. No real database: a small
 * in-memory one stands in for Supabase.
 */
import { test, mock, before } from 'node:test';
import assert from 'node:assert/strict';

const U = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const CLIENT = U(1);
const OTHER_CLIENT = U(2);
const ORDER = U(10);
const OTHER_ORDER = U(11);
const STORE = U(20);
const PRODUCT = U(30);
const HIDDEN_PRODUCT = U(31);

const tables = {
  orders: [
    { id: ORDER, reference: 'SA-1001', customer_id: CLIENT },
    { id: OTHER_ORDER, reference: 'SA-1002', customer_id: OTHER_CLIENT },
  ],
  shop_products: [
    { id: PRODUCT, title: 'Linen shirt', store_id: STORE, sellable: true, hidden: false, handle: 'linen-shirt' },
    { id: HIDDEN_PRODUCT, title: 'Secret', store_id: STORE, sellable: true, hidden: true, handle: 'secret' },
  ],
  shopify_stores: [{ id: STORE, shop_domain: 'brand.myshopify.com' }],
};

const db = {
  from(name) {
    const filters = [];
    const q = {
      select: () => q,
      eq: (k, v) => { filters.push([k, v]); return q; },
      maybeSingle: async () => ({ data: (tables[name] || []).find((r) => filters.every(([k, v]) => r[k] === v)) || null }),
    };
    return q;
  },
};

let svc;
before(async () => {
  mock.module('../src/config/supabase.js', { namedExports: { supabaseAdmin: db, supabase: db } });
  mock.module('../src/services/shop.service.js', { namedExports: { approvedBrands: async () => new Map([[STORE, { id: STORE, name: 'Brand' }]]) } });
  process.env.NOTIFICATION_ALLOWED_HOSTS = 'docs.example.com';
  svc = await import('../src/services/notification-destination.service.js');
});

const toClient = { category: 'clients', mode: 'selected', ids: [CLIENT] };
const toAllClients = { category: 'clients', mode: 'all', ids: [] };
const toStaff = { category: 'staff', mode: 'all', ids: [] };

const rejects = (promise, message) => assert.rejects(promise, (err) => (message ? message.test(err.message) : true));

// ───────────── creating ─────────────

test('no destination (or "none") leaves the notification exactly as it was', async () => {
  assert.equal(await svc.cleanDestination(undefined, toClient), null);
  assert.equal(await svc.cleanDestination({ type: 'none' }, toClient), null);
});

test('a page of the app is stored from the page table, never from a typed route', async () => {
  const d = await svc.cleanDestination({ type: 'page', page: 'orders', route: '/evil' }, toAllClients);
  assert.deepEqual(d, { type: 'page', page: 'orders', label: 'Orders' });
  await rejects(svc.cleanDestination({ type: 'page', page: 'nope' }, toAllClients), /cannot be opened/);
  // a staff-only page cannot be sent to clients, a client page cannot be sent to staff
  await rejects(svc.cleanDestination({ type: 'page', page: 'customers' }, toAllClients), /cannot be opened/);
  await rejects(svc.cleanDestination({ type: 'page', page: 'approvals' }, toStaff), /cannot be opened/);
});

test('a partner sender only reaches the partner portal pages', async () => {
  const d = await svc.cleanDestination({ type: 'page', page: 'production' }, toStaff, 'partner');
  assert.equal(d.page, 'production');
  await rejects(svc.cleanDestination({ type: 'page', page: 'customers' }, toStaff, 'partner'), /cannot be opened/);
});

test('one order can only be linked for the client who owns it', async () => {
  const d = await svc.cleanDestination({ type: 'page', page: 'order', entity_id: ORDER }, toClient);
  assert.deepEqual(d, { type: 'page', page: 'order', entity_type: 'order', entity_id: ORDER, entity_ref: 'SA-1001', label: 'Order SA-1001' });
  await rejects(svc.cleanDestination({ type: 'page', page: 'order', entity_id: OTHER_ORDER }, toClient), /owns it/);
  await rejects(svc.cleanDestination({ type: 'page', page: 'order', entity_id: ORDER }, toAllClients), /owns it/);
  await rejects(svc.cleanDestination({ type: 'page', page: 'order', entity_id: ORDER }, toStaff), /cannot be opened|for a client/);
  await rejects(svc.cleanDestination({ type: 'page', page: 'order', entity_id: U(99) }, toClient), /does not exist/);
});

test('a product is checked against the Shop rules and keeps its store', async () => {
  const d = await svc.cleanDestination({ type: 'product', product_id: PRODUCT }, toAllClients);
  assert.deepEqual(d, { type: 'product', product_id: PRODUCT, store_id: STORE, label: 'Linen shirt' });
  await rejects(svc.cleanDestination({ type: 'product', product_id: HIDDEN_PRODUCT }, toAllClients), /not available/);
  await rejects(svc.cleanDestination({ type: 'product', product_id: U(98) }, toAllClients), /not available/);
  await rejects(svc.cleanDestination({ type: 'product', product_id: PRODUCT }, toStaff), /only be linked/);
});

test('a product can be given as the app route or as the brand storefront address', async () => {
  const a = await svc.cleanDestination({ type: 'product', url: `/app/shop/product/${PRODUCT}` }, toAllClients);
  const b = await svc.cleanDestination({ type: 'product', url: 'https://brand.myshopify.com/products/linen-shirt?variant=1' }, toAllClients);
  const c = await svc.cleanDestination({ type: 'url', url: `/app/shop/product/${PRODUCT}` }, toAllClients);
  assert.equal(a.product_id, PRODUCT);
  assert.equal(b.product_id, PRODUCT);
  assert.equal(c.type, 'product');
  // another store's address, or a hidden product's handle, resolves to nothing
  await rejects(svc.cleanDestination({ type: 'product', url: 'https://other.myshopify.com/products/linen-shirt' }, toAllClients), /not available/);
  await rejects(svc.cleanDestination({ type: 'product', url: 'https://brand.myshopify.com/products/secret' }, toAllClients), /not available/);
});

test('unsafe or unapproved addresses are rejected', async () => {
  for (const url of ['javascript:alert(1)', 'data:text/html,x', 'http://docs.example.com/a', 'https://evil.example.org/x', 'https://user:pw@docs.example.com/a', '//evil.example.org', 'https://docs.example.com/a?access_token=abc', '/app/orders?token=abc', 'https://docs.example.com/a b']) {
    await rejects(svc.cleanDestination({ type: 'url', url }, toAllClients), undefined);
  }
});

test('an approved outside website and an approved route of the app are accepted', async () => {
  const ext = await svc.cleanDestination({ type: 'url', url: 'https://docs.example.com/size-guide' }, toAllClients);
  assert.deepEqual(ext, { type: 'url', url: 'https://docs.example.com/size-guide', external: true, label: 'docs.example.com' });
  const own = await svc.cleanDestination({ type: 'url', url: '/app/orders' }, toAllClients);
  assert.deepEqual(own, { type: 'url', url: '/app/orders', external: false, page: 'orders', label: 'Orders' });
  // a route that is not on the list, or that belongs to another audience, is refused
  await rejects(svc.cleanDestination({ type: 'url', url: '/app/shop/cart' }, toAllClients), /approved page/);
  await rejects(svc.cleanDestination({ type: 'url', url: '/admin/customers' }, toAllClients), /approved page/);
});

// ───────────── the route each person gets ─────────────

test('the same destination becomes the right route for each app', () => {
  const orders = { type: 'page', page: 'orders' };
  assert.deepEqual(svc.linkFor(orders, 'customer'), { link: '/app/orders', external_url: null });
  assert.deepEqual(svc.linkFor(orders, 'admin'), { link: '/admin/orders', external_url: null });
  assert.deepEqual(svc.linkFor(orders, 'partner_staff'), { link: '/partner/orders', external_url: null });
  const order = { type: 'page', page: 'order', entity_type: 'order', entity_id: ORDER, entity_ref: 'SA-1001' };
  assert.equal(svc.linkFor(order, 'customer').link, `/app/orders/${ORDER}`);
  assert.equal(svc.linkFor(order, 'admin').link, '/admin/orders?ref=SA-1001');
  assert.equal(svc.linkFor(order, 'partner_staff').link, null);
  const product = { type: 'product', product_id: PRODUCT };
  assert.equal(svc.linkFor(product, 'customer').link, `/app/shop/product/${PRODUCT}`);
  assert.equal(svc.linkFor(product, 'admin').link, null);
  assert.equal(svc.linkFor({ type: 'url', url: 'https://docs.example.com/x', external: true }, 'customer').external_url, 'https://docs.example.com/x');
  assert.equal(svc.linkFor({ type: 'page', page: 'customers' }, 'customer').link, null);
  assert.equal(svc.linkFor(null, 'customer').link, null);
});

// ───────────── tapping it ─────────────

const viewer = (role, extra = {}) => ({ userId: extra.userId || CLIENT, profile: { id: extra.userId || CLIENT, role, permissions: extra.permissions || [] }, access: extra.access || {} });

test('a notification without a destination does nothing special', async () => {
  assert.deepEqual(await svc.resolveDestination(viewer('customer'), { destination: null }), { kind: 'none' });
});

test('a client opens their own order, and not somebody else\'s', async () => {
  const dest = { type: 'page', page: 'order', entity_type: 'order', entity_id: ORDER, entity_ref: 'SA-1001' };
  assert.deepEqual(await svc.resolveDestination(viewer('customer'), { destination: dest }), { kind: 'internal', link: `/app/orders/${ORDER}` });
  await rejects(svc.resolveDestination(viewer('customer', { userId: OTHER_CLIENT }), { destination: dest }), /do not have access to this order/);
  await rejects(svc.resolveDestination(viewer('customer'), { destination: { ...dest, entity_id: U(97) } }), /no longer exists/);
});

test('a deleted or hidden product gives a clear message', async () => {
  const gone = { type: 'product', product_id: HIDDEN_PRODUCT, store_id: STORE };
  await rejects(svc.resolveDestination(viewer('customer'), { destination: gone }), /no longer available/);
  const ok = await svc.resolveDestination(viewer('customer'), { destination: { type: 'product', product_id: PRODUCT, store_id: STORE } });
  assert.equal(ok.link, `/app/shop/product/${PRODUCT}`);
});

test('a staff member needs the module permission for the page', async () => {
  const dest = { type: 'page', page: 'production' };
  const withPerm = viewer('partner_staff', { access: { permissions: new Set(['production.view']) } });
  const without = viewer('partner_staff', { access: { permissions: new Set(['overview.view']) } });
  assert.deepEqual(await svc.resolveDestination(withPerm, { destination: dest }), { kind: 'internal', link: '/partner/production' });
  await rejects(svc.resolveDestination(without, { destination: dest }), /do not have permission to access this page/);
});

test('a restricted admin needs the admin module; a full admin does not', async () => {
  const dest = { type: 'page', page: 'reports' };
  const restricted = viewer('admin', { permissions: ['admin.limited', 'admin.orders', 'admin.orders.view'] });
  const full = viewer('admin', { permissions: [] });
  await rejects(svc.resolveDestination(restricted, { destination: dest }), /do not have permission to access this page/);
  assert.equal((await svc.resolveDestination(full, { destination: dest })).link, '/admin/reports');
  const allowed = viewer('admin', { permissions: ['admin.limited', 'admin.reports', 'admin.reports.view'] });
  assert.equal((await svc.resolveDestination(allowed, { destination: dest })).link, '/admin/reports');
});

test('a page that does not exist for the person\'s app is refused, not guessed', async () => {
  await rejects(svc.resolveDestination(viewer('customer'), { destination: { type: 'page', page: 'customers' } }), /not available for your account/);
});

test('an outside address that lost its approval is not opened', async () => {
  const dest = { type: 'url', url: 'https://docs.example.com/x', external: true };
  assert.deepEqual(await svc.resolveDestination(viewer('customer'), { destination: dest }), { kind: 'external', url: 'https://docs.example.com/x' });
  process.env.NOTIFICATION_ALLOWED_HOSTS = '';
  await rejects(svc.resolveDestination(viewer('customer'), { destination: dest }), /no longer on the approved list/);
  process.env.NOTIFICATION_ALLOWED_HOSTS = 'docs.example.com';
});

test('the form is offered only the pages that exist for the audience', () => {
  const keys = (c, s) => svc.pageOptions(c, s).map((p) => p.key);
  assert.ok(keys('clients').includes('order') && keys('clients').includes('approvals'));
  assert.ok(!keys('clients').includes('customers'));
  assert.ok(!keys('staff').includes('order'));
  assert.deepEqual(keys('staff', 'partner').filter((k) => ['customers', 'reports'].includes(k)), []);
  assert.ok(keys('partners').includes('production'));
});
