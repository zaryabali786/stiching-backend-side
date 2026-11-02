/**
 * Customer reviews: the Delivered hook schedules ONE invitation per order (national / international days from Settings, counted from
 * the real delivery time), the timer sends it once, retries failures, never sends for ineligible orders or after a review, and the
 * review itself is one per order and only by the order's own customer.
 *   npm run test:unit
 */
import { test, mock, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeDb } from './fake-supabase.mjs';

let db;
let svc;
let orderSvc;
let mail;
let notes = [];
const dbProxy = new Proxy({}, { get: (_, key) => db[key] });
const noop = async () => {};

before(async () => {
  mock.module('../src/config/supabase.js', { namedExports: { supabaseAdmin: dbProxy, supabase: dbProxy } });
  mock.module('../src/services/transactional-email.service.js', { namedExports: { sendTransactionalEmail: async (m) => mail.handler(m) } });
  mock.module('../src/services/notification.service.js', { namedExports: { notifyAdmins: noop, notifyPartner: noop, notifyUser: async (id, n) => { notes.push({ id, ...n }); }, notifyUsers: noop, notifyStaff: noop, partnerRecipients: async () => [] } });
  mock.module('../src/realtime/io.js', {
    namedExports: {
      emitTo: () => {}, getIO: () => null, setIO: () => {},
      rooms: { user: (id) => `user:${id}`, order: (id) => `order:${id}`, admins: 'admins', partner: (id) => `partner:${id}`, production: (id) => `production:${id}` },
    },
  });
  orderSvc = await import('../src/services/order.service.js');
  svc = await import('../src/services/review.service.js');
});

const DELIVERED = '2026-11-02T10:00:00.000Z';
const order = (over = {}) => ({ id: 'o1', reference: 'SA-1001', status: 'shipped', order_kind: 'normal', customer_id: 'c1', destination_country: 'Pakistan', delivered_at: null, ...over });

beforeEach(() => {
  notes = [];
  mail = { sent: [], handler: async (m) => { mail.sent.push(m); return { sent: true }; } };
  db = createFakeDb(
    {
      platform_settings: [],
      orders: [order(), order({ id: 'o2', reference: 'SA-1002', destination_country: 'United Kingdom' })],
      profiles: [
        { id: 'c1', full_name: 'Ayesha Khan', email: 'ayesha@example.com', country: 'Pakistan' },
        { id: 'c2', full_name: 'Bilal Raza', email: 'bilal@example.com', country: 'Pakistan' },
      ],
      review_invitations: [],
      order_reviews: [],
    },
    { uniques: { review_invitations: { when: () => true, key: (r) => r.order_id }, order_reviews: { when: () => true, key: (r) => r.order_id } } },
  );
});

const deliver = (id) => orderSvc.setOrderStatus(id, 'delivered', { extra: { delivered_at: DELIVERED } });
const setSettings = (value) => db.table('platform_settings').splice(0, 99, { key: 'review_settings', value });
const invitations = () => db.table('review_invitations');

test('1 national order: due 3 days after delivery (Nov 2 -> Nov 5)', async () => {
  await deliver('o1');
  assert.equal(invitations().length, 1);
  assert.equal(invitations()[0].customer_type, 'national');
  assert.equal(invitations()[0].scheduled_at, '2026-11-05T10:00:00.000Z');
  assert.equal(invitations()[0].delivered_at, DELIVERED);
  assert.equal(invitations()[0].status, 'pending');
});

test('2 international order: due 7 days after delivery (Nov 2 -> Nov 9)', async () => {
  await deliver('o2');
  assert.equal(invitations()[0].customer_type, 'international');
  assert.equal(invitations()[0].scheduled_at, '2026-11-09T10:00:00.000Z');
});

test('days come from Settings, not from the code', async () => {
  setSettings({ nationalEnabled: true, nationalReviewDays: 10, internationalEnabled: true, internationalReviewDays: 1 });
  await deliver('o1');
  await deliver('o2');
  assert.equal(invitations().find((i) => i.order_id === 'o1').scheduled_at, '2026-11-12T10:00:00.000Z');
  assert.equal(invitations().find((i) => i.order_id === 'o2').scheduled_at, '2026-11-03T10:00:00.000Z');
});

test('D: scheduling twice (status written again) keeps one invitation', async () => {
  const o = await deliver('o1');
  await svc.scheduleReviewInvitation(o);
  await svc.scheduleReviewInvitation(o);
  await deliver('o1');
  assert.equal(invitations().length, 1);
});

test('12 a return order, a cancelled order and a customer without email get no invitation', async () => {
  db.table('orders').push(order({ id: 'o3', reference: 'SA-R1', order_kind: 'return', status: 'delivered' }));
  assert.equal(await svc.scheduleReviewInvitation(db.table('orders').find((o) => o.id === 'o3')), null);
  assert.equal(await svc.scheduleReviewInvitation(order({ status: 'cancelled' })), null);
  db.table('profiles')[0].email = null;
  await deliver('o1');
  assert.equal(invitations().length, 0);
});

test('3/9 the email goes out once when due, never before, never twice', async () => {
  await deliver('o1');
  await svc.processDueInvitations(new Date('2026-11-04T10:00:00.000Z'));
  assert.equal(mail.sent.length, 0);
  const r = await svc.processDueInvitations(new Date('2026-11-05T10:00:01.000Z'));
  assert.equal(r.sent, 1);
  assert.equal(mail.sent.length, 1);
  assert.equal(mail.sent[0].to, 'ayesha@example.com');
  assert.equal(mail.sent[0].subject, "We'd Love to Hear About Your Stitching Experience!");
  assert.match(mail.sent[0].html, /Write a Review/);
  assert.match(mail.sent[0].html, /SA-1001/);
  assert.equal(invitations()[0].status, 'sent');
  assert.ok(invitations()[0].sent_at);
  await svc.processDueInvitations(new Date('2026-11-06T10:00:00.000Z'));
  assert.equal(mail.sent.length, 1);
});

test('the review link is signed: it names the invitation, a changed one is refused', async () => {
  await deliver('o1');
  await svc.processDueInvitations(new Date('2026-11-06T00:00:00.000Z'));
  const url = mail.sent[0].text.match(/https?:\/\/\S+/)[0];
  const token = decodeURIComponent(url.split('/review/')[1]);
  assert.equal(svc.readReviewToken(token), invitations()[0].id);
  assert.equal(svc.readReviewToken(`${token.slice(0, -1)}x`), null);
  assert.equal(svc.readReviewToken(`${invitations()[0].id}.forged`), null);
  assert.equal(svc.readReviewToken('o1'), null);
  assert.doesNotMatch(url, /ayesha|SA-1001/);
});

test('10 disabled review emails are not sent; enabling them again sends the ones still due', async () => {
  setSettings({ nationalEnabled: false, nationalReviewDays: 3, internationalEnabled: true, internationalReviewDays: 7 });
  await deliver('o1');
  await svc.processDueInvitations(new Date('2026-11-06T00:00:00.000Z'));
  assert.equal(mail.sent.length, 0);
  assert.equal(invitations()[0].status, 'pending');
  setSettings({ nationalEnabled: true, nationalReviewDays: 3, internationalEnabled: true, internationalReviewDays: 7 });
  await svc.processDueInvitations(new Date('2026-11-07T00:00:00.000Z'));
  assert.equal(mail.sent.length, 1);
});

test('an invitation due for more than 14 days is dropped instead of sent late', async () => {
  setSettings({ nationalEnabled: false, nationalReviewDays: 3, internationalEnabled: true, internationalReviewDays: 7 });
  await deliver('o1');
  setSettings({ nationalEnabled: true, nationalReviewDays: 3, internationalEnabled: true, internationalReviewDays: 7 });
  await svc.processDueInvitations(new Date('2026-12-30T00:00:00.000Z'));
  assert.equal(mail.sent.length, 0);
  assert.equal(invitations()[0].status, 'cancelled');
  assert.equal(invitations()[0].cancel_reason, 'expired');
});

test('C/11 changing the days re-dates waiting invitations and never touches a sent one', async () => {
  await deliver('o1');
  await deliver('o2');
  await svc.processDueInvitations(new Date('2026-11-05T11:00:00.000Z')); // o1 sent
  const out = await svc.saveReviewSettings({ nationalEnabled: true, nationalReviewDays: 1, internationalEnabled: true, internationalReviewDays: 14 }, 'admin1');
  assert.equal(out.redated, 1);
  const o1 = invitations().find((i) => i.order_id === 'o1');
  const o2 = invitations().find((i) => i.order_id === 'o2');
  assert.equal(o1.status, 'sent');
  assert.equal(o1.scheduled_at, '2026-11-05T10:00:00.000Z');
  assert.equal(o2.scheduled_at, '2026-11-16T10:00:00.000Z');
  await svc.processDueInvitations(new Date('2026-11-20T00:00:00.000Z'));
  assert.equal(mail.sent.length, 2); // o1 only once
});

test('settings are validated', async () => {
  await assert.rejects(svc.saveReviewSettings({ nationalEnabled: true, nationalReviewDays: -1, internationalEnabled: true, internationalReviewDays: 7 }, 'a'), /whole number/);
  await assert.rejects(svc.saveReviewSettings({ nationalEnabled: true, nationalReviewDays: 3, internationalEnabled: true, internationalReviewDays: 1.5 }, 'a'), /whole number/);
  await assert.rejects(svc.saveReviewSettings({ nationalEnabled: 'yes', nationalReviewDays: 3, internationalEnabled: true, internationalReviewDays: 7 }, 'a'), /true or false/);
  assert.deepEqual(await svc.loadReviewSettings(), { nationalEnabled: true, nationalReviewDays: 3, internationalEnabled: true, internationalReviewDays: 7 });
});

test('16 a failed send is retried (15 min, 1 h, 4 h) and then marked failed', async () => {
  mail.handler = async () => ({ sent: false, reason: 'rejected', detail: 'mailbox full' });
  await deliver('o1');
  let now = new Date('2026-11-05T10:00:01.000Z');
  await svc.processDueInvitations(now);
  let inv = invitations()[0];
  assert.equal(inv.status, 'pending');
  assert.equal(inv.retry_count, 1);
  assert.equal(inv.last_error, 'mailbox full');
  assert.equal(inv.next_attempt_at, new Date(now.getTime() + 15 * 60000).toISOString());
  await svc.processDueInvitations(new Date(now.getTime() + 60000)); // too early
  assert.equal(invitations()[0].retry_count, 1);
  for (const mins of [20, 90, 300]) {
    now = new Date(now.getTime() + mins * 60000);
    await svc.processDueInvitations(now);
  }
  inv = invitations()[0];
  assert.equal(inv.status, 'failed');
  assert.equal(inv.retry_count, 4);
  assert.equal(mail.sent.length, 0);
});

test('a retry that works afterwards marks it sent', async () => {
  let fail = true;
  mail.handler = async (m) => (fail ? { sent: false, reason: 'rejected', detail: 'down' } : (mail.sent.push(m), { sent: true }));
  await deliver('o1');
  await svc.processDueInvitations(new Date('2026-11-05T10:00:01.000Z'));
  fail = false;
  await svc.processDueInvitations(new Date('2026-11-05T10:20:00.000Z'));
  assert.equal(invitations()[0].status, 'sent');
  assert.equal(mail.sent.length, 1);
});

test('email not configured is not counted as a failure', async () => {
  mail.handler = async () => ({ sent: false, reason: 'not_configured' });
  await deliver('o1');
  await svc.processDueInvitations(new Date('2026-11-05T10:00:01.000Z'));
  assert.equal(invitations()[0].retry_count, 0);
  assert.equal(invitations()[0].status, 'pending');
});

test('E a review given before the email cancels the invitation, and nothing is sent', async () => {
  await deliver('o1');
  await svc.submitReview({ orderId: 'o1', customerId: 'c1', rating: 5, comment: 'Perfect fit' });
  assert.equal(invitations()[0].status, 'cancelled');
  assert.equal(invitations()[0].cancel_reason, 'already_reviewed');
  await svc.processDueInvitations(new Date('2026-11-09T00:00:00.000Z'));
  assert.equal(mail.sent.length, 0);
});

test('5/6/7 a customer can give 5 stars, 1 star, and a comment', async () => {
  await deliver('o1');
  await deliver('o2');
  const a = await svc.submitReview({ orderId: 'o1', customerId: 'c1', rating: 5, comment: '  Lovely work  ' });
  assert.equal(a.review.rating, 5);
  assert.equal(a.review.comment, 'Lovely work');
  const b = await svc.submitReview({ orderId: 'o2', customerId: 'c1', rating: '1' });
  assert.equal(b.review.rating, 1);
  assert.equal(b.review.comment, null);
  assert.equal(db.table('order_reviews').find((r) => r.order_id === 'o1').customer_type, 'national');
  assert.equal(db.table('order_reviews').find((r) => r.order_id === 'o2').customer_type, 'international');
});

test('8 a second review for the same order is refused', async () => {
  await deliver('o1');
  await svc.submitReview({ orderId: 'o1', customerId: 'c1', rating: 4 });
  await assert.rejects(svc.submitReview({ orderId: 'o1', customerId: 'c1', rating: 1 }), (e) => e.statusCode === 409);
  assert.equal(db.table('order_reviews').length, 1);
});

test('13 nobody can review another customer order, or an order not yet delivered', async () => {
  await deliver('o1');
  await assert.rejects(svc.submitReview({ orderId: 'o1', customerId: 'c2', rating: 5 }), (e) => e.statusCode === 404);
  await assert.rejects(svc.reviewStateForOrder('o1', 'c2'), (e) => e.statusCode === 404);
  // o2 is still "shipped"
  await assert.rejects(svc.submitReview({ orderId: 'o2', customerId: 'c1', rating: 5 }), (e) => e.statusCode === 403);
  assert.equal(db.table('order_reviews').length, 0);
});

test('rating and comment are validated', async () => {
  await deliver('o1');
  for (const rating of [0, 6, 2.5, 'x', null, undefined]) await assert.rejects(svc.submitReview({ orderId: 'o1', customerId: 'c1', rating }), (e) => e.statusCode === 400);
  await assert.rejects(svc.submitReview({ orderId: 'o1', customerId: 'c1', rating: 3, comment: 'x'.repeat(2001) }), (e) => e.statusCode === 400);
  await assert.rejects(svc.submitReview({ orderId: 'o1', customerId: 'c1', rating: 3, comment: { a: 1 } }), (e) => e.statusCode === 400);
});

test('4 the link opens the right order, then shows the review read-only', async () => {
  await deliver('o1');
  await svc.processDueInvitations(new Date('2026-11-06T00:00:00.000Z'));
  const token = decodeURIComponent(mail.sent[0].text.match(/\/review\/(\S+)/)[1]);
  const before = await svc.reviewStateByToken(token);
  assert.equal(before.order.reference, 'SA-1001');
  assert.equal(before.customer_name, 'Ayesha');
  assert.equal(before.reviewable, true);
  assert.equal(before.review, null);
  await svc.submitReviewByToken(token, { rating: 4, comment: 'Good' });
  const after = await svc.reviewStateByToken(token);
  assert.equal(after.review.rating, 4);
  await assert.rejects(svc.submitReviewByToken(token, { rating: 1 }), (e) => e.statusCode === 409);
  await assert.rejects(svc.reviewStateByToken('nonsense'), (e) => e.statusCode === 404);
});

test('14 the admin list is filtered by type, stars and date, and the summary counts them', async () => {
  await deliver('o1');
  await deliver('o2');
  db.table('orders')[1].customer_id = 'c2';
  await svc.submitReview({ orderId: 'o1', customerId: 'c1', rating: 5, comment: 'a' });
  await svc.submitReview({ orderId: 'o2', customerId: 'c2', rating: 1, comment: 'b' });
  const all = await svc.listReviews({});
  assert.equal(all.total, 2);
  const row = all.rows.find((r) => r.order_id === 'o1');
  assert.equal(row.customer.email, 'ayesha@example.com');
  assert.equal(row.order.reference, 'SA-1001');
  assert.equal(row.delivered_at, DELIVERED);
  assert.deepEqual((await svc.listReviews({ type: 'international' })).rows.map((r) => r.rating), [1]);
  assert.deepEqual((await svc.listReviews({ rating: '5' })).rows.map((r) => r.order_id), ['o1']);
  assert.equal((await svc.listReviews({ from: '2999-01-01' })).total, 0);
  assert.equal((await svc.listReviews({ search: 'nobody-matches-this' })).total, 0);
  const sum = await svc.reviewSummary({});
  assert.deepEqual({ total: sum.total, average: sum.average, five: sum.five_star, one: sum.one_star }, { total: 2, average: 3, five: 1, one: 1 });
  assert.deepEqual(sum.distribution, { 1: 1, 2: 0, 3: 0, 4: 0, 5: 1 });
  assert.equal((await svc.reviewSummary({ type: 'national' })).average, 5);
  assert.equal((await svc.getReview(row.id)).customer.full_name, 'Ayesha Khan');
  await assert.rejects(svc.getReview('not-a-uuid'), (e) => e.statusCode === 404);
});

test('the email is followed by one bell notification and push that opens the order review page', async () => {
  await deliver('o1');
  await svc.processDueInvitations(new Date('2026-11-05T10:00:01.000Z'));
  await svc.processDueInvitations(new Date('2026-11-06T10:00:01.000Z'));
  assert.equal(notes.length, 1);
  assert.equal(notes[0].id, 'c1');
  assert.equal(notes[0].type, 'review');
  assert.equal(notes[0].link, '/app/orders/o1/review');
  assert.match(notes[0].body, /SA-1001/);
});

test('a failed email sends no notification', async () => {
  mail.handler = async () => ({ sent: false, reason: 'rejected', detail: 'down' });
  await deliver('o1');
  await svc.processDueInvitations(new Date('2026-11-05T10:00:01.000Z'));
  assert.equal(notes.length, 0);
});
