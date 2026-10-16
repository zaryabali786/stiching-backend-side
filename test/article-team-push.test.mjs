/**
 * Who gets a push when something happens to ONE article: the partner that really stitched it (even after it moved on), the
 * people who did the work, the admins: never other partners or other customers. Real controllers and services run on an
 * in-memory database; only the database, the socket and Firebase's send call (recorded here) are replaced.
 *   npm run test:unit
 */
import { test, mock, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeDb } from './fake-supabase.mjs';

process.env.FIREBASE_SERVICE_ACCOUNT_JSON = JSON.stringify({ project_id: 'test', client_email: 'x@test', private_key: 'x' });

const ADMIN = 'admin-full';
const ADMIN_LIMITED = 'admin-customers-only';
const C1 = 'customer-1';
const C2 = 'customer-2';
const P1 = 'partner-1'; // stitched the article
const P2 = 'partner-2'; // the order / ticket sits here now (the article moved on)
const P1_OWNER = 'p1-owner';
const P1_TAILOR = 'p1-tailor'; // stitched it (has his own login)
const P1_MASTER = 'p1-master';
const P1_QA = 'p1-qa'; // checked it
const P1_OTHER_TAILOR = 'p1-other-tailor'; // same partner, works on other articles: never told
const P1_PRODUCTION = 'p1-production-member';
const P1_RECEIVING_ONLY = 'p1-receiving-only';
const P2_OWNER = 'p2-owner';
const P2_PRODUCTION = 'p2-production-member';
const ORDER = 'order-1';
const UNIT = 'unit-1';
const CARD = 'card-1';

let db;
let sent;
const tok = (u) => `tok-${u}-${'x'.repeat(24)}`;
const dev = (u, app = 'admin') => ({ user_id: u, token: tok(u), platform: 'android', app });
const everyone = [ADMIN, ADMIN_LIMITED, C1, C2, P1_OWNER, P1_TAILOR, P1_MASTER, P1_QA, P1_OTHER_TAILOR, P1_PRODUCTION, P1_RECEIVING_ONLY, P2_OWNER, P2_PRODUCTION];

const staff = (id, partner, extra = {}) => ({ id, role: 'partner_staff', partner_id: partner, partner_role: 'member', is_active: true, permissions: [], ...extra });

const freshDb = () =>
  createFakeDb({
    profiles: [
      { id: ADMIN, role: 'admin', is_active: true, permissions: [] },
      { id: ADMIN_LIMITED, role: 'admin', is_active: true, permissions: ['admin.limited', 'admin.customers'] },
      { id: C1, role: 'customer', is_active: true, full_name: 'One' },
      { id: C2, role: 'customer', is_active: true, full_name: 'Two' },
      staff(P1_OWNER, P1, { partner_role: 'owner' }),
      staff(P1_TAILOR, P1, { permissions: ['production.view'], staff_type: 'tailor' }),
      staff(P1_OTHER_TAILOR, P1, { permissions: ['production.view'], staff_type: 'tailor' }),
      staff(P1_MASTER, P1, { permissions: ['production.view'], staff_type: 'master' }),
      staff(P1_QA, P1, { permissions: ['quality.view'], staff_type: 'qa' }),
      staff(P1_PRODUCTION, P1, { permissions: ['production.view'] }),
      staff(P1_RECEIVING_ONLY, P1, { permissions: ['receiving.view'] }),
      staff(P2_OWNER, P2, { partner_role: 'owner' }),
      staff(P2_PRODUCTION, P2, { permissions: ['production.view'] }),
    ],
    partners: [
      { id: P1, name: 'Partner One', status: 'active', permissions: ['production.view', 'quality.view', 'receiving.view'] },
      { id: P2, name: 'Partner Two', status: 'active', permissions: ['production.view', 'quality.view', 'receiving.view'] },
    ],
    team_members: [
      { id: 'tm-tailor', user_id: P1_TAILOR, partner_id: P1, role: 'tailor', name: 'Tailor', is_active: true },
      { id: 'tm-master', user_id: P1_MASTER, partner_id: P1, role: 'master', name: 'Master', is_active: true },
    ],
    // the order was reassigned to partner 2 and the ticket sits there now: the old "order's partner" rule would tell partner 2
    orders: [{ id: ORDER, reference: 'SA-7', customer_id: C1, customer_name: 'One', partner_id: P2, status: 'qc_passed' }],
    order_units: [{ id: UNIT, order_id: ORDER, line_no: 1, unit_title: 'Kurta', status: 'received', review_status: 'approved', return_status: 'none' }],
    job_cards: [{
      id: CARD, order_id: ORDER, unit_id: UNIT, partner_id: P2, stage: 'qc', unit_title: 'Kurta', order_reference: 'SA-7',
      approval_status: 'pending', qc_passed: true, tailor_id: 'tm-tailor', master_id: 'tm-master',
    }],
    // what really happened: partner 1's master cut it, its tailor stitched it, its QA checked it
    unit_stage_receipts: [
      { order_id: ORDER, unit_id: UNIT, card_id: CARD, partner_id: P1, stage: 'cutting', role: 'master', user_id: P1_MASTER },
      { order_id: ORDER, unit_id: UNIT, card_id: CARD, partner_id: P1, stage: 'stitching', role: 'tailor', user_id: P1_TAILOR },
      { order_id: ORDER, unit_id: UNIT, card_id: CARD, partner_id: P1, stage: 'qc', role: 'qa', user_id: P1_QA },
    ],
    push_devices: everyone.map((u) => dev(u, u === C1 || u === C2 ? 'client' : 'admin')),
  });

const dbProxy = new Proxy({}, { get: (_, key) => db[key] });
const settle = () => new Promise((r) => setTimeout(r, 60));
const recipients = () => [...new Set(sent.map((s) => s.message.data.userId))].sort();
const titles = () => [...new Set(sent.map((s) => s.message.notification.title))];
const titlesFor = (u) => sent.filter((s) => s.message.data.userId === u).map((s) => s.message.notification.title);
/** Everybody told, apart from the customer (the customer's own stage update is checked separately). */
const staffTold = () => recipients().filter((u) => u !== C1);

/** Run an express handler (wrapped by catchAsync) to its response. */
const call = (handler, req) =>
  new Promise((resolve, reject) => {
    const res = { status() { return this; }, json(body) { resolve(body); return this; } };
    handler(req, res, (err) => reject(err || new Error('handler called next() without an error')));
  });

const partnerReq = (userId, partnerId, extra) => ({
  userId,
  profile: { id: userId, full_name: userId, email: `${userId}@test.dev`, partner_role: 'member' },
  access: { isAdmin: false, partnerId, permissions: new Set(['production.view', 'production.update', 'production.scan', 'quality.view', 'quality.update', 'quality.pass']) },
  ...extra,
});

let client;
let production;
let team;

before(async () => {
  mock.module('../src/config/supabase.js', { namedExports: { supabaseAdmin: dbProxy, supabase: dbProxy } });
  mock.module('../src/realtime/io.js', { namedExports: { emitTo: () => {}, getIO: () => null, rooms: { user: (id) => `user:${id}`, admins: 'admins', production: (id) => `production:${id}` } } });
  mock.module('firebase-admin/app', { namedExports: { initializeApp: () => ({}), cert: (c) => c, getApps: () => [] } });
  mock.module('firebase-admin/messaging', {
    namedExports: { getMessaging: () => ({ sendEachForMulticast: async (m) => { sent.push(...m.tokens.map((t) => ({ token: t, message: m }))); return { responses: m.tokens.map(() => ({ success: true })) }; } }) },
  });
  team = await import('../src/services/article-notify.service.js');
  client = await import('../src/controllers/client.controller.js');
  production = await import('../src/controllers/production.controller.js');
});

beforeEach(() => {
  db = freshDb();
  sent = [];
});

test('the partner who really stitched an article is found from its history, not from where it sits now', async () => {
  const actors = await team.articleActors({ orderId: ORDER, unitId: UNIT, stages: ['stitching'] });
  assert.deepEqual(actors.partnerIds, [P1]); // not partner 2, where the ticket and the order are today
  assert.ok(actors.userIds.includes(P1_TAILOR));
  assert.ok(!actors.userIds.includes(P1_QA), 'only the people of the asked stages');
});

test('without any receipts (older orders) the ticket\'s partner is used', async () => {
  db.tables.unit_stage_receipts.length = 0;
  const actors = await team.articleActors({ orderId: ORDER, unitId: UNIT, stages: ['stitching'] });
  assert.deepEqual(actors.partnerIds, [P2]);
});

test('QC APPROVAL by the customer -> admin, the partner that stitched it, its tailor and QA: nobody else', async () => {
  await call(client.approveClientOrder, { params: { id: ORDER }, body: { unit_id: UNIT }, userId: C1, profile: { id: C1, full_name: 'One' } });
  await settle();
  // the admin, partner 1's management (owner + the member who holds Production) and the two who did the work: its tailor and its QA
  assert.deepEqual(recipients(), [ADMIN, P1_OWNER, P1_PRODUCTION, P1_QA, P1_TAILOR].sort());
  // not the rest of the floor: the master (cut it, not part of this event) and a tailor who never touched it
  for (const u of [P1_MASTER, P1_OTHER_TAILOR]) assert.ok(!recipients().includes(u), `${u} did not work on this step`);
  assert.deepEqual(titles(), ['Approved: SA-7 · Kurta']);
  // the unrelated ones
  for (const u of [C1, C2, P2_OWNER, P2_PRODUCTION, P1_RECEIVING_ONLY, ADMIN_LIMITED]) assert.ok(!recipients().includes(u), `${u} must not be told`);
  // each person gets the page that suits their app
  const links = Object.fromEntries(sent.map((s) => [s.message.data.userId, s.message.data.link]));
  assert.equal(links[ADMIN], '/admin/orders?ref=SA-7');
  assert.equal(links[P1_TAILOR], `/partner/production/jobs/${CARD}`);
});

test('QC FAILED by the QA -> the tailor who stitched it, that partner\'s production people and the admins; not the customer, not the QA who did it', async () => {
  db.table('job_cards')[0].partner_id = P1;
  await call(production.failQc, partnerReq(P1_QA, P1, { params: { id: CARD }, body: { notes: 'Collar is crooked' } }));
  await settle();
  assert.deepEqual(staffTold(), [ADMIN, P1_OWNER, P1_PRODUCTION, P1_TAILOR].sort());
  assert.deepEqual(titlesFor(P1_TAILOR), ['QC failed: SA-7 · Kurta']);
  assert.equal(sent.find((s) => s.message.data.userId === P1_TAILOR).message.notification.body, 'Collar is crooked');
  // the customer is not told about the failure itself, only the usual stage update (the article is back in stitching)
  assert.deepEqual(titlesFor(C1), ['SA-7: Stitching']);
  for (const u of [C2, P1_QA, P2_OWNER, P2_PRODUCTION]) assert.ok(!recipients().includes(u), `${u} must not be told`);
});

test('QC PASSED -> admins, the people who made it and that partner\'s QC team (not the QA who passed it)', async () => {
  db.table('job_cards')[0].partner_id = P1;
  await call(production.passQc, partnerReq(P1_QA, P1, { params: { id: CARD }, body: { notes: 'Looks great' } }));
  await settle();
  // the admin, the tailor who made it and the owner (who sees Quality); not the QA who passed it, not partner 2, not customers
  assert.deepEqual(recipients(), [ADMIN, P1_OWNER, P1_TAILOR].sort());
  for (const u of [C1, C2, P2_OWNER, P2_PRODUCTION, P1_QA]) assert.ok(!recipients().includes(u));
});

test('CHANGE REQUEST by the customer -> the partner that stitched it, its tailor and the admins', async () => {
  await call(client.requestChanges, { params: { id: ORDER }, body: { unit_id: UNIT, note: 'Make the sleeves shorter' }, userId: C1, profile: { id: C1, full_name: 'One' } });
  await settle();
  assert.deepEqual(staffTold(), [ADMIN, P1_OWNER, P1_PRODUCTION, P1_TAILOR].sort());
  assert.deepEqual(titlesFor(P1_TAILOR), ['Change request: SA-7 · Kurta']);
  for (const u of [C2, P2_OWNER, P2_PRODUCTION, P1_QA, P1_RECEIVING_ONLY, P1_MASTER, P1_OTHER_TAILOR]) assert.ok(!recipients().includes(u), `${u} must not be told`);
});

test('ASSIGNING a master -> only that master (his own login) is told', async () => {
  const card = db.table('job_cards')[0];
  Object.assign(card, { partner_id: P1, stage: 'to_assign', master_id: null });
  await call(production.assignCard, partnerReq(P1_OWNER, P1, { params: { id: CARD }, body: { master_id: 'tm-master' } }));
  await settle();
  assert.deepEqual(recipients(), [P1_MASTER]);
  assert.match(sent[0].message.notification.title, /^New article for you: SA-7 · Kurta$/);
});

test('a team member whose login belongs to ANOTHER partner is never told, whatever the record says', async () => {
  db.table('team_members').find((m) => m.id === 'tm-master').user_id = P2_PRODUCTION; // wrong partner's login on the record
  Object.assign(db.table('job_cards')[0], { partner_id: P1, stage: 'to_assign', master_id: null });
  await call(production.assignCard, partnerReq(P1_OWNER, P1, { params: { id: CARD }, body: { master_id: 'tm-master' } }));
  await settle();
  assert.deepEqual(recipients(), []);
});

test('a stage is completed -> only the people of the next stage, of that partner, are told', async () => {
  db.table('order_units')[0].code = 'U-1';
  Object.assign(db.table('job_cards')[0], { partner_id: P1, stage: 'stitching', approval_status: 'none', qc_passed: false });
  const owner = partnerReq(P1_OWNER, P1, { body: { code: 'U-1' } });
  owner.profile.partner_role = 'owner';
  await call(production.scanComplete, owner);
  await settle();
  // stitching finished -> quality check is next: the partner's quality people (the owner did the scan himself, so not him)
  assert.deepEqual(recipients(), [P1_QA]);
  assert.equal(titles()[0], 'Ready for Quality check: SA-7 · Kurta');
  for (const u of [C1, C2, ADMIN, P2_OWNER, P2_PRODUCTION]) assert.ok(!recipients().includes(u));
});