/**
 * The admin table of Shopify orders is searched and paged on the server: what is asked of the database (the search expression, the store filter,
 * the page range) and how a row is described. The database is a recorder: nothing real is read.
 */
import { test, mock, before } from 'node:test';
import assert from 'node:assert/strict';

let page;
let log;

/** A query builder that records every call and answers with the rows given for its table. */
const builder = (table, rows, count) => {
  const calls = [];
  log.push({ table, calls });
  const api = new Proxy({}, {
    get: (_, name) => {
      if (name === 'then') return (resolve) => resolve({ data: rows, error: null, count });
      return (...args) => {
        calls.push([name, ...args]);
        return api;
      };
    },
  });
  return api;
};
const tables = {};
const dbProxy = new Proxy({}, { get: (_, key) => (key === 'from' ? (t) => builder(t, tables[t]?.rows ?? [], tables[t]?.count ?? 0) : undefined) });

before(async () => {
  process.env.LOGIN_CODE_SECRET = 'test-login-secret';
  mock.module('../src/config/supabase.js', { namedExports: { supabaseAdmin: dbProxy, supabase: dbProxy } });
  page = await import('../src/services/shopify-orders.service.js');
});

const list = (over = {}) => ({ page: 1, limit: 15, search: '', from: 0, to: 14, ...over });
const call = (t, name) => log.filter((l) => l.table === t).flatMap((l) => l.calls).find((c) => c[0] === name);

test('no search: the newest page of all stores, counted', async () => {
  log = [];
  tables.shopify_orders = { rows: [{ id: 'a', state: 'received', address_state: 'address_ok', hold_state: 'none', store: [{ shop_domain: 'x.myshopify.com' }], order: null }], count: 41 };
  const r = await page.shopifyOrdersPage(list());
  assert.equal(r.total, 41);
  assert.equal(r.rows.length, 1);
  assert.deepEqual(r.rows[0].store, { shop_domain: 'x.myshopify.com' }, 'a joined row that comes as a list is flattened');
  assert.deepEqual(call('shopify_orders', 'range').slice(1), [0, 14]);
  assert.equal(call('shopify_orders', 'or'), undefined);
  assert.equal(call('shopify_orders', 'eq'), undefined);
});

test('page 3 asks for rows 30 to 44', async () => {
  log = [];
  await page.shopifyOrdersPage(list({ page: 3, from: 30, to: 44 }));
  assert.deepEqual(call('shopify_orders', 'range').slice(1), [30, 44]);
});

test('a search looks in the order number, email and codes, and in the stores and app orders it matches', async () => {
  log = [];
  tables.shopify_stores = { rows: [{ id: 'st1' }, { id: 'st2' }] };
  tables.orders = { rows: [{ id: 'ord1' }] };
  await page.shopifyOrdersPage(list({ search: 'shaki' }));
  const expr = call('shopify_orders', 'or')[1];
  for (const col of ['shopify_order_name', 'shopify_order_id', 'customer_email', 'ref_code']) assert.match(expr, new RegExp(`${col}\.ilike\.%shaki%`));
  assert.match(expr, /store_id\.in\.\(st1,st2\)/);
  assert.match(expr, /order_id\.in\.\(ord1\)/);
  assert.deepEqual(call('shopify_stores', 'ilike').slice(1), ['shop_domain', '%shaki%']);
  assert.deepEqual(call('orders', 'ilike').slice(1), ['reference', '%shaki%']);
  tables.shopify_stores = undefined;
  tables.orders = undefined;
});

test('a search that matches no store or app order only uses the order columns; a store filter limits to that store', async () => {
  log = [];
  await page.shopifyOrdersPage(list({ search: '1020' }), { storeId: 'st9' });
  const expr = call('shopify_orders', 'or')[1];
  assert.doesNotMatch(expr, /store_id\.in|order_id\.in/);
  assert.deepEqual(call('shopify_orders', 'eq').slice(1), ['store_id', 'st9']);
});

test('a row that needs the team is marked', async () => {
  log = [];
  tables.shopify_orders = { rows: [{ id: 'f', state: 'failed' }, { id: 'ok', state: 'draft_created', notified_at: 'x', address_state: 'address_ok', hold_state: 'released' }], count: 2 };
  const r = await page.shopifyOrdersPage(list());
  assert.deepEqual(r.rows.map((x) => x.needs_attention), [true, false]);
});
