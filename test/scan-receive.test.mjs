/**
 * QR receiving through the real production controller (scanReceive) with an in-memory database:
 * roles, permissions, assignment, stage order, duplicates, per-article receipts and the real-time broadcast.
 *   npm run test:unit
 */
import { expandPermissions } from '../src/config/permissions.js';
import { test, mock, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeDb } from './fake-supabase.mjs';

let db;
let controller;
let emitted;
const dbProxy = new Proxy({}, { get: (_, key) => db[key] });
const noop = async () => {};

before(async () => {
  mock.module('../src/config/supabase.js', { namedExports: { supabaseAdmin: dbProxy, supabase: dbProxy } });
  mock.module('../src/services/notification.service.js', { namedExports: { notifyAdmins: noop, notifyPartner: noop, notifyUser: noop, notifyStaff: noop, partnerRecipients: async () => [] } });
  mock.module('../src/services/team.service.js', { namedExports: { suggestAssignees: async () => ({ master: null, tailor: null }), getTeamWithLoad: async () => ({ masters: [], members: [] }) } });
  mock.module('../src/realtime/io.js', {
    namedExports: {
      emitTo: (room, event, payload) => emitted.push({ room, event, payload }),
      getIO: () => null,
      setIO: () => {},
      rooms: { user: (id) => `user:${id}`, order: (id) => `order:${id}`, admins: 'admins', partner: (id) => `partner:${id}`, production: (id) => `production:${id}` },
    },
  });
  controller = await import('../src/controllers/production.controller.js');
});

const PARTNER = 'p1';
const ORDER = 'o1';

beforeEach(() => {
  emitted = [];
  db = createFakeDb({
    orders: [{ id: ORDER, reference: 'SA-3001', status: 'received', customer_id: 'c1', partner_id: PARTNER, priority: 'normal', customer_code: 'STX-1' }],
    order_units: [1, 2, 3].map((n) => ({ id: `u${n}`, order_id: ORDER, line_no: n, code: `SA-3001-${n}`, unit_title: `Article ${n}`, status: 'received', review_status: 'approved', return_status: 'none' })),
    job_cards: [1, 2, 3].map((n) => ({ id: `card${n}`, order_id: ORDER, unit_id: `u${n}`, partner_id: PARTNER, stage: 'to_assign', position: n * 1024, master_id: null, tailor_id: null, qc_passed: false, approval_status: 'none', unit_title: `Article ${n}` })),
    team_members: [
      { id: 'm1', name: 'Master One', role: 'master', user_id: 'u-master1', partner_id: PARTNER, is_active: true },
      { id: 'm2', name: 'Master Two', role: 'master', user_id: 'u-master2', partner_id: PARTNER, is_active: true },
      { id: 't1', name: 'Tailor One', role: 'tailor', user_id: 'u-tailor1', partner_id: PARTNER, is_active: true },
    ],
  });
});

const card = (n) => db.table('job_cards').find((c) => c.id === `card${n}`);
const receipts = (unitId) => db.table('unit_stage_receipts').filter((r) => r.unit_id === unitId);

/** Staff the way the API sees them. */
const person = (userId, staffType, permissions, over = {}) => ({
  userId,
  profile: { id: userId, full_name: `User ${userId}`, email: `${userId}@t.dev`, staff_type: staffType, partner_role: 'member', ...over },
  access: { isAdmin: false, partnerId: PARTNER, permissions: new Set(expandPermissions(permissions)) },
});
const master1 = person('u-master1', 'master', ['production.update', 'production.view']);
const master2 = person('u-master2', 'master', ['production.update', 'production.view']);
const tailor = person('u-tailor1', 'tailor', ['production.update', 'production.view']);
const qa = person('u-qa', 'qa', ['quality.update', 'production.view']);
const pressing = person('u-press', 'pressing', ['production.update', 'production.view']);
const packing = person('u-pack', 'packing', ['production.update', 'production.view']);

/** Call the handler like Express does and return { data, message } or the error it passed on. */
const scan = (who, code, extra = {}) =>
  new Promise((resolve) => {
    const req = { ...who, body: { code, ...extra }, query: {}, params: {} };
    const res = { status() { return this; }, json: (payload) => resolve({ ok: true, ...payload }) };
    controller.scanReceive(req, res, (err) => resolve({ ok: false, err }));
  });

/** Scan to complete: the holder of the article marks their stage finished. */
const complete = (who, code) =>
  new Promise((resolve) => {
    const req = { ...who, body: { code }, query: {}, params: {} };
    const res = { status() { return this; }, json: (payload) => resolve({ ok: true, ...payload }) };
    controller.scanComplete(req, res, (err) => resolve({ ok: false, err }));
  });

test('the master scans an article: it moves to Cutting, the receipt names who and when, everyone is told', async () => {
  const r = await scan(master1, 'SA-3001-1');
  assert.equal(r.ok, true, r.err?.message);
  assert.equal(card(1).stage, 'cutting');
  assert.equal(card(1).master_id, 'm1', 'the receiving master took it');
  const [rec] = receipts('u1');
  assert.equal(rec.stage, 'cutting');
  assert.equal(rec.role, 'master');
  assert.equal(rec.user_id, 'u-master1');
  assert.equal(rec.team_member_id, 'm1');
  assert.ok(rec.received_at, 'the time is saved');

  const live = emitted.filter((e) => e.event === 'unit:update');
  assert.deepEqual(live.map((e) => e.room).sort(), ['admins', 'production:p1', 'user:c1'], 'the customer, the admins and the partner production team');
  assert.equal(live[0].payload.code, 'SA-3001-1');
  assert.equal(live[0].payload.stage, 'cutting');
  assert.equal(live[0].payload.receivedBy, 'User u-master1');
});

test('a second scan of the same article is refused as a duplicate and records nothing', async () => {
  await scan(master1, 'SA-3001-1');
  emitted = [];
  const again = await scan(master1, 'sa-3001-1'); // the code is not case sensitive
  assert.equal(again.ok, false);
  assert.equal(again.err.statusCode, 409);
  assert.match(again.err.message, /already received/i);
  assert.equal(receipts('u1').length, 1);
  assert.equal(emitted.length, 0, 'nothing is broadcast for a refused scan');
});

test('each article has its own receipt: three articles, three different people, three different stages', async () => {
  assert.equal((await scan(master1, 'SA-3001-1')).ok, true);
  assert.equal((await scan(master1, 'SA-3001-2')).ok, true, 'one master can receive several articles of the same order');
  assert.equal(card(1).stage, 'cutting');
  assert.equal(card(2).stage, 'cutting');
  assert.equal(card(3).stage, 'to_assign', 'article 3 is still waiting');

  assert.equal((await complete(master1, 'SA-3001-1')).ok, true);
  assert.equal((await scan(tailor, 'SA-3001-1')).ok, true);
  assert.equal(card(1).stage, 'stitching');
  assert.equal(card(1).tailor_id, 't1');
  assert.equal(card(2).stage, 'cutting', 'article 2 stays where it is');
  assert.deepEqual(receipts('u1').map((r) => r.stage), ['cutting', 'stitching']);
  assert.deepEqual(receipts('u2').map((r) => r.stage), ['cutting']);
  assert.equal(receipts('u3').length, 0);
});

test('stages cannot be skipped and the wrong person is refused', async () => {
  // the tailor cannot take an article the master has not cut
  const early = await scan(tailor, 'SA-3001-1');
  assert.equal(early.err.statusCode, 409);
  assert.match(early.err.message, /after Cutting/i);
  assert.equal(card(1).stage, 'to_assign');

  // an article assigned to master one cannot be received by master two
  card(2).master_id = 'm1';
  const stolen = await scan(master2, 'SA-3001-2');
  assert.equal(stolen.err.statusCode, 403);
  assert.match(stolen.err.message, /assigned to another master/i);
  assert.equal(card(2).stage, 'to_assign');
  assert.equal((await scan(master1, 'SA-3001-2')).ok, true, 'its own master can');
});

test('QA, pressing and packing follow in order; pressing needs QC passed', async () => {
  await scan(master1, 'SA-3001-1');
  await complete(master1, 'SA-3001-1');
  await scan(tailor, 'SA-3001-1');
  await complete(tailor, 'SA-3001-1');
  assert.equal((await scan(qa, 'SA-3001-1')).ok, true);
  assert.equal(card(1).stage, 'qc');

  const notPassed = await scan(pressing, 'SA-3001-1');
  assert.equal(notPassed.ok, false);
  assert.equal(notPassed.err.statusCode, 400);
  assert.match(notPassed.err.message, /not passed quality check/i);

  card(1).qc_passed = true;
  assert.equal((await scan(pressing, 'SA-3001-1')).err.statusCode, 400, 'quality check has to be completed first');
  assert.equal((await complete(qa, 'SA-3001-1')).ok, true);
  assert.equal((await scan(pressing, 'SA-3001-1')).ok, true);
  assert.equal(card(1).stage, 'pressing');
  await complete(pressing, 'SA-3001-1');

  const skip = await scan(packing, 'SA-3001-2'); // article 2 never got past to_assign
  assert.equal(skip.err.statusCode, 409);

  assert.equal((await scan(packing, 'SA-3001-1')).ok, true);
  assert.equal(card(1).stage, 'packed');
  assert.deepEqual(receipts('u1').map((r) => `${r.stage}:${r.role}`), ['cutting:master', 'stitching:tailor', 'qc:qa', 'pressing:pressing', 'packed:packing']);
});

test('staff without the right type or permission cannot receive anything', async () => {
  const generic = person('u-staff', 'staff', ['production.update']);
  const a = await scan(generic, 'SA-3001-1');
  assert.equal(a.err.statusCode, 403);
  assert.match(a.err.message, /not set up to receive/i);

  const noPermission = person('u-master1', 'master', ['production.view']);
  const b = await scan(noPermission, 'SA-3001-1');
  assert.equal(b.err.statusCode, 403);

  const qaWithoutQuality = person('u-qa', 'qa', ['production.update']);
  assert.equal((await scan(qaWithoutQuality, 'SA-3001-1')).err.statusCode, 403, 'QA needs the quality permission');
  assert.equal(card(1).stage, 'to_assign');
  assert.equal(db.table('unit_stage_receipts').length, 0);

  // another partner's article
  const other = person('u-master1', 'master', ['production.update']);
  other.access.partnerId = 'someone-else';
  const c = await scan(other, 'SA-3001-1');
  assert.equal(c.err.statusCode, 403);
  assert.match(c.err.message, /another partner/i);
});

test('an owner or admin picks no stage: the article goes into the stage after its own; an order QR shows its progress', async () => {
  const owner = person('u-owner', null, ['production.update', 'quality.update'], { partner_role: 'owner' });
  const first = await scan(owner, 'SA-3001-1');
  assert.equal(first.ok, true, first.err?.message);
  assert.equal(card(1).stage, 'cutting');
  assert.equal(receipts('u1')[0].role, 'supervisor');
  assert.equal(receipts('u1')[0].stage, 'cutting');
  const second = await scan(owner, 'SA-3001-1');
  assert.equal(second.ok, true, 'the next scan moves it on to the following stage');
  assert.equal(card(1).stage, 'stitching');

  const quiet = person('u-owner2', null, ['production.view'], { partner_role: 'owner' });
  const refused = await scan(quiet, 'SA-3001-2');
  assert.equal(refused.err.statusCode, 403, 'the permission for that stage is still needed');
  assert.equal(card(2).stage, 'to_assign');

  const byOrder = await scan(master1, 'SA-3001');
  assert.equal(byOrder.ok, true);
  assert.equal(byOrder.data.kind, 'order');
  assert.equal(byOrder.data.progress.awaiting, 2, 'articles 2 and 3 still wait for the master');

  // article 3 waits for the customer's approval: it has no ticket yet
  db.table('job_cards').splice(2, 1);
  db.table('order_units')[2].review_status = 'pending';
  const held = await scan(master1, 'SA-3001-3');
  assert.equal(held.err.statusCode, 400);
  assert.match(held.err.message, /waiting for the customer to approve/i);
});

test('an unknown code is refused', async () => {
  const r = await scan(master1, 'NOPE-1');
  assert.equal(r.err.statusCode, 400);
  assert.match(r.err.message, /No article or order/i);
});

// ───────────────────────── the receiving screen: remaining articles, per stage, live ─────────────────────────

const receivingList = (who) =>
  new Promise((resolve) => {
    const req = { ...who, body: {}, query: {}, params: {} };
    const res = { status() { return this; }, json: (payload) => resolve({ ok: true, ...payload }) };
    controller.getProductionReceiving(req, res, (err) => resolve({ ok: false, err }));
  });

/** An order of five articles. */
const fiveArticles = () => {
  db.table('order_units').splice(0, 3, ...[1, 2, 3, 4, 5].map((n) => ({ id: `u${n}`, order_id: ORDER, line_no: n, code: `SA-3001-${n}`, unit_title: `Article ${n}`, status: 'received', review_status: 'approved', return_status: 'none' })));
  db.table('job_cards').splice(0, 3, ...[1, 2, 3, 4, 5].map((n) => ({ id: `card${n}`, order_id: ORDER, unit_id: `u${n}`, partner_id: PARTNER, stage: 'to_assign', position: n * 1024, master_id: null, tailor_id: null, qc_passed: false, approval_status: 'none', unit_title: `Article ${n}` })));
};

test('five articles: every scan receives ONE article and the remaining count follows, with no refresh', async () => {
  fiveArticles();
  const r1 = await scan(master1, 'SA-3001-1');
  assert.equal(r1.ok, true, r1.err?.message);
  assert.equal(r1.data.progress.total, 5);
  assert.equal(r1.data.progress.received, 1, 'one scan, one article');
  assert.equal(r1.data.progress.remaining, 4);
  assert.deepEqual(r1.data.progress.articles.map((a) => a.kind), ['received', 'awaiting', 'awaiting', 'awaiting', 'awaiting']);
  assert.equal(card(2).stage, 'to_assign', 'the other articles were not touched');

  await scan(master1, 'SA-3001-2');
  const r3 = await scan(master1, 'SA-3001-3');
  assert.deepEqual([r3.data.progress.received, r3.data.progress.remaining, r3.data.progress.mine], [3, 2, 3]);
  assert.match(r3.message, /3 of 5 received/);
  assert.equal(r3.data.progress.articles[0].received_by, 'User u-master1');

  // a duplicate neither adds a receipt nor changes the numbers
  const again = await scan(master1, 'SA-3001-3');
  assert.equal(again.err.statusCode, 409);
  assert.equal(db.table('unit_stage_receipts').length, 3);

  // after a refresh / reopening the screen the same progress comes back from the database
  const list = await receivingList(master1);
  assert.equal(list.ok, true, list.err?.message);
  assert.equal(list.data.stage, 'cutting');
  assert.equal(list.data.supervisor, false);
  const [entry] = list.data.orders;
  assert.deepEqual([entry.total, entry.received, entry.remaining, entry.awaiting], [5, 3, 2, 2]);

  // the other master sees the same order: the articles are not theirs to take back, the count still shows what was received
  const other = await receivingList(master2);
  assert.deepEqual([other.data.orders[0].received, other.data.orders[0].mine], [3, 0]);
});

test('articles of one order at different stages are tracked on their own, each person sees their stage only', async () => {
  fiveArticles();
  await scan(master1, 'SA-3001-1');
  await scan(master1, 'SA-3001-2');
  await complete(master1, 'SA-3001-1');
  await scan(tailor, 'SA-3001-1'); // article 1 moved on to stitching, article 2 is at cutting, 3-5 wait

  const masters = (await receivingList(master1)).data.orders[0];
  assert.deepEqual(masters.articles.map((a) => a.kind), ['done', 'received', 'awaiting', 'awaiting', 'awaiting'], 'article 1 is processed for the master, 2 is still with them');
  const tailors = (await receivingList(tailor)).data.orders[0];
  assert.equal(tailors.stage, 'stitching');
  assert.deepEqual(tailors.articles.map((a) => a.kind), ['received', 'not_ready', 'not_ready', 'not_ready', 'not_ready'], 'article 2 is still being cut: the tailor cannot take it');
  await complete(tailor, 'SA-3001-1');
  const qaView = await receivingList(qa);
  assert.equal(qaView.data.stage, 'qc');
  assert.equal(qaView.data.orders.length, 1, 'article 1 is stitched and completed, so quality check has one article waiting');
  assert.deepEqual(qaView.data.orders[0].articles.map((a) => a.kind), ['awaiting', 'not_ready', 'not_ready', 'not_ready', 'not_ready']);
});

test('the stage comes from the person: a master on the board, a quality-only login; unknown accounts are refused', async () => {
  const boardMaster = person('u-master1', 'staff', ['production.update', 'production.view']); // generic type, but a master on the board
  assert.equal((await scan(boardMaster, 'SA-3001-1')).ok, true);
  assert.equal(card(1).stage, 'cutting');
  assert.equal(receipts('u1')[0].role, 'master');

  await complete(boardMaster, 'SA-3001-1');
  await scan(tailor, 'SA-3001-1');
  await complete(tailor, 'SA-3001-1');
  const qualityOnly = person('u-q', 'staff', ['quality.update', 'production.view']);
  assert.equal((await scan(qualityOnly, 'SA-3001-1')).ok, true);
  assert.equal(card(1).stage, 'qc');
  assert.equal(receipts('u1')[2].role, 'qa');

  const nobody = person('u-nobody', 'staff', ['production.view']);
  assert.equal((await receivingList(nobody)).err.statusCode, 403);
});

// ───────────────────────── Scan to complete ─────────────────────────

test('scan to complete: the stitching person cannot take an article until the master completed cutting', async () => {
  await scan(master1, 'SA-3001-1');
  const early = await scan(tailor, 'SA-3001-1');
  assert.equal(early.ok, false);
  assert.match(early.err.message, /not completed in Cutting/i);
  assert.equal(card(1).stage, 'cutting');

  const done = await complete(master1, 'SA-3001-1');
  assert.equal(done.ok, true, done.err?.message);
  assert.equal(card(1).stage, 'cutting', 'completing does not move the article, the next person receives it');
  assert.ok(done.data.card.stage_done?.at, 'the card shows it is completed');
  assert.match(db.table('job_card_comments').at(-1).body, /Cutting completed by User u-master1/);

  assert.equal((await scan(tailor, 'SA-3001-1')).ok, true);
  assert.equal(card(1).stage, 'stitching');
  // entering the next stage clears the mark: the tailor has not completed anything yet
  assert.equal((await scan(qa, 'SA-3001-1')).ok, false);
});

test('scan to complete is refused for the wrong person, twice, or before receiving', async () => {
  assert.match((await complete(master1, 'SA-3001-1')).err.message, /not been received/i);
  await scan(master1, 'SA-3001-1');
  assert.equal((await complete(master2, 'SA-3001-1')).err.statusCode, 403, 'another master');
  assert.equal((await complete(tailor, 'SA-3001-1')).err.statusCode, 403, 'the tailor does not complete cutting');
  assert.equal((await complete(master1, 'SA-3001-1')).ok, true);
  const again = await complete(master1, 'SA-3001-1');
  assert.equal(again.err.statusCode, 409);
  assert.match(again.err.message, /already completed/i);
});

test('quality check completes only after QC passed; an owner may complete and receive over the gate', async () => {
  await scan(master1, 'SA-3001-1'); await complete(master1, 'SA-3001-1');
  await scan(tailor, 'SA-3001-1'); await complete(tailor, 'SA-3001-1');
  await scan(qa, 'SA-3001-1');
  assert.match((await complete(qa, 'SA-3001-1')).err.message, /not passed quality check/i);
  card(1).qc_passed = true;
  assert.equal((await complete(qa, 'SA-3001-1')).ok, true);

  const owner = person('u-owner', null, ['production.update', 'quality.update'], { partner_role: 'owner' });
  await scan(master1, 'SA-3001-2'); // article 2 is in cutting and NOT completed
  const over = await scan(owner, 'SA-3001-2');
  assert.equal(over.ok, true, 'the owner moves it on without the completion');
  assert.equal(card(2).stage, 'stitching');
  assert.equal((await complete(owner, 'SA-3001-2')).ok, true, 'the owner completes any stage');
});
