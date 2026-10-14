/**
 * Email -> order workflow, run against the real service code with an in-memory database.
 *   npm run test:unit
 * Only two things are replaced: the database (fake-supabase.mjs) and the AI reader (its answer is set per test).
 */
import { test, mock, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeDb } from './fake-supabase.mjs';

const TOKEN = 'abcdef0123456789';
const CUSTOMER = 'cust-1';

let db;
let aiAnswer;
const freshDb = () =>
  createFakeDb(
    {
      profiles: [{ id: CUSTOMER, inbound_email_token: TOKEN, full_name: 'Test Customer', email: 'c@test.dev', customer_code: 'STX-0001', country: 'United Kingdom', city: 'London', address: '1 Road' }],
      couriers: [
        { id: 'courier-dhl', name: 'DHL', status: 'active', requires_tracking: true },
        { id: 'courier-tcs', name: 'TCS', status: 'active', requires_tracking: false },
      ],
      brands: [{ id: 'brand-sapphire', name: 'Sapphire', status: 'active' }],
    },
    {
      // the migration's unique index: one email-created order per (customer, brand order number)
      uniques: {
        orders: {
          when: (o) => o.import_source === 'email' && o.brand_order_number && o.status !== 'cancelled',
          key: (o) => `${o.customer_id}|${String(o.brand_order_number).trim().toLowerCase()}`,
        },
      },
    }
  );

const dbProxy = new Proxy({}, { get: (_, key) => db[key] });

let mod; // order-import.service
let match; // email-order-match.service

before(async () => {
  mock.module('../src/config/supabase.js', {
    // one stable object that always forwards to the current test's database
    namedExports: { supabaseAdmin: dbProxy, supabase: dbProxy },
  });
  mock.module('../src/services/ai.service.js', {
    namedExports: {
      isAiConfigured: () => true,
      isAiReadable: () => false,
      extractOrderWithAi: async () => structuredClone(aiAnswer),
      normaliseExtracted: (x) => x,
      httpUrl: (v) => (typeof v === 'string' && /^https?:\/\//.test(v) ? v : null),
    },
  });
  mock.module('../src/services/email-images.service.js', { namedExports: { attachProductImages: async () => {} } });
  mod = await import('../src/services/order-import.service.js');
  match = await import('../src/services/email-order-match.service.js');
});

beforeEach(() => {
  db = freshDb();
});

const extraction = (over = {}) => ({ is_order: true, brand: 'Sapphire', order_number: null, order_date: null, currency: 'PKR', total: null, tracking_number: null, courier_name: null, items: [], ...over });
const item = (title, quantity, unit_price) => ({ title, quantity, unit_price, sku: null, url: `https://shop.test/${title.replace(/\W/g, '-')}`, image_url: null, notes: null });

let msg = 0;
/** Deliver one email the way the mail provider does, and wait until its background reading has finished. */
const deliver = async ({ subject = 'Your order', messageId = `m-${++msg}`, date = new Date().toUTCString(), answer }) => {
  aiAnswer = answer;
  const result = await mod.receiveForwardedEmail({
    From: 'Sapphire <orders@sapphireonline.pk>', To: `${TOKEN}@mail.test.dev`, MailboxHash: TOKEN, Subject: subject, MessageID: messageId, Date: date, TextBody: `${subject}\nOrder details inside`, HtmlBody: '',
  });
  for (let i = 0; i < 100 && db.table('order_imports').some((r) => r.status === 'processing'); i++) await new Promise((r) => setTimeout(r, 5));
  await new Promise((r) => setTimeout(r, 20));
  return result;
};

const orders = () => db.table('orders');
const units = (orderId) => db.table('order_units').filter((u) => u.order_id === orderId);
const inbox = () => db.table('inbox_emails');

const confirmation = () => extraction({ order_number: 'SP-482913', total: 41960, items: [item('Lawn Suit A', 2, 8990), item('Cambric Shirt B', 3, 5000)] });

// ───────────── article records per unit ─────────────

test('an order made from an email gets one article record per unit of each product', async () => {
  await deliver({ subject: 'Order SP-482913 confirmed', answer: confirmation() });
  assert.equal(orders().length, 1);
  const order = orders()[0];
  const rows = units(order.id);
  assert.equal(rows.length, 5, 'A x2 + B x3 = 5 articles');
  assert.equal(rows.filter((u) => u.unit_title === 'Lawn Suit A').length, 2);
  assert.equal(rows.filter((u) => u.unit_title === 'Cambric Shirt B').length, 3);
  assert.ok(rows.every((u) => u.quantity === 1 && u.order_id === order.id), 'each article is quantity 1 and linked to the order');
  assert.deepEqual(rows.map((u) => u.line_no), [1, 2, 3, 4, 5]);
  assert.equal(rows.filter((u) => u.unit_title === 'Lawn Suit A').every((u) => u.unit_price === 8990), true, 'unit price stays per unit');
  const total = rows.reduce((sum, u) => sum + u.unit_price * u.quantity, 0);
  assert.equal(total, 2 * 8990 + 3 * 5000, 'line totals still add up');
  assert.equal(order.brand_order_total, 41960, 'the brand total on the order is untouched');
});

test('the order starts at the central location with no partner, courier or tracking', async () => {
  await deliver({ answer: confirmation() });
  const order = orders()[0];
  assert.equal(order.partner_id, null);
  assert.equal(order.courier_id, null);
  assert.equal(order.tracking_number, null);
  assert.equal(order.status, 'draft');
  assert.equal(order.import_source, 'email', 'the creation source is recorded on the order');
});

test('the same email delivered twice creates no second order or articles', async () => {
  await deliver({ messageId: 'dup-1', answer: confirmation() });
  const second = await deliver({ messageId: 'dup-1', answer: confirmation() });
  assert.equal(second.duplicate, true);
  assert.equal(orders().length, 1);
  assert.equal(units(orders()[0].id).length, 5);
  assert.equal(inbox().length, 1);
});

test('a re-sent confirmation (new message id) updates the order instead of duplicating it', async () => {
  await deliver({ answer: confirmation() });
  await deliver({ answer: confirmation() });
  assert.equal(orders().length, 1, 'still one order');
  assert.equal(units(orders()[0].id).length, 5, 'still five articles');
  assert.equal(inbox().filter((e) => e.match_status === 'matched').length, 1);
});

test('an order cannot hold more than 30 articles; the rest is reported, not silently lost', async () => {
  const { units: made, dropped } = mod.expandItemsToUnits([item('A', 20, 1), item('B', 20, 1)]);
  assert.equal(made.length, 30);
  assert.equal(dropped, 10);
});

test('two different emails about one order number racing each other still make one order', async () => {
  aiAnswer = confirmation();
  const send = (id) => mod.receiveForwardedEmail({ From: 'Sapphire <o@s.pk>', To: `${TOKEN}@mail.test.dev`, MailboxHash: TOKEN, Subject: 'Order SP-482913', MessageID: id, Date: new Date().toUTCString(), TextBody: 'x', HtmlBody: '' });
  await Promise.all([send('race-1'), send('race-2')]);
  for (let i = 0; i < 100 && db.table('order_imports').some((r) => r.status === 'processing'); i++) await new Promise((r) => setTimeout(r, 5));
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(orders().length, 1);
  assert.equal(units(orders()[0].id).length, 5);
});

// ───────────── follow-up emails ─────────────

const withOrder = async () => {
  await deliver({ subject: 'Order SP-482913 confirmed', answer: confirmation() });
  return orders()[0];
};

test('a follow-up email saves the courier and tracking id on the matching order', async () => {
  const order = await withOrder();
  await deliver({ subject: 'Your order has shipped', answer: extraction({ order_number: '#SP-482913', courier_name: 'DHL Express', tracking_number: '1Z999AA10123456784' }) });
  assert.equal(orders().length, 1, 'no second order');
  const updated = orders()[0];
  assert.equal(updated.id, order.id);
  assert.equal(updated.courier_id, 'courier-dhl', 'the courier from the list is matched by name');
  assert.equal(updated.tracking_number, '1Z999AA10123456784');
  assert.equal(units(order.id).length, 5, 'articles are untouched');
  const email = inbox().at(-1);
  assert.equal(email.match_status, 'matched');
  assert.equal(email.order_id, order.id);
  assert.equal(db.table('order_events').filter((e) => e.order_id === order.id).length, 1, 'one timeline entry');
});

test('the same follow-up delivered again changes nothing and adds no second timeline entry', async () => {
  const order = await withOrder();
  const ship = () => extraction({ order_number: 'SP-482913', courier_name: 'DHL', tracking_number: '1Z 999 AA1 0123456784' });
  await deliver({ answer: ship() });
  const stamp = orders()[0].shipping_updated_at;
  await deliver({ answer: ship() });
  assert.equal(orders().length, 1);
  assert.equal(orders()[0].shipping_updated_at, stamp);
  assert.equal(db.table('order_events').filter((e) => e.order_id === order.id).length, 1);
  assert.equal(db.table('notifications').filter((n) => /Tracking added/.test(n.title)).length, 1, 'the customer is told once');
});

test('an older email never overwrites the shipping details from a newer one', async () => {
  await withOrder();
  await deliver({ date: new Date('2026-10-02T10:00:00Z').toUTCString(), answer: extraction({ order_number: 'SP-482913', courier_name: 'DHL', tracking_number: 'NEW-TRACK-2' }) });
  await deliver({ date: new Date('2026-10-01T10:00:00Z').toUTCString(), answer: extraction({ order_number: 'SP-482913', courier_name: 'TCS', tracking_number: 'OLD-TRACK-1' }) });
  assert.equal(orders()[0].tracking_number, 'NEW-TRACK-2');
  assert.equal(orders()[0].courier_id, 'courier-dhl');
});

test('a newer email with a corrected tracking id updates the order', async () => {
  await withOrder();
  await deliver({ date: new Date('2026-10-01T10:00:00Z').toUTCString(), answer: extraction({ order_number: 'SP-482913', courier_name: 'DHL', tracking_number: 'FIRST-TRACK-1' }) });
  await deliver({ date: new Date('2026-10-03T10:00:00Z').toUTCString(), answer: extraction({ order_number: 'SP-482913', tracking_number: 'FIXED-TRACK-9' }) });
  assert.equal(orders()[0].tracking_number, 'FIXED-TRACK-9');
  assert.equal(orders()[0].courier_id, 'courier-dhl', 'a courier missing from the newer email is kept');
});

test('a courier that is not in the list is kept by name', async () => {
  await withOrder();
  await deliver({ answer: extraction({ order_number: 'SP-482913', courier_name: 'Fastex Logistics', tracking_number: 'FX123456789' }) });
  assert.equal(orders()[0].courier_id, null);
  assert.equal(orders()[0].courier_name, 'Fastex Logistics');
  assert.equal(orders()[0].tracking_number, 'FX123456789');
});

test('no order number: the email is flagged for review and nothing is changed or created', async () => {
  const order = await withOrder();
  const before = JSON.stringify(orders());
  await deliver({ subject: 'Your parcel is on its way', answer: extraction({ order_number: null, courier_name: 'DHL', tracking_number: '1Z999AA10123456784' }) });
  assert.equal(JSON.stringify(orders()), before, 'the order is untouched');
  assert.equal(orders().length, 1);
  const email = inbox().at(-1);
  assert.equal(email.match_status, 'review');
  assert.equal(email.order_id ?? null, null);
  assert.match(email.match_note, /order number/i);
  assert.equal(units(order.id).length, 5);
});

test('an order number that matches several orders is flagged, not guessed', async () => {
  db.table('orders').push(
    { id: 'o-a', customer_id: CUSTOMER, reference: 'STX-A', brand: 'Sapphire', brand_order_number: 'SP-777', status: 'submitted', import_source: 'manual' },
    { id: 'o-b', customer_id: CUSTOMER, reference: 'STX-B', brand: 'Sapphire', brand_order_number: 'sp777', status: 'submitted', import_source: 'manual' }
  );
  await deliver({ answer: extraction({ order_number: 'SP-777', courier_name: 'TCS', tracking_number: 'TCS-123456' }) });
  assert.equal(inbox().at(-1).match_status, 'review');
  assert.match(inbox().at(-1).match_note, /matches 2/);
  assert.ok(orders().every((o) => !o.tracking_number), 'neither order was changed');
});

test('the same number from a different brand is not the same order', async () => {
  db.table('orders').push({ id: 'o-k', customer_id: CUSTOMER, reference: 'STX-K', brand: 'Khaadi', brand_order_number: 'SP-482913', status: 'submitted', import_source: 'manual' });
  await deliver({ answer: extraction({ brand: 'Sapphire', order_number: 'SP-482913', courier_name: 'DHL', tracking_number: 'DHL-TRACK-1' }) });
  assert.equal(inbox().at(-1).match_status, 'review');
  assert.equal(orders().find((o) => o.id === 'o-k').tracking_number ?? null, null);
});

test("another customer's order with the same number is never touched", async () => {
  db.table('orders').push({ id: 'o-x', customer_id: 'someone-else', reference: 'STX-X', brand: 'Sapphire', brand_order_number: 'SP-482913', status: 'submitted', import_source: 'manual' });
  await deliver({ answer: extraction({ order_number: 'SP-482913', courier_name: 'DHL', tracking_number: 'DHL-TRACK-1' }) });
  assert.equal(orders().find((o) => o.id === 'o-x').tracking_number ?? null, null);
});

test('a shipping update for an order we do not have is flagged, not turned into an empty order', async () => {
  await deliver({ answer: extraction({ order_number: 'ZZ-99999', courier_name: 'DHL', tracking_number: 'DHL-TRACK-1' }) });
  assert.equal(orders().length, 0);
  assert.equal(inbox().at(-1).match_status, 'review');
});

test('a manual order with the same number is matched too (not only email orders)', async () => {
  db.table('orders').push({ id: 'o-m', customer_id: CUSTOMER, reference: 'STX-M', brand: 'Sapphire', brand_order_number: 'SP-555', status: 'submitted', import_source: 'manual', courier_id: null, tracking_number: null });
  await deliver({ answer: extraction({ order_number: 'sp 555', courier_name: 'TCS', tracking_number: 'TCS-555-AAA' }) });
  const order = orders().find((o) => o.id === 'o-m');
  assert.equal(order.tracking_number, 'TCS-555-AAA');
  assert.equal(order.courier_id, 'courier-tcs');
  assert.equal(orders().length, 1);
});

// ───────────── pure helpers ─────────────

test('order numbers compare regardless of punctuation and case, and need a digit', () => {
  const n = match.normaliseOrderNumber;
  assert.equal(n('#SP-482913'), 'sp482913');
  assert.equal(n(' sp 482913 '), 'sp482913');
  assert.equal(n('shipped'), '', 'a word is not an order number');
  assert.equal(n(null), '');
  assert.equal(n('12'), '', 'too short');
});

test('couriers from an email map onto the courier list', () => {
  const list = [{ id: 1, name: 'DHL' }, { id: 2, name: 'TCS' }, { id: 3, name: 'Leopards Courier' }];
  assert.equal(match.pickCourier(list, 'DHL Express Worldwide')?.id, 1);
  assert.equal(match.pickCourier(list, 'tcs')?.id, 2);
  assert.equal(match.pickCourier(list, 'Leopards')?.id, 3);
  assert.equal(match.pickCourier(list, 'Royal Mail'), null);
});

test('tracking and courier are read from plain text when the AI reader is off', () => {
  const r = match.readShippingFromText('Good news! Your parcel was handed to DHL.\nTracking number: 1Z999AA10123456784\nThanks', ['DHL', 'TCS']);
  assert.equal(r.tracking_number, '1Z999AA10123456784');
  assert.equal(r.courier_name, 'DHL');
  assert.deepEqual(match.readShippingFromText('Track your order information here', ['DHL']), { tracking_number: null, courier_name: null });
});

test('brand names that clearly differ conflict; unknown never does', () => {
  assert.equal(match.brandsConflict('Sapphire', 'Sapphire Online'), false);
  assert.equal(match.brandsConflict('Khaadi', 'Sapphire'), true);
  assert.equal(match.brandsConflict(null, 'Sapphire'), false);
});
