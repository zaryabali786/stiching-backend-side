/**
 * Master-wise tracking through the real controller with an in-memory database: several masters, several tailors, several
 * orders, partly received orders, who may see what, and how scanning changes the numbers.
 *   npm run test:unit
 */
import { expandPermissions } from '../src/config/permissions.js';
import { test, mock, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeDb } from './fake-supabase.mjs';

let db;
let controller;
const dbProxy = new Proxy({}, { get: (_, key) => db[key] });
const noop = async () => {};

before(async () => {
  mock.module('../src/config/supabase.js', { namedExports: { supabaseAdmin: dbProxy, supabase: dbProxy } });
  mock.module('../src/services/notification.service.js', { namedExports: { notifyAdmins: noop, notifyPartner: noop, notifyUser: noop, notifyStaff: noop, partnerRecipients: async () => [] } });
  mock.module('../src/services/team.service.js', { namedExports: { suggestAssignees: async () => ({ master: null, tailor: null }), getTeamWithLoad: async () => ({ masters: [], members: [] }) } });
  mock.module('../src/realtime/io.js', {
    namedExports: {
      emitTo: () => {},
      getIO: () => null,
      setIO: () => {},
      rooms: { user: (id) => `user:${id}`, order: (id) => `order:${id}`, admins: 'admins', partner: (id) => `partner:${id}`, production: (id) => `production:${id}` },
    },
  });
  controller = await import('../src/controllers/production.controller.js');
});

const P1 = 'p1';
const P2 = 'p2';

const card = (id, order, n, stage, master, tailor) => ({ id, order_id: order, unit_id: `${order}-u${n}`, partner_id: P1, stage, position: n, master_id: master, tailor_id: tailor, qc_passed: false, approval_status: 'none', unit_title: `Article ${n}` });
const unit = (order, n, ref) => ({ id: `${order}-u${n}`, order_id: order, line_no: n, code: `${ref}-${n}`, unit_title: `Article ${n}`, status: 'received', review_status: 'approved', return_status: 'none' });
const receipt = (order, n, stage, userId, name) => ({ order_id: order, unit_id: `${order}-u${n}`, stage, role: stage === 'cutting' ? 'master' : 'tailor', user_id: userId, user_name: name, received_at: `2026-02-0${n}` });

beforeEach(() => {
  db = createFakeDb({
    orders: [
      { id: 'o1', reference: 'SA-5001', status: 'received', customer_id: 'c1', partner_id: P1, customer_name: 'Ali', brand: 'Sapphire', due_date: '2026-03-01' },
      { id: 'o2', reference: 'SA-5002', status: 'received', customer_id: 'c2', partner_id: P1, customer_name: 'Sara', brand: 'Khaadi', due_date: '2026-03-02' },
      { id: 'o3', reference: 'SA-5003', status: 'received', customer_id: 'c3', partner_id: P1, customer_name: 'Zain', brand: 'Alkaram', due_date: '2026-03-03' },
    ],
    order_units: [
      ...[1, 2, 3, 4, 5].map((n) => unit('o1', n, 'SA-5001')),
      ...[1, 2].map((n) => unit('o2', n, 'SA-5002')),
      ...[1, 2, 3].map((n) => unit('o3', n, 'SA-5003')),
    ],
    job_cards: [
      // order 1 (five articles): two picked up by master one's team, three still waiting to be picked up
      card('c11', 'o1', 1, 'cutting', 'm1', null),
      card('c12', 'o1', 2, 'stitching', 'm1', 't1'),
      card('c13', 'o1', 3, 'to_assign', 'm1', null),
      card('c14', 'o1', 4, 'to_assign', null, null),
      card('c15', 'o1', 5, 'to_assign', null, null),
      // order 2 belongs to master two
      card('c21', 'o2', 1, 'to_assign', 'm2', null),
      card('c22', 'o2', 2, 'cutting', 'm2', 't2'),
      // order 3 is shared: two for master one, one for master two
      card('c31', 'o3', 1, 'qc', 'm1', 't3'),
      card('c32', 'o3', 2, 'to_assign', 'm1', null),
      card('c33', 'o3', 3, 'cutting', 'm2', null),
    ],
    unit_stage_receipts: [
      receipt('o1', 1, 'cutting', 'u-m1', 'Master One'),
      receipt('o1', 2, 'cutting', 'u-m1', 'Master One'),
      receipt('o1', 2, 'stitching', 'u-t1', 'Tailor One'),
    ],
    team_members: [
      { id: 'm1', name: 'Master One', role: 'master', master_id: null, user_id: 'u-m1', partner_id: P1, is_active: true, daily_capacity: 8 },
      { id: 'm2', name: 'Master Two', role: 'master', master_id: null, user_id: 'u-m2', partner_id: P1, is_active: true, daily_capacity: 8 },
      { id: 't1', name: 'Tailor One', role: 'tailor', master_id: 'm1', user_id: 'u-t1', partner_id: P1, is_active: true, daily_capacity: 4 },
      { id: 't3', name: 'Tailor Three', role: 'tailor', master_id: 'm1', user_id: null, partner_id: P1, is_active: true, daily_capacity: 4 },
      { id: 't2', name: 'Tailor Two', role: 'tailor', master_id: 'm2', user_id: 'u-t2', partner_id: P1, is_active: true, daily_capacity: 4 },
      { id: 'mx', name: 'Other Partner Master', role: 'master', master_id: null, user_id: 'u-mx', partner_id: P2, is_active: true, daily_capacity: 8 },
    ],
  });
});

const staff = (userId, staffType, permissions, over = {}) => ({
  userId,
  profile: { id: userId, full_name: `User ${userId}`, email: `${userId}@t.dev`, staff_type: staffType, partner_role: 'member', ...over },
  access: { isAdmin: false, partnerId: P1, permissions: new Set(expandPermissions(permissions)) },
});
const master1 = staff('u-m1', 'master', ['production.view', 'production.update']);
const master2 = staff('u-m2', 'master', ['production.view', 'production.update']);
const tailor1 = staff('u-t1', 'tailor', ['production.view', 'production.update']);
const owner = staff('u-owner', null, ['production.view', 'teams.view'], { partner_role: 'owner' });

const call = (handler, who, extra = {}) =>
  new Promise((resolve) => {
    const req = { ...who, body: extra.body || {}, query: extra.query || {}, params: {} };
    handler(req, { status() { return this; }, json: (b) => resolve({ ok: true, ...b }) }, (err) => resolve({ ok: false, err }));
  });
const track = (who, query) => call(controller.getMasterTracking, who, { query });
const scan = (who, code) => call(controller.scanReceive, who, { body: { code } });
const order = (r, ref) => r.data.orders.find((o) => o.reference === ref);

test('a master sees every order of their team: 2 of 5 picked up, 3 remaining, and exactly which', async () => {
  const r = await track(master1);
  assert.equal(r.ok, true, r.err?.message);
  assert.equal(r.data.master.name, 'Master One');
  assert.equal(r.data.viewer, 'master');
  assert.deepEqual(r.data.orders.map((o) => o.reference).sort(), ['SA-5001', 'SA-5003'], "master two's order is not shown");

  const o1 = order(r, 'SA-5001');
  assert.deepEqual([o1.total, o1.received, o1.remaining], [5, 2, 3]);
  assert.equal(o1.remaining_text, '3 articles remaining to pick up');
  assert.deepEqual(o1.articles.map((a) => a.state), ['with_master', 'with_tailor', 'pending', 'pending', 'pending']);
  assert.equal(o1.articles[0].received_by, 'Master One');
  assert.equal(o1.articles[1].received_by, 'Tailor One');
  assert.deepEqual(o1.articles.filter((a) => a.state === 'pending').map((a) => a.code), ['SA-5001-3', 'SA-5001-4', 'SA-5001-5']);
  assert.deepEqual(o1.members, ['Master One', 'Tailor One']);
});

test('a shared order shows only the team’s own articles, not the other master’s', async () => {
  const r = await track(master1);
  const o3 = order(r, 'SA-5003');
  assert.equal(o3.total, 2, 'article 3 belongs to master two');
  assert.deepEqual(o3.articles.map((a) => a.state), ['completed', 'pending']);
  assert.deepEqual([o3.received, o3.remaining, o3.completed], [1, 1, 1]);
  assert.equal(o3.articles[0].tailor, 'Tailor Three');
});

test('every team member has received, pending and completed counts', async () => {
  const r = await track(master1);
  const by = Object.fromEntries(r.data.members.map((m) => [m.name, m]));
  assert.deepEqual(Object.keys(by).sort(), ['Master One', 'Tailor One', 'Tailor Three']);
  // master one: articles c11, c12, c31 picked up (c31 and c12 moved on: completed for the master), c13 and c32 pending
  assert.deepEqual([by['Master One'].received, by['Master One'].pending, by['Master One'].completed], [3, 2, 2]);
  assert.deepEqual([by['Tailor One'].received, by['Tailor One'].pending, by['Tailor One'].completed], [1, 0, 0]);
  assert.deepEqual([by['Tailor Three'].received, by['Tailor Three'].completed], [1, 1], 'it is in quality check: stitched, so received and completed');
  assert.equal(by['Master One'].is_master, true);
  assert.deepEqual(r.data.totals, { orders: 2, articles: 7, received: 3, remaining: 4, completed: 1 });
});

test('scanning updates the numbers one article at a time and never marks the whole order received', async () => {
  const first = await scan(master1, 'SA-5001-3'); // assigned to master one, waiting
  assert.equal(first.ok, true, first.err?.message);
  let o1 = order(await track(master1), 'SA-5001');
  assert.deepEqual([o1.received, o1.remaining], [3, 2], '3/5 received, 2/5 remaining');
  assert.equal(o1.articles[2].state, 'with_master');
  assert.equal(o1.articles[2].received_by, 'User u-m1');
  assert.equal(o1.articles[3].state, 'pending', 'the other articles were not touched');

  const second = await scan(master1, 'SA-5001-4'); // not assigned to anyone: the scanning master takes it
  assert.equal(second.ok, true, second.err?.message);
  o1 = order(await track(master1), 'SA-5001');
  assert.deepEqual([o1.received, o1.remaining], [4, 1]);
  assert.equal(o1.remaining_text, '1 article remaining to pick up');

  const again = await scan(master1, 'SA-5001-4');
  assert.equal(again.err.statusCode, 409, 'a duplicate scan is refused');
  o1 = order(await track(master1), 'SA-5001');
  assert.deepEqual([o1.received, o1.remaining], [4, 1], 'and does not change the count');
  assert.equal(db.table('unit_stage_receipts').filter((x) => x.unit_id === 'o1-u4').length, 1);
});

test('another master only gets the articles that are not assigned to someone else', async () => {
  // article 5 is unassigned: master two takes it, so it leaves master one's order
  assert.equal((await scan(master2, 'SA-5001-5')).ok, true);
  const one = order(await track(master1), 'SA-5001');
  assert.equal(one.total, 4, 'master one’s order lost the article master two took');
  // an article assigned to master one cannot be scanned by master two
  const refused = await scan(master2, 'SA-5001-3');
  assert.equal(refused.err.statusCode, 403);
  const mine = order(await track(master2), 'SA-5001');
  assert.deepEqual(mine.articles.map((a) => a.code), ['SA-5001-4', 'SA-5001-5'], 'master two sees their own article and the one nobody has taken, never master one’s');
});

test('masters never see each other’s teams', async () => {
  const two = await track(master2);
  assert.deepEqual(two.data.orders.map((o) => o.reference).sort(), ['SA-5002', 'SA-5003']);
  const o3 = order(two, 'SA-5003');
  assert.equal(o3.total, 1);
  assert.deepEqual(two.data.members.map((m) => m.name).sort(), ['Master Two', 'Tailor Two']);
  // a master cannot ask for another master's team
  const peek = await track(master1, { master_id: 'm2' });
  assert.equal(peek.data.master.id, 'm1', 'the request is ignored: they always get their own team');
});

test('a tailor sees only what is assigned to them', async () => {
  const r = await track(tailor1);
  assert.equal(r.ok, true, r.err?.message);
  assert.equal(r.data.viewer, 'tailor');
  assert.deepEqual(r.data.members.map((m) => m.name), ['Tailor One']);
  assert.deepEqual(r.data.orders.map((o) => o.reference), ['SA-5001']);
  const o1 = r.data.orders[0];
  assert.deepEqual([o1.total, o1.received, o1.remaining], [1, 1, 0]);
  assert.equal(o1.articles[0].code, 'SA-5001-2');
});

test('the partner owner chooses a master; a master from another partner is refused; strangers are refused', async () => {
  const list = await track(owner);
  assert.equal(list.data.viewer, 'manager');
  assert.deepEqual(list.data.masters.map((m) => m.name), ['Master One', 'Master Two'], 'only this partner’s masters');
  assert.equal(list.data.master.name, 'Master One', 'the first master is shown by default');
  const two = await track(owner, { master_id: 'm2' });
  assert.deepEqual(two.data.orders.map((o) => o.reference).sort(), ['SA-5002', 'SA-5003']);
  assert.equal((await track(owner, { master_id: 'mx' })).err.statusCode, 403);

  const qa = staff('u-qa', 'qa', ['production.view']);
  assert.equal((await track(qa)).err.statusCode, 403);
});
