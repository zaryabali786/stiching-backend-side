/**
 * The customer's order list: searching used to crash every time ("query.or is not a function") because the status filter was an
 * async function and awaiting a Supabase query builder runs it. Searching, filtering and both together must return the matching rows.
 */
import { test, mock, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeDb } from './fake-supabase.mjs';

let db;
let client;
const dbProxy = new Proxy({}, { get: (_, key) => db[key] });

before(async () => {
  mock.module('../src/config/supabase.js', { namedExports: { supabaseAdmin: dbProxy, supabase: dbProxy } });
  client = await import('../src/controllers/client.controller.js');
});

beforeEach(() => {
  db = createFakeDb({
    orders: [
      { id: 'o1', reference: 'SA-1001', brand: 'Alkaram', brand_order_number: 'AK-77', tracking_number: null, status: 'submitted', customer_id: 'c1', created_at: '2026-10-01' },
      { id: 'o2', reference: 'SA-1002', brand: 'Garnet', brand_order_number: null, tracking_number: 'TRK9', status: 'delivered', customer_id: 'c1', created_at: '2026-10-02' },
      { id: 'o3', reference: 'SA-2001', brand: 'Alkaram', brand_order_number: null, tracking_number: null, status: 'submitted', customer_id: 'someone-else', created_at: '2026-10-03' },
    ],
    order_units: [],
  });
});

const list = (query) =>
  new Promise((resolve, reject) => {
    const res = { status() { return this; }, json(b) { resolve(b); return this; } };
    client.getClientOrders({ userId: 'c1', query }, res, reject);
  });

// (the fake database does not evaluate ilike filters, so these check that the request is answered and stays the customer's own)
test("searching answers with the customer's own orders only", async () => {
  const body = await list({ search: 'alkaram' });
  assert.ok(body.data.length > 0 && body.data.every((o) => o.reference !== 'SA-2001'));
});

test('search plus a status filter works together', async () => {
  assert.deepEqual((await list({ search: 'SA-100', status: 'placed' })).data.map((o) => o.reference), ['SA-1001']);
  assert.deepEqual((await list({ search: 'SA-100', status: 'delivered' })).data.map((o) => o.reference), ['SA-1002']);
  assert.deepEqual((await list({ search: 'SA-100', status: 'return' })).data, []);
});

test('awkward characters in the search never crash the list', async () => {
  for (const search of ['"quoted"', 'a\b', '<b>x</b>', "O'Brien", '50%', '(x)', 'x;y']) {
    const body = await list({ search });
    assert.ok(Array.isArray(body.data), `search ${JSON.stringify(search)}`);
  }
});

test('the status filter alone still works', async () => {
  assert.deepEqual((await list({ status: 'delivered' })).data.map((o) => o.reference), ['SA-1002']);
});
