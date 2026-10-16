/**
 * The order flow, step by step, and exactly who gets a push at each step. The real services run on an in-memory database;
 * only the database, the socket and Firebase's send call (recorded here) are replaced.
 *   npm run test:unit
 */
import { test, mock, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeDb } from './fake-supabase.mjs';

process.env.FIREBASE_SERVICE_ACCOUNT_JSON = JSON.stringify({ project_id: 'test', client_email: 'x@test', private_key: 'x' });

const ADMIN = 'admin-1';
const C1 = 'customer-1';
const C2 = 'customer-2';
const P1_OWNER = 'p1-owner';
const P1_PRODUCTION = 'p1-production-member';
const P1_RECEIVING_ONLY = 'p1-receiving-only';
const P2_OWNER = 'p2-owner';
const P1 = 'partner-1';
const P2 = 'partner-2';
const ORDER = 'order-1';

let db;
let sent;
const tok = (u) => `tok-${u}-${'x'.repeat(24)}`;
const dev = (u, app) => ({ user_id: u, token: tok(u), platform: 'android', app });

const freshDb = () =>
  createFakeDb({
    profiles: [
      { id: ADMIN, role: 'admin', is_active: true, permissions: [] },
      { id: C1, role: 'customer', is_active: true, full_name: 'One' },
      { id: C2, role: 'customer', is_active: true, full_name: 'Two' },
      { id: P1_OWNER, role: 'partner_staff', partner_id: P1, partner_role: 'owner', is_active: true, permissions: [] },
      { id: P1_PRODUCTION, role: 'partner_staff', partner_id: P1, partner_role: 'member', is_active: true, permissions: ['production.view'] },
      { id: P1_RECEIVING_ONLY, role: 'partner_staff', partner_id: P1, partner_role: 'member', is_active: true, permissions: ['receiving.view'] },
      { id: P2_OWNER, role: 'partner_staff', partner_id: P2, partner_role: 'owner', is_active: true, permissions: [] },
    ],
    partners: [
      { id: P1, name: 'Partner One', status: 'active', permissions: ['production.view', 'receiving.view'] },
      { id: P2, name: 'Partner Two', status: 'active', permissions: ['production.view', 'receiving.view'] },
    ],
    // a customer's own parcel (no details step): approved articles go straight to production
    orders: [{ id: ORDER, reference: 'SA-1', customer_id: C1, customer_name: 'One', partner_id: P1, status: 'submitted', parcel_review: 'none', order_source: 'customer', brand: 'Sapphire' }],
    order_units: [
      { id: 'u1', order_id: ORDER, line_no: 1, unit_title: 'Kurta', status: 'received', review_status: 'none', return_status: 'none' },
      { id: 'u2', order_id: ORDER, line_no: 2, unit_title: 'Trouser', status: 'received', review_status: 'none', return_status: 'none' },
    ],
    push_devices: [dev(ADMIN, 'admin'), dev(C1, 'client'), dev(C2, 'client'), dev(P1_OWNER, 'admin'), dev(P1_PRODUCTION, 'admin'), dev(P1_RECEIVING_ONLY, 'admin'), dev(P2_OWNER, 'admin')],
  });

const dbProxy = new Proxy({}, { get: (_, key) => db[key] });
const settle = () => new Promise((r) => setTimeout(r, 40));
const recipients = () => [...new Set(sent.map((s) => s.message.data.userId))].sort();
const titles = () => [...new Set(sent.map((s) => s.message.notification.title))];

let orderService;
let review;

before(async () => {
  mock.module('../src/config/supabase.js', { namedExports: { supabaseAdmin: dbProxy, supabase: dbProxy } });
  mock.module('../src/realtime/io.js', { namedExports: { emitTo: () => {}, rooms: { user: (id) => `user:${id}`, admins: 'admins', production: (id) => `production:${id}` } } });
  mock.module('firebase-admin/app', { namedExports: { initializeApp: () => ({}), cert: (c) => c, getApps: () => [] } });
  mock.module('firebase-admin/messaging', {
    namedExports: { getMessaging: () => ({ sendEachForMulticast: async (m) => { sent.push(...m.tokens.map((t) => ({ token: t, message: m }))); return { responses: m.tokens.map(() => ({ success: true })) }; } }) },
  });
  orderService = await import('../src/services/order.service.js');
  review = await import('../src/services/unit-review.service.js');
});

beforeEach(() => {
  db = freshDb();
  sent = [];
});

const loadOrder = () => db.table('orders').find((o) => o.id === ORDER);
const loadUnit = (id) => db.table('order_units').find((u) => u.id === id);

test('1. the partner receives the parcel -> only the order\'s customer is told, with the order reference', async () => {
  await orderService.syncReceiving(ORDER, P1_OWNER);
  await settle();
  assert.deepEqual(recipients(), [C1]);
  assert.deepEqual(titles(), ['Your parcel arrived: SA-1']);
  const m = sent[0].message;
  assert.equal(m.data.orderId, ORDER);
  assert.equal(m.data.link, `/app/orders/${ORDER}`);
});

test('2. the customer approves an article -> the order\'s partner (people who see Production) is told, nobody else', async () => {
  await orderService.syncReceiving(ORDER, P1_OWNER);
  sent = [];
  await review.decideArticle({ order: loadOrder(), unit: loadUnit('u1'), decision: 'approve', profile: { id: C1 } });
  await settle();
  // owner + the member who holds Production; not the receiving-only member, not partner 2, not the customers, not the admin
  assert.deepEqual(recipients(), [P1_OWNER, P1_PRODUCTION].sort());
  assert.deepEqual(titles(), ['Approved by the customer: SA-1']);
  assert.equal(sent[0].message.data.link, '/partner/production?search=SA-1');
  assert.equal(db.table('job_cards').length, 1, 'the approved article got its production ticket');
});

test('3. "Approve all" gives the partner ONE alert for the order, not one per article', async () => {
  await orderService.syncReceiving(ORDER, P1_OWNER);
  sent = [];
  await review.approveAllArticles({ order: loadOrder(), profile: { id: C1 } });
  await settle();
  assert.deepEqual(recipients(), [P1_OWNER, P1_PRODUCTION].sort());
  assert.equal(sent.filter((s) => s.token === tok(P1_OWNER)).length, 1);
  assert.equal(db.table('job_cards').length, 2);
});

test('4. an order of another partner never reaches this partner (and the other way round)', async () => {
  db.table('orders').find((o) => o.id === ORDER).partner_id = P2;
  await orderService.syncReceiving(ORDER, P2_OWNER);
  sent = [];
  await review.decideArticle({ order: loadOrder(), unit: loadUnit('u1'), decision: 'approve', profile: { id: C1 } });
  await settle();
  assert.deepEqual(recipients(), [P2_OWNER]);
});

test('5. the customer rejects an article -> staff are told (admins + that partner\'s receiving people), not the other customer', async () => {
  await orderService.syncReceiving(ORDER, P1_OWNER);
  sent = [];
  await review.decideArticle({ order: loadOrder(), unit: loadUnit('u1'), decision: 'reject', note: 'Wrong fabric', returnTo: 'customer', profile: { id: C1 } });
  await settle();
  assert.deepEqual(recipients(), [ADMIN, P1_OWNER, P1_RECEIVING_ONLY].sort());
  assert.ok(!recipients().includes(C2));
});

test('6. production moves on (cutting) -> only the order\'s customer is told', async () => {
  await orderService.syncReceiving(ORDER, P1_OWNER);
  await review.approveAllArticles({ order: loadOrder(), profile: { id: C1 } });
  db.table('orders').find((o) => o.id === ORDER).status = 'received';
  for (const c of db.table('job_cards')) c.stage = 'cutting';
  sent = [];
  await orderService.syncOrderFromCards(ORDER, P1_OWNER);
  await settle();
  assert.deepEqual(recipients(), [C1]);
  assert.match(titles()[0], /^SA-1: /);
});
