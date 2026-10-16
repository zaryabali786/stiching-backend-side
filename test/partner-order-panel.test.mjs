/** The partner's order side panel: workshop details only, never the customer's phone / email, admin notes or money, and the partner's own earnings. */
import { test, mock, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeDb } from './fake-supabase.mjs';

let db;
let partner;
const dbProxy = new Proxy({}, { get: (_, key) => db[key] });
const noop = async () => {};

before(async () => {
  mock.module('../src/config/supabase.js', { namedExports: { supabaseAdmin: dbProxy, supabase: dbProxy } });
  mock.module('../src/services/notification.service.js', { namedExports: { notifyAdmins: noop, notifyPartner: noop, notifyUser: noop, notifyUsers: noop, notifyStaff: noop, partnerRecipients: async () => [] } });
  partner = await import('../src/controllers/partner.controller.js');
});

beforeEach(() => {
  db = createFakeDb({
    orders: [{
      id: 'o1', reference: 'SA-1', brand: 'Alkaram', brand_order_number: 'AK-9', status: 'paid', partner_id: 'p1',
      customer_name: 'Zaryab Ali', customer_code: 'STX-1', customer_notes: 'Please hurry',
      destination_address: 'Street 5', destination_city: 'Lahore', destination_country: 'Pakistan',
      destination_phone: '03001234567', admin_notes: 'INTERNAL: margin low', customer_email: 'z@example.com',
    }],
    brands: [{ id: 'b1', name: 'Alkaram', logo_url: 'https://cdn/logo.png' }],
    order_units: [{ id: 'u1', order_id: 'o1', line_no: 1, unit_title: 'Lawn 3pc', quantity: 1, code: 'SA-1-1', status: 'received', picks: [], size_snapshot: { name: 'Me', nearest_size: 'S', measurements: { chest: 38 } } }],
    order_events: [
      { id: 'e1', order_id: 'o1', status: 'submitted', note: 'Order created', created_at: '2026-10-13T10:00:00Z' },
      { id: 'e2', order_id: 'o1', status: 'paid', note: 'Invoice INV-1 paid PKR 3550', created_at: '2026-10-14T10:00:00Z' },
    ],
    invoices: [{ id: 'i1', order_id: 'o1', status: 'paid', partner_total_pkr: 1200, total_pkr: 3550 }],
  });
});

const call = (req) => new Promise((resolve) => {
  const res = { status() { return this; }, json(body) { resolve({ body }); return this; } };
  partner.getPartnerOrder({ params: { id: 'o1' }, access: { isAdmin: true, permissions: new Set() }, ...req }, res, (err) => resolve({ err }));
});

test('the panel carries the customer name and address only: no phone, email, admin notes or invoice amounts', async () => {
  const { body, err } = await call({});
  assert.equal(err, undefined, err?.message);
  const text = JSON.stringify(body.data);
  assert.equal(body.data.customer.name, 'Zaryab Ali');
  assert.match(body.data.delivery.address, /Street 5/);
  for (const secret of ['03001234567', 'z@example.com', 'INTERNAL', '3550']) assert.equal(text.includes(secret), false, `${secret} must not be in the response`);
  assert.equal(body.data.units[0].size.nearest, 'S');
  assert.equal(body.data.brand.logo_url, 'https://cdn/logo.png');
});

test('timeline notes that mention money are dropped, the status stays', async () => {
  const { body } = await call({});
  const paid = body.data.timeline.find((e) => e.status === 'paid');
  assert.equal(paid.note, null);
  assert.equal(body.data.timeline.find((e) => e.status === 'submitted').note, 'Order created');
});

test('partner earnings: earned once paid, pending while issued, unavailable before an invoice exists', async () => {
  assert.deepEqual((await call({})).body.data.earnings, { state: 'earned', amount_pkr: 1200 });
  db.table('invoices')[0].status = 'issued';
  assert.deepEqual((await call({})).body.data.earnings, { state: 'pending', amount_pkr: 1200 });
  db.table('invoices')[0].status = 'draft';
  assert.deepEqual((await call({})).body.data.earnings, { state: 'unavailable', amount_pkr: null });
  db.table('invoices').length = 0;
  assert.deepEqual((await call({})).body.data.earnings, { state: 'unavailable', amount_pkr: null });
});

test('another partner cannot open this order', async () => {
  const { err } = await call({ access: { isAdmin: false, partnerId: 'p2', permissions: new Set(['overview.view']) } });
  assert.ok(err, 'not found for a different partner');
});
