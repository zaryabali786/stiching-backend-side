/**
 * "Client approval required after QC" (platform_settings 'qc_client_approval') through the real production controller with an
 * in-memory database: ON the customer must approve before Pressing, OFF QC goes straight to Pressing, and nothing already
 * recorded is rewritten when the switch changes.
 *   npm run test:unit
 */
import { test, mock, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeDb } from './fake-supabase.mjs';
import { approvalHold, checkReceive } from '../src/services/unit-flow.service.js';

let db;
let controller;
let qc;
const dbProxy = new Proxy({}, { get: (_, key) => db[key] });
const noop = async () => {};

before(async () => {
  mock.module('../src/config/supabase.js', { namedExports: { supabaseAdmin: dbProxy, supabase: dbProxy } });
  mock.module('../src/services/notification.service.js', { namedExports: { notifyAdmins: noop, notifyPartner: noop, notifyUser: noop, notifyUsers: noop, notifyStaff: noop, partnerRecipients: async () => [] } });
  mock.module('../src/services/team.service.js', { namedExports: { suggestAssignees: async () => ({ master: null, tailor: null }), getTeamWithLoad: async () => ({ masters: [], members: [] }) } });
  mock.module('../src/realtime/io.js', {
    namedExports: {
      emitTo: () => {}, getIO: () => null, setIO: () => {},
      rooms: { user: (id) => `user:${id}`, order: (id) => `order:${id}`, admins: 'admins', partner: (id) => `partner:${id}`, production: (id) => `production:${id}` },
    },
  });
  controller = await import('../src/controllers/production.controller.js');
  qc = await import('../src/services/qc-approval.service.js');
});

const ORDER = 'o1';
const setting = (required) => db.table('platform_settings').splice(0, 99, ...(required === undefined ? [] : [{ key: 'qc_client_approval', value: { required } }]));
const cardRow = (n, over = {}) => ({ id: `card${n}`, order_id: ORDER, unit_id: `u${n}`, partner_id: 'p1', stage: 'qc', position: n * 1024, qc_passed: true, approval_status: 'none', unit_title: `Article ${n}`, ...over });

beforeEach(() => {
  db = createFakeDb({
    platform_settings: [],
    orders: [{ id: ORDER, reference: 'SA-4001', status: 'qc_passed', customer_id: 'c1', partner_id: 'p1' }],
    order_units: [1, 2].map((n) => ({ id: `u${n}`, order_id: ORDER, line_no: n, code: `SA-4001-${n}`, unit_title: `Article ${n}`, status: 'received', review_status: 'approved', return_status: 'none' })),
    job_cards: [cardRow(1), cardRow(2)],
  });
});

const call = (fn, req) =>
  new Promise((resolve) => {
    const res = { status() { return this; }, json: (payload) => resolve({ ok: true, ...payload }) };
    fn({ userId: 'u-qa', profile: { id: 'u-qa', full_name: 'QA Person' }, body: {}, query: {}, ...req }, res, (err) => resolve({ ok: false, err }));
  });
const toPressing = () => call(controller.sendOrderToPressing, { params: { orderId: ORDER } });
const card = (n) => db.table('job_cards').find((c) => c.id === `card${n}`);

test('nothing saved: approval is required (the safe default)', async () => {
  assert.deepEqual(await qc.loadQcApproval(), { required: true });
  assert.equal(await qc.isQcApprovalRequired(), true);
});

test('the setting is saved and read back', async () => {
  assert.deepEqual(await qc.saveQcApproval(false, 'admin1'), { required: false });
  assert.equal(await qc.isQcApprovalRequired(), false);
  assert.deepEqual(await qc.saveQcApproval(true, 'admin1'), { required: true });
  assert.equal(db.table('platform_settings').length, 1, 'one row, updated in place');
});

test('ON: QC cannot send an article to Pressing before the customer approved its photos', async () => {
  setting(true);
  const r = await toPressing();
  assert.equal(r.ok, false);
  assert.match(r.err.message, /approval/i);
  assert.equal(card(1).stage, 'qc');
});

test('ON: only the approved article goes on to Pressing, a pending one blocks the order', async () => {
  setting(true);
  db.table('job_cards')[0].approval_status = 'approved';
  assert.equal((await toPressing()).ok, true);
  assert.equal(card(1).stage, 'pressing');
  assert.equal(card(2).stage, 'qc', 'the one without approval stays in QC');
  db.table('job_cards')[1].approval_status = 'pending';
  const blocked = await toPressing();
  assert.equal(blocked.ok, false);
  assert.match(blocked.err.message, /Waiting for the customer/);
});

test('OFF: QC sends every passed article straight to Pressing, with no photos and no approval', async () => {
  setting(false);
  const r = await toPressing();
  assert.equal(r.ok, true, r.err?.message);
  assert.equal(r.data.moved, 2);
  assert.equal(card(1).stage, 'pressing');
  assert.equal(card(1).approval_status, 'none', 'no approval is invented');
});

test('OFF: an approval that was already waiting is not blocking and is not rewritten', async () => {
  setting(false);
  db.table('job_cards')[0].approval_status = 'pending';
  db.table('job_cards')[0].approval_photos = ['x.jpg'];
  const r = await toPressing();
  assert.equal(r.ok, true, r.err?.message);
  assert.equal(card(1).stage, 'pressing');
  assert.equal(card(1).approval_status, 'pending', 'the record stays as it was (not auto-approved)');
  assert.deepEqual(card(1).approval_photos, ['x.jpg']);
});

test('OFF: QC cannot send photos to the customer; ON it can', async () => {
  setting(false);
  const off = await call(controller.requestCardApproval, { params: { id: 'card1' }, body: { photos: [{ name: 'a.jpg', dataUrl: 'data:image/jpeg;base64,AAAA' }] } });
  assert.equal(off.ok, false);
  assert.match(off.err.message, /switched off/i);
  assert.equal(card(1).approval_status, 'none');
});

test('the rule on its own: required / off / the older behaviour', () => {
  const qcCard = { stage: 'qc', approval_status: 'none' };
  assert.match(approvalHold(qcCard, true), /approval/);
  assert.equal(approvalHold({ ...qcCard, approval_status: 'approved' }, true), null);
  assert.match(approvalHold({ ...qcCard, approval_status: 'changes_requested' }, true), /changes/);
  assert.equal(approvalHold({ ...qcCard, approval_status: 'pending' }, false), null);
  assert.equal(approvalHold(qcCard, undefined), null, 'older rule: only a waiting request blocks');
  assert.match(approvalHold({ ...qcCard, approval_status: 'pending' }, undefined), /waiting/);
});

test('scan receive for Pressing follows the same rule', () => {
  const base = { role: 'supervisor', stage: 'pressing', member: null, card: { stage: 'qc', qc_passed: true, approval_status: 'none', stage_done: true } };
  assert.equal(checkReceive({ ...base, approvalRequired: true }).ok, false);
  assert.equal(checkReceive({ ...base, approvalRequired: false }).ok, true);
  assert.equal(checkReceive({ ...base, card: { ...base.card, approval_status: 'approved' }, approvalRequired: true }).ok, true);
});
