/**
 * Article-level workflow: the rules for receiving by QR scan, and the customer's approve / reject / return loop,
 * run against the real service code with an in-memory database.
 *   npm run test:unit
 */
import { test, mock, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeDb } from './fake-supabase.mjs';
import {
  articleGroup, groupSummary, groupReference, resolveScanRole, checkReceive, articleState, orderReviewFlag, canCustomerSubmit, PREVIOUS_STAGE, STAGES, classifyForStage, progressFor, permissionForStage,
} from '../src/services/unit-flow.service.js';

// ───────────────────────── pure rules ─────────────────────────

test('every stage after to_assign has exactly one previous stage, in order', () => {
  assert.deepEqual(STAGES, ['to_assign', 'cutting', 'stitching', 'qc', 'pressing', 'packed']);
  assert.deepEqual(Object.keys(PREVIOUS_STAGE), ['cutting', 'stitching', 'qc', 'pressing', 'packed']);
  for (const [stage, prev] of Object.entries(PREVIOUS_STAGE)) assert.equal(STAGES.indexOf(prev) + 1, STAGES.indexOf(stage));
});

test('the stage is found from the person (staff type, team record, permissions); nobody picks it', () => {
  assert.deepEqual(resolveScanRole({ staffType: 'master' }).stage, 'cutting');
  assert.deepEqual(resolveScanRole({ staffType: 'tailor' }).stage, 'stitching');
  assert.deepEqual(resolveScanRole({ staffType: 'qa' }).stage, 'qc');
  assert.deepEqual(resolveScanRole({ staffType: 'pressing' }).stage, 'pressing');
  assert.deepEqual(resolveScanRole({ staffType: 'packing' }).stage, 'packed');
  assert.equal(resolveScanRole({ staffType: 'master' }).permission, 'production.scan');
  assert.equal(resolveScanRole({ staffType: 'qa' }).permission, 'quality.scan');
  // no manual choice: the stage comes from the person's own records
  assert.equal(resolveScanRole({ staffType: 'staff', memberRole: 'master' }).stage, 'cutting', 'a master on the board receives for cutting');
  assert.equal(resolveScanRole({ staffType: 'staff', memberRole: 'tailor' }).stage, 'stitching');
  assert.equal(resolveScanRole({ staffType: 'staff', qualityOnly: true }).stage, 'qc', 'only the quality permission means quality check');
  const sup = resolveScanRole({ isSupervisor: true });
  assert.equal(sup.ok, true);
  assert.equal(sup.role, 'supervisor');
  assert.equal(sup.stage, null, 'an owner / admin has no fixed stage: it follows the article');
  assert.equal(resolveScanRole({ staffType: 'staff' }).ok, false, 'generic staff cannot receive articles');
  assert.equal(resolveScanRole({}).ok, false);
});

const card = (over = {}) => ({ stage: 'to_assign', master_id: null, tailor_id: null, qc_passed: false, approval_status: 'none', ...over });

test('the master receives an unassigned article and is assigned to it; a second scan is a duplicate', () => {
  const ok = checkReceive({ role: 'master', stage: 'cutting', card: card(), member: { id: 'm1' } });
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.assign, { master_id: 'm1' });
  const again = checkReceive({ role: 'master', stage: 'cutting', card: card({ stage: 'cutting', master_id: 'm1' }), member: { id: 'm1' } });
  assert.equal(again.ok, false);
  assert.equal(again.code, 'duplicate');
});

test('an article assigned to another master cannot be received by this one', () => {
  const r = checkReceive({ role: 'master', stage: 'cutting', card: card({ master_id: 'someone-else' }), member: { id: 'm1' } });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'forbidden');
  const none = checkReceive({ role: 'master', stage: 'cutting', card: card({ master_id: 'someone-else' }), member: null });
  assert.equal(none.code, 'forbidden', 'a master with no team-member record cannot take an assigned article');
});

test('stages cannot be skipped: the tailor needs the master first, QA the tailor, pressing needs QC passed, packing needs pressing', () => {
  assert.equal(checkReceive({ role: 'tailor', stage: 'stitching', card: card({ stage: 'to_assign' }), member: { id: 't1' } }).code, 'invalid_transition');
  assert.equal(checkReceive({ role: 'tailor', stage: 'stitching', card: card({ stage: 'cutting', master_id: 'm1', stage_done: { at: 'x' } }), member: { id: 't1' } }).ok, true);
  assert.equal(checkReceive({ role: 'tailor', stage: 'stitching', card: card({ stage: 'cutting', master_id: 'm1' }), member: { id: 't1' } }).code, 'blocked', 'cutting has to be completed first');
  assert.equal(checkReceive({ role: 'supervisor', stage: 'stitching', card: card({ stage: 'cutting', master_id: 'm1' }), member: null }).ok, true, 'owner / admin override');
  assert.equal(checkReceive({ role: 'qa', stage: 'qc', card: card({ stage: 'cutting' }), member: null }).code, 'invalid_transition');
  assert.equal(checkReceive({ role: 'qa', stage: 'qc', card: card({ stage: 'stitching', stage_done: { at: 'x' } }), member: null }).ok, true);
  const notPassed = checkReceive({ role: 'pressing', stage: 'pressing', card: card({ stage: 'qc', qc_passed: false }), member: null });
  assert.equal(notPassed.ok, false);
  assert.equal(notPassed.code, 'blocked');
  assert.equal(checkReceive({ role: 'pressing', stage: 'pressing', card: card({ stage: 'qc', qc_passed: true, stage_done: { at: 'x' } }), member: null }).ok, true);
  assert.equal(checkReceive({ role: 'packing', stage: 'packed', card: card({ stage: 'qc', qc_passed: true }), member: null }).code, 'invalid_transition', 'packing cannot jump over pressing');
  assert.equal(checkReceive({ role: 'packing', stage: 'packed', card: card({ stage: 'pressing', qc_passed: true, stage_done: { at: 'x' } }), member: null }).ok, true);
});

test('an article waiting for the customer to approve its finished photos cannot move on', () => {
  const r = checkReceive({ role: 'pressing', stage: 'pressing', card: card({ stage: 'qc', qc_passed: true, approval_status: 'pending' }), member: null });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'blocked');
});

test('the article state shown to people', () => {
  const order = { status: 'received' };
  const u = (o = {}) => ({ status: 'received', review_status: 'none', return_status: 'none', ...o });
  assert.equal(articleState({ unit: u({ status: 'pending' }), order }), 'pending_receipt');
  assert.equal(articleState({ unit: u(), order }), 'received');
  assert.equal(articleState({ unit: u({ review_status: 'pending' }), order }), 'pending_approval');
  assert.equal(articleState({ unit: u({ review_status: 'approved' }), order }), 'approved');
  assert.equal(articleState({ unit: u({ review_status: 'rejected' }), order }), 'rejected');
  assert.equal(articleState({ unit: u({ review_status: 'rejected', return_status: 'requested' }), order }), 'return_requested');
  assert.equal(articleState({ unit: u({ status: 'pending', review_status: 'rejected', return_status: 'sent_back' }), order }), 'returned');
  assert.equal(articleState({ unit: u({ review_status: 'approved' }), card: { stage: 'stitching' }, order }), 'in_production');
  assert.equal(articleState({ unit: u({ review_status: 'approved' }), card: { stage: 'packed' }, order: { status: 'shipped' } }), 'completed');
  assert.equal(articleState({ unit: u({ status: 'issue' }), order }), 'issue');
});

test('one rejected article does not stop the order from being submitted, but an undecided one does', () => {
  const mix = [{ review_status: 'approved' }, { review_status: 'rejected' }, { review_status: 'approved' }];
  assert.equal(canCustomerSubmit(mix).ok, true);
  assert.equal(orderReviewFlag(mix), 'pending', 'the order is not fully approved while one article is rejected');
  assert.equal(canCustomerSubmit([{ review_status: 'approved' }, { review_status: 'pending' }]).ok, false);
  assert.equal(canCustomerSubmit([{ review_status: 'rejected' }]).ok, false, 'at least one approved article is needed');
  assert.equal(orderReviewFlag([{ review_status: 'approved' }, { review_status: 'approved' }]), 'approved');
  assert.equal(orderReviewFlag([{ review_status: 'none' }]), 'none');
});

// ───────────────────────── review / return loop on the real service ─────────────────────────

let db;
let review;
let orders;
const dbProxy = new Proxy({}, { get: (_, key) => db[key] });
const noop = async () => {};

before(async () => {
  mock.module('../src/config/supabase.js', { namedExports: { supabaseAdmin: dbProxy, supabase: dbProxy } });
  mock.module('../src/services/notification.service.js', { namedExports: { notifyAdmins: noop, notifyPartner: noop, notifyUser: noop, notifyUsers: noop, notifyStaff: noop, partnerRecipients: async () => [] } });
  review = await import('../src/services/unit-review.service.js');
  orders = await import('../src/services/order.service.js');
});

const ORDER = 'order-1';
const CUSTOMER = { id: 'cust-1', full_name: 'Test Customer', role: 'customer' };

/** An order of the given source with three received articles. */
const seed = (over = {}, unitOver = {}) => {
  db = createFakeDb({
    orders: [{ id: ORDER, reference: 'SA-2001', status: 'draft', order_source: 'email', details_completed_at: null, customer_id: CUSTOMER.id, partner_id: null, parcel_review: 'none', has_issue: false, priority: 'normal', due_date: null, customer_code: 'STX-1', parcel_received_at: new Date().toISOString(), ...over }],
    order_units: [1, 2, 3].map((n) => ({ id: `unit-${n}`, order_id: ORDER, line_no: n, code: `SA-2001-${n}`, unit_title: `Article ${n}`, status: 'received', review_status: 'none', return_status: 'none', resubmit_count: 0, ...unitOver })),
  });
};

beforeEach(() => seed());

const unit = (n) => db.table('order_units').find((u) => u.id === `unit-${n}`);
const order = () => db.table('orders')[0];
const events = (n) => db.table('order_unit_events').filter((e) => e.unit_id === `unit-${n}`).map((e) => e.status);
/** The partner reports a problem with an article at receiving: only then can the customer Hold or Return it. */
const reportIssue = (n) => Object.assign(unit(n), { status: 'issue', review_status: 'pending' });
const decide = (n, decision, note, returnTo) => {
  if (decision === 'reject' && unit(n).status !== 'issue') reportIssue(n); // the tests below reject articles the partner flagged
  return review.decideArticle({ order: order(), unit: { ...unit(n) }, decision, note, returnTo, profile: CUSTOMER });
};

test('when the parcel arrives every received article waits for its own decision', async () => {
  assert.equal(await review.startReview(ORDER, 'staff-1'), 3);
  assert.ok([1, 2, 3].every((n) => unit(n).review_status === 'pending'));
  assert.equal(order().parcel_review, 'pending');
  assert.deepEqual(events(1), ['review_requested']);
  assert.equal(await review.startReview(ORDER), 0, 'asking again changes nothing');
});

test('approving two articles and rejecting one: the approved ones go to production, the rejected one waits', async () => {
  await review.startReview(ORDER);

  await decide(1, 'approve');
  await decide(3, 'approve');
  await assert.rejects(() => decide(2, 'reject', ''), /why/i, 'a rejection needs a reason');
  assert.equal(unit(2).review_status, 'pending', 'a refused rejection changes nothing');
  await assert.rejects(() => decide(2, 'reject', 'Wrong colour'), /where the parcel should be returned/i, 'an email order asks where to send it');
  await decide(2, 'reject', 'Wrong colour', 'brand');

  assert.equal(unit(2).return_to, 'brand');
  assert.equal(unit(2).return_status, 'requested', 'a rejection also requests the return');
  assert.equal(unit(1).review_status, 'approved');
  assert.equal(unit(2).review_status, 'rejected');
  assert.equal(unit(2).review_note, 'Wrong colour');
  assert.equal(unit(3).review_status, 'approved');
  assert.equal(order().parcel_review, 'pending', 'the order is not fully approved');
  assert.equal(order().has_issue, true, 'a rejected article needs the team');
  assert.equal(db.table('job_cards').length, 0, 'a draft releases nothing');

  // the customer completes the order: it is no longer a draft and its details are done, so the approved articles enter production
  assert.equal(canCustomerSubmit(db.table('order_units')).ok, true);
  order().status = 'received';
  assert.equal(await review.releaseArticles(ORDER), 0, 'an email order waits for its details step');
  order().details_completed_at = new Date().toISOString();
  assert.equal(await review.releaseArticles(ORDER), 2);
  const carded = db.table('job_cards').map((c) => c.unit_id).sort();
  assert.deepEqual(carded, ['unit-1', 'unit-3']);
  assert.equal(await review.releaseArticles(ORDER), 0, 'releasing again makes no duplicate ticket');

  await assert.rejects(() => decide(1, 'approve'), /already/i, 'an article cannot be decided twice');
});

test('rejected article: return, sent back, corrected, approved again, then it joins production', async () => {
  await review.startReview(ORDER);
  await decide(1, 'approve');
  await decide(3, 'approve');
  await decide(2, 'reject', 'Torn at the hem', 'customer');
  order().status = 'received';
  order().details_completed_at = new Date().toISOString();
  await review.releaseArticles(ORDER);

  // the return was requested with the rejection; asking again changes nothing
  assert.equal(unit(2).return_status, 'requested');
  assert.equal(unit(2).return_to, 'customer');
  await assert.rejects(() => review.requestReturn({ order: order(), unit: { ...unit(1) }, profile: CUSTOMER }), /rejected/i, 'only a rejected article can be sent back');
  await assert.rejects(() => review.requestReturn({ order: order(), unit: { ...unit(2) }, profile: CUSTOMER }), /already/i);

  // staff send it back: it becomes "to receive" again
  await assert.rejects(() => review.markSentBack({ order: order(), unit: { ...unit(3) }, profile: { id: 's1' } }), /nobody asked/i);
  await review.markSentBack({ order: order(), unit: { ...unit(2) }, courier: 'TCS', tracking: '123', profile: { id: 's1' } });
  assert.equal(unit(2).return_status, 'sent_back');
  assert.equal(unit(2).status, 'pending');
  assert.equal(unit(2).return_tracking, '123');
  assert.equal(db.table('job_cards').length, 2, 'still no ticket for the returned article');

  // the corrected article is received again: the customer reviews it again
  unit(2).status = 'received';
  await review.resubmitCorrected({ order: order(), unit: { ...unit(2) }, actorId: 's1' });
  assert.equal(unit(2).review_status, 'pending');
  assert.equal(unit(2).return_status, 'resubmitted');
  assert.equal(unit(2).resubmit_count, 1);
  assert.equal(order().parcel_review, 'pending');

  await decide(2, 'approve');
  assert.equal(unit(2).review_status, 'approved');
  assert.equal(order().parcel_review, 'approved', 'every article is approved now');
  assert.deepEqual(db.table('job_cards').map((c) => c.unit_id).sort(), ['unit-1', 'unit-2', 'unit-3'], 'the corrected article joined production');
  assert.ok(events(2).includes('return_requested'));
  assert.deepEqual(events(2), ['review_requested', 'review_rejected', 'return_requested', 'returned', 'resubmitted', 'review_approved']);
});

test('approve all approves every waiting article at once', async () => {
  await review.startReview(ORDER);
  const r = await review.approveAllArticles({ order: order(), profile: CUSTOMER });
  assert.equal(r.approved, 3);
  assert.equal(order().parcel_review, 'approved');
  await assert.rejects(() => review.approveAllArticles({ order: order(), profile: CUSTOMER }), /No article/i);
});

// ───────────────────────── the three order sources ─────────────────────────

const cards = () => db.table('job_cards').map((c) => c.unit_id).sort();

test('CUSTOMER order: the parcel is reviewed, approved articles go straight to production, the return always goes to the customer', async () => {
  seed({ status: 'received', order_source: 'customer', parcel_received_at: new Date().toISOString() });
  await review.startReview(ORDER);
  assert.equal(cards().length, 0, 'nothing is in production while the parcel waits for its review');

  await decide(1, 'approve');
  assert.deepEqual(cards(), ['unit-1'], 'no articles step: an approved article enters production at once');

  // no choice of destination for a customer's own parcel; even a different request cannot send it elsewhere
  await decide(2, 'reject', 'Wrong fabric', 'brand');
  assert.equal(unit(2).return_to, 'customer');
  assert.equal(unit(2).return_status, 'requested');
  assert.deepEqual(cards(), ['unit-1'], 'a rejected article is not produced');

  await decide(3, 'approve');
  assert.deepEqual(cards(), ['unit-1', 'unit-3']);
  assert.ok(events(2).includes('return_requested'));
});

test('EMAIL order: approve, then the details step, only then production; a rejection asks brand or customer', async () => {
  seed({ status: 'draft', order_source: 'email', parcel_received_at: new Date().toISOString() });
  await review.startReview(ORDER);

  await decide(1, 'approve');
  await decide(3, 'approve');
  assert.equal(cards().length, 0, 'approved but the customer has not finished the articles / sizes / notes');

  await assert.rejects(() => decide(2, 'reject', 'Damaged', undefined), /Choose where/i);
  await assert.rejects(() => decide(2, 'reject', 'Damaged', 'nowhere'), /not available/i);
  await decide(2, 'reject', 'Damaged', 'brand');
  assert.equal(unit(2).return_to, 'brand');

  // the customer submits the draft with its details
  order().status = 'received';
  order().details_completed_at = new Date().toISOString();
  assert.equal(await review.releaseArticles(ORDER), 2);
  assert.deepEqual(cards(), ['unit-1', 'unit-3'], 'the rejected article stays out of production');
});

test('WEBSITE order: same approval, the details step after it, both return destinations are offered', async () => {
  seed({ status: 'received', order_source: 'website', parcel_received_at: new Date().toISOString() });
  await review.startReview(ORDER);
  await decide(1, 'approve');
  assert.equal(cards().length, 0, 'a website order finishes its details first');
  order().details_completed_at = new Date().toISOString();
  assert.equal(await review.releaseArticles(ORDER), 1);

  await decide(2, 'reject', 'Wrong size', 'customer');
  assert.equal(unit(2).return_to, 'customer');
});

test('rejecting the whole parcel records one reason and one destination for every waiting article', async () => {
  seed({ status: 'received', order_source: 'website', parcel_received_at: new Date().toISOString() });
  await review.startReview(ORDER);
  [1, 2, 3].forEach(reportIssue);
  await assert.rejects(() => review.rejectParcel({ order: order(), note: 'All wrong', profile: CUSTOMER }), /Choose where/i, 'a website parcel needs a destination');
  await assert.rejects(() => review.rejectParcel({ order: order(), note: '', returnTo: 'brand', profile: CUSTOMER }), /why/i);
  const r = await review.rejectParcel({ order: order(), note: 'All wrong', returnTo: 'brand', profile: CUSTOMER });
  assert.equal(r.rejected, 3);
  assert.ok([1, 2, 3].every((n) => unit(n).review_status === 'rejected' && unit(n).return_to === 'brand' && unit(n).return_status === 'requested'));
  assert.equal(order().has_issue, true);
  assert.equal(cards().length, 0, 'a rejected parcel never reaches production');

  // staff send it back, recording the destination in the history
  await review.markSentBack({ order: order(), unit: { ...unit(1) }, courier: 'TCS', tracking: '77', profile: { id: 'staff' } });
  assert.ok(events(1).includes('returned'));
  const note = db.table('order_unit_events').find((e) => e.unit_id === 'unit-1' && e.status === 'returned').note;
  assert.match(note, /To the brand/);
});

test('a customer cannot decide before the parcel was fully received', async () => {
  seed({ status: 'submitted', order_source: 'customer', parcel_received_at: null }, { review_status: 'pending' });
  await assert.rejects(() => decide(1, 'approve'), /still receiving/i);
});

test('receiving the last article of a customer order puts every article in front of the customer and holds production', async () => {
  seed({ status: 'submitted', order_source: 'customer' });
  const r = await orders.syncReceiving(ORDER, 'staff-1');
  assert.equal(r.pending, 0);
  assert.equal(order().status, 'received');
  assert.equal(order().parcel_review, 'pending');
  assert.ok(order().parcel_received_at);
  assert.ok([1, 2, 3].every((n) => unit(n).review_status === 'pending'));
  assert.equal(cards().length, 0, 'production waits for the customer');
});

test('a parcel that is not fully received yet is not shown to the customer', async () => {
  seed({ status: 'submitted', order_source: 'customer' });
  unit(3).status = 'pending';
  await orders.syncReceiving(ORDER, 'staff-1');
  assert.equal(order().status, 'submitted');
  assert.equal(order().parcel_review, 'none');
});

// ───────────────────────── receiving progress (the numbers on the receiving screen) ─────────────────────────

test('an article is classified for the stage of the person looking at it', () => {
  const unit = { id: 'u', review_status: 'approved' };
  const c = (over = {}) => ({ id: 'c', stage: 'to_assign', master_id: null, qc_passed: false, approval_status: 'none', ...over });
  assert.equal(classifyForStage({ stage: 'cutting', card: c(), unit, role: 'master', member: { id: 'm1' } }).kind, 'awaiting');
  assert.equal(classifyForStage({ stage: 'cutting', card: c({ stage: 'cutting' }), unit }).kind, 'received');
  assert.equal(classifyForStage({ stage: 'cutting', card: c({ stage: 'stitching' }), unit }).kind, 'done', 'moved on: already processed');
  assert.equal(classifyForStage({ stage: 'stitching', card: c(), unit }).kind, 'not_ready', 'the master has not received it yet');
  assert.equal(classifyForStage({ stage: 'cutting', card: c({ master_id: 'other' }), unit, role: 'master', member: { id: 'm1' } }).kind, 'assigned');
  assert.equal(classifyForStage({ stage: 'pressing', card: c({ stage: 'qc', qc_passed: false }), unit }).kind, 'not_ready');
  assert.equal(classifyForStage({ stage: 'cutting', card: null, unit: { review_status: 'pending' } }).kind, 'not_ready');
  assert.equal(permissionForStage('qc'), 'quality.scan');
});

test('five articles, three scanned: 3 of 5 received, 2 remaining, who received each', () => {
  const units = [1, 2, 3, 4, 5].map((n) => ({ id: `u${n}`, code: `SA-1-${n}`, line_no: n, unit_title: `Article ${n}`, review_status: 'approved' }));
  const cards = units.map((u, i) => ({ id: `c${i}`, unit_id: u.id, stage: i < 3 ? 'cutting' : 'to_assign', master_id: i < 3 ? 'm1' : null, qc_passed: false, approval_status: 'none' }));
  const receipts = [0, 1, 2].map((i) => ({ unit_id: `u${i + 1}`, stage: 'cutting', role: 'master', user_id: i === 2 ? 'other' : 'me', user_name: i === 2 ? 'Other Master' : 'Me', received_at: `2026-01-0${i + 1}` }));
  const p = progressFor({ order: { id: 'o', reference: 'SA-1' }, units, cards, receipts, stage: 'cutting', userId: 'me', member: { id: 'm1' }, role: 'master' });
  assert.deepEqual([p.total, p.received, p.remaining, p.awaiting, p.mine], [5, 3, 2, 2, 2]);
  assert.deepEqual(p.articles.map((a) => a.kind), ['received', 'received', 'received', 'awaiting', 'awaiting']);
  assert.equal(p.articles[2].received_by, 'Other Master');
  assert.equal(p.articles[0].mine, true);
  assert.equal(p.articles[2].mine, false);
  assert.match(p.next_action, /Scan 2 more articles for Cutting/);

  // the tailor's view of the same order: three are waiting for them, two are not ready yet (the master has not received them)
  // only articles the master completed (Scan to complete) can be taken: here the first two
  cards[0].stage_done = { at: 'x' }; cards[1].stage_done = { at: 'x' };
  const t = progressFor({ order: { id: 'o', reference: 'SA-1' }, units, cards, receipts: [], stage: 'stitching', userId: 'tailor', member: null, role: 'tailor' });
  assert.deepEqual(t.articles.map((a) => a.kind), ['awaiting', 'awaiting', 'not_ready', 'not_ready', 'not_ready']);
  assert.match(t.articles[2].reason, /not completed/i);
  assert.deepEqual([t.received, t.remaining], [0, 5]);
});


// ───────────────────────── hold / return groups and hold resolution ─────────────────────────

test('four articles: approved, approved, hold, return are shown as <ref>, <ref>-HOLD and <ref>-RETURN without duplicating anything', async () => {
  db = createFakeDb({
    orders: [{ id: ORDER, reference: 'SA-1001', status: 'received', order_source: 'customer', details_completed_at: new Date().toISOString(), customer_id: CUSTOMER.id, partner_id: null, parcel_review: 'none', has_issue: false, priority: 'normal', due_date: null, customer_code: 'STX-1', parcel_received_at: new Date().toISOString() }],
    order_units: [1, 2, 3, 4].map((n) => ({ id: `unit-${n}`, order_id: ORDER, line_no: n, code: `SA-1001-${n}`, unit_title: `Article ${n}`, status: 'received', review_status: 'none', return_status: 'none', resubmit_count: 0 })),
  });
  await review.startReview(ORDER);
  const holdIt = (n, note) => { reportIssue(n); return review.decideArticle({ order: order(), unit: { ...unit(n) }, decision: 'reject', note, action: 'hold', profile: CUSTOMER }); };
  await decide(1, 'approve');
  await decide(2, 'approve');
  await holdIt(3, 'Check the colour again');
  await decide(4, 'reject', 'Torn', 'customer');

  const units = db.table('order_units');
  assert.equal(units.length, 4, 'no article was duplicated');
  assert.equal(db.table('orders').length, 1, 'no order was duplicated');
  assert.deepEqual(units.map(articleGroup), ['main', 'main', 'hold', 'return']);
  assert.deepEqual(groupSummary('SA-1001', units).map((g) => [g.reference, g.count]), [['SA-1001', 2], ['SA-1001-HOLD', 1], ['SA-1001-RETURN', 1]]);
  assert.equal(groupReference('SA-1001', 'resolved'), 'SA-1001-RESOLVED');
  assert.equal(unit(3).return_status, 'held');
  assert.equal(unit(3).review_status, 'rejected');
  assert.equal(articleState({ unit: unit(3), card: null, order: order() }), 'on_hold');
  // hold and returned articles are not released into production; the approved ones are
  assert.deepEqual(db.table('job_cards').map((c) => c.unit_id).sort(), ['unit-1', 'unit-2']);

  // the Return group never gets the corrected-article action
  await assert.rejects(() => review.receiveCorrectedHold({ order: order(), unit: { ...unit(4) }, profile: { id: 'staff-1' } }), /only an article on hold/i);
  // a hold is received by the partner first ...
  await review.receiveCorrectedHold({ order: order(), unit: { ...unit(3) }, note: 'Hem fixed', profile: { id: 'staff-1' } });
  assert.equal(unit(3).review_status, 'pending');
  assert.ok(unit(3).hold_received_at);
  assert.equal(unit(3).return_status, 'held', 'still in the hold group until the customer approves');
  assert.equal(articleGroup(unit(3)), 'hold');
  assert.equal(articleState({ unit: unit(3), card: null, order: order() }), 'pending_approval');
  assert.equal(db.table('job_cards').length, 2, 'not released before the customer approves');
  await assert.rejects(() => review.receiveCorrectedHold({ order: order(), unit: { ...unit(3) }, profile: { id: 'staff-1' } }), /already received/i, 'receiving twice changes nothing');

  // ... then the customer approves: the hold is resolved, exactly once
  await decide(3, 'approve');
  assert.equal(unit(3).review_status, 'approved');
  assert.equal(unit(3).return_status, 'none');
  assert.ok(unit(3).hold_resolved_at);
  assert.equal(articleGroup(unit(3)), 'resolved');
  assert.deepEqual(groupSummary('SA-1001', db.table('order_units')).map((g) => g.reference), ['SA-1001', 'SA-1001-RETURN', 'SA-1001-RESOLVED']);
  assert.deepEqual(db.table('job_cards').map((c) => c.unit_id).sort(), ['unit-1', 'unit-2', 'unit-3'], 'the resolved article joined production');
  await assert.rejects(() => decide(3, 'approve'), /already/i, 'approving again does not resolve twice');
  assert.equal(events(3).filter((e) => e === 'hold_resolved').length, 1);
  assert.deepEqual(events(3), ['review_requested', 'review_held', 'hold_received', 'hold_resolved', 'review_approved']);
  // the returned article stays separate
  assert.equal(articleGroup(unit(4)), 'return');
});

test('a corrected hold article that the customer rejects again goes back to the hold or return group, never to resolved', async () => {
  db = createFakeDb({
    orders: [{ id: ORDER, reference: 'SA-1002', status: 'received', order_source: 'customer', details_completed_at: new Date().toISOString(), customer_id: CUSTOMER.id, partner_id: null, parcel_review: 'none', has_issue: false, priority: 'normal', due_date: null, customer_code: 'STX-1', parcel_received_at: new Date().toISOString() }],
    order_units: [{ id: 'unit-1', order_id: ORDER, line_no: 1, code: 'SA-1002-1', unit_title: 'Article 1', status: 'received', review_status: 'none', return_status: 'none', resubmit_count: 0 }],
  });
  await review.startReview(ORDER);
  reportIssue(1);
  await review.decideArticle({ order: order(), unit: { ...unit(1) }, decision: 'reject', note: 'Not sure', action: 'hold', profile: CUSTOMER });
  await review.receiveCorrectedHold({ order: order(), unit: { ...unit(1) }, profile: { id: 'staff-1' } });
  reportIssue(1); // the partner reports the problem again on the corrected article
  await review.decideArticle({ order: order(), unit: { ...unit(1) }, decision: 'reject', note: 'Still wrong', action: 'hold', profile: CUSTOMER });
  assert.equal(unit(1).hold_received_at, null, 'a new hold starts a new correction');
  assert.equal(articleGroup(unit(1)), 'hold');
  await review.receiveCorrectedHold({ order: order(), unit: { ...unit(1) }, profile: { id: 'staff-1' } });
  reportIssue(1);
  await review.decideArticle({ order: order(), unit: { ...unit(1) }, decision: 'reject', note: 'Send it back', returnTo: 'customer', profile: CUSTOMER });
  assert.equal(articleGroup(unit(1)), 'return');
  assert.equal(unit(1).hold_resolved_at ?? null, null);
});


// ───────────────────────── customer options follow the partner's reported problem ─────────────────────────

test('an article without a reported problem can be approved OR rejected (Hold / Return); one with a reported problem is only held or returned', async () => {
  await review.startReview(ORDER);
  // no problem reported on article 1: the customer may still reject it
  assert.equal(articleState({ unit: unit(1), card: null, order: order() }), 'pending_approval');
  const returned = await review.decideArticle({ order: order(), unit: { ...unit(1) }, decision: 'reject', note: 'I do not like the finish', returnTo: 'brand', profile: CUSTOMER });
  assert.equal(returned.state, 'rejected');
  assert.equal(unit(1).return_status, 'requested');
  const held = await review.decideArticle({ order: order(), unit: { ...unit(2) }, decision: 'reject', note: 'Let me check first', action: 'hold', profile: CUSTOMER });
  assert.equal(held.state, 'held');
  assert.equal(unit(2).return_status, 'held');
  await decide(3, 'approve');
  assert.equal(unit(3).review_status, 'approved');

  // a problem the partner reported cannot be approved: Hold or Return
  seed();
  await review.startReview(ORDER);
  reportIssue(2);
  assert.equal(articleState({ unit: unit(2), card: null, order: order() }), 'issue');
  await assert.rejects(() => decide(2, 'approve'), /Hold or Return/i, 'a reported problem cannot be approved');
  // approve all skips the article with a reported problem
  await review.approveAllArticles({ order: order(), profile: CUSTOMER });
  assert.equal(unit(2).review_status, 'pending');
  assert.equal(unit(3).review_status, 'approved');
  const held2 = await review.decideArticle({ order: order(), unit: { ...unit(2) }, decision: 'reject', note: 'Wait, I will check', action: 'hold', profile: CUSTOMER });
  assert.equal(held2.state, 'held');
  assert.equal(articleState({ unit: unit(2), card: null, order: order() }), 'on_hold', 'it follows the hold path, not "issue"');
  assert.equal(db.table('job_cards').length, 0);
});

test('a reported problem can be decided before the whole parcel is received, and the customer chooses Return', async () => {
  // the parcel is not fully received yet (no parcel_received_at), but article 1 has a problem the partner reported
  order().parcel_received_at = null;
  reportIssue(1);
  const res = await review.decideArticle({ order: order(), unit: { ...unit(1) }, decision: 'reject', note: 'Torn', returnTo: 'customer', profile: CUSTOMER });
  assert.equal(res.state, 'rejected');
  assert.equal(unit(1).return_status, 'requested');
  assert.equal(unit(1).return_to, 'customer');
  // an article without a problem still waits for the parcel to be received
  unit(2).status = 'received';
  unit(2).review_status = 'pending';
  await assert.rejects(() => decide(2, 'approve'), /still receiving/i);
});

test('the partner reporting a problem puts the article in front of the customer once', async () => {
  const u = () => ({ ...unit(1) });
  unit(1).status = 'issue';
  const first = await review.requestIssueDecision({ order: order(), unit: u(), actorId: 'staff-1' });
  assert.equal(first.already, false);
  assert.equal(unit(1).review_status, 'pending');
  assert.equal((await review.requestIssueDecision({ order: order(), unit: u(), actorId: 'staff-1' })).already, true, 'reporting twice does not ask twice');
  assert.equal(events(1).filter((e) => e === 'review_requested').length, 1);
});
