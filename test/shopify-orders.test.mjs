/**
 * Orders placed on a brand's Shopify store with "Customise stitching with Stitch&Ship": hold, address check, customer, draft order,
 * tag and email. Shopify, the email service and the database are all faked: nothing leaves this process.
 */
import { test, mock, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeDb } from './fake-supabase.mjs';

let db;
let orders;
let sms;
let calls;
let behave;
const dbProxy = new Proxy({}, { get: (_, key) => db[key] });

const STORE = { id: 'st1', shop_domain: 'my-brand.myshopify.com', status: 'active', brand_id: null, settings: {}, access_token_enc: 'x' };
const ATELIER = { key: 'ship_to', value: { shipToName: 'Stitch&Ship Atelier', shipToAddress: 'House 12 Street 4 Gulberg', shipToCity: 'Lahore', shipToPhone: '042 111 2222' } };

before(async () => {
  process.env.LOGIN_CODE_SECRET = 'test-login-secret';
  const { ConflictError } = await import('../src/utils/errors.js');
  mock.module('../src/config/supabase.js', { namedExports: { supabaseAdmin: dbProxy, supabase: dbProxy } });
  mock.module('../src/services/notification.service.js', {
    namedExports: {
      notifyAdmins: async (n) => calls.admins.push(n),
      notifyUser: async (id, n) => calls.users.push({ id, ...n }),
      notifyPartner: async () => {},
      notifyUsers: async () => {},
      notifyStaff: async () => {},
      partnerRecipients: async () => [],
    },
  });
  mock.module('../src/services/transactional-email.service.js', {
    namedExports: {
      renderEmail: (c) => ({ text: [c.heading, ...(c.paragraphs || []), c.button?.url].join('\n'), html: '', heading: c.heading }),
      sendTransactionalEmail: async (m) => {
        if (behave.emailFails) return { sent: false, reason: 'rejected' };
        calls.emails.push(m);
        return { sent: true };
      },
      transactionalEnabled: () => true,
      transactionalFrom: () => 'noreply@example.test',
    },
  });
  mock.module('../src/services/shopify.service.js', {
    namedExports: {
      getActiveStore: async () => STORE,
      normaliseShop: (v) => v,
      holdFulfillment: async (store, gid) => {
        if (behave.holdFails) throw new Error('Shopify refused the hold');
        calls.holds.push(gid);
        return [{ fo: 'gid://shopify/FulfillmentOrder/1', hold: 'gid://shopify/FulfillmentHold/1' }];
      },
      releaseFulfillment: async (store, holds) => {
        if (behave.releaseFails) throw new Error('Shopify refused the release');
        calls.releases.push(holds);
      },
      addOrderTag: async (store, gid, tag) => {
        if (behave.tagFails) throw new Error('no write access');
        calls.tags.push({ gid, tag });
      },
      updateShippingAddress: async (store, gid, address) => calls.addressUpdates.push({ gid, address }),
      fetchLineItemDetails: async () => new Map([['111', { image_url: 'https://cdn.example/a.png', url: 'https://brand.example/products/suit' }]]),
    },
  });
  // the real phone-number reading, with the sending itself faked
  const realSms = await import('../src/services/sms.service.js');
  mock.module('../src/services/sms.service.js', {
    namedExports: {
      ...realSms,
      smsEnabled: () => behave.smsConfigured !== false,
      sendSms: async (m) => {
        if (behave.smsFails) return { sent: false, reason: 'rejected' };
        calls.sms.push(m);
        return { sent: true };
      },
    },
  });
  mock.module('../src/services/customer-accounts.service.js', {
    namedExports: {
      findOrCreateCustomerByEmail: async ({ email, name }) => {
        const existing = db.table('profiles').find((p) => p.email === email);
        if (existing) {
          if (existing.role !== 'customer') throw new ConflictError('That email belongs to a staff account, so it cannot be used for a customer order.');
          return { profile: existing, created: false };
        }
        const profile = { id: `u_${db.table('profiles').length + 1}`, email, role: 'customer', full_name: name, customer_code: `STX-1000${db.table('profiles').length + 1}`, is_active: true };
        db.table('profiles').push(profile);
        return { profile, created: true };
      },
    },
  });
  sms = realSms;
  orders = await import('../src/services/shopify-orders.service.js');
});

const beforeEachReset = () => {
  calls = { holds: [], releases: [], tags: [], addressUpdates: [], emails: [], admins: [], users: [], sms: [] };
  behave = {};
  STORE.settings = {};
  db = createFakeDb(
    {
      shopify_stores: [{ ...STORE }],
      shopify_orders: [],
      orders: [],
      order_units: [],
      order_events: [],
      brands: [],
      partners: [{ id: 'pt1', is_default: true, status: 'active' }],
      profiles: [],
      platform_settings: [ATELIER],
      login_codes: [],
    },
    { uniques: { shopify_orders: { when: () => true, key: (r) => `${r.store_id}:${r.shopify_order_id}` } } }
  );
};
beforeEach(beforeEachReset);

const atelierAddress = (extra = {}) => ({ first_name: 'Ali', last_name: 'Khan', company: 'Stitch&Ship Atelier', address1: 'House 12, Street 4, Gulberg', address2: 'SS-AB12CD', city: 'Lahore', country: 'Pakistan', phone: '042 111 2222', ...extra });
const shopifyOrder = (extra = {}) => ({
  id: 5001,
  admin_graphql_api_id: 'gid://shopify/Order/5001',
  name: '#1001',
  email: 'Ali@Example.com',
  currency: 'PKR',
  total_price: '12500.00',
  financial_status: 'pending',
  payment_gateway_names: ['Cash on Delivery (COD)'],
  note_attributes: [{ name: 'stitchship', value: 'yes' }, { name: 'stitchship_ref', value: 'SS-AB12CD' }],
  customer: { first_name: 'Ali', last_name: 'Khan', email: 'ali@example.com' },
  shipping_address: atelierAddress(),
  billing_address: { first_name: 'Ali', last_name: 'Khan', address1: '5 Canal Road', city: 'Dubai', country: 'United Arab Emirates', phone: '+971500000000' },
  line_items: [{ id: 111, title: 'Unstitched 3-piece suit', variant_title: 'Green', quantity: 2, price: '6250.00', sku: 'SKU-1', properties: [] }],
  ...extra,
});
const row = () => db.table('shopify_orders')[0];
const order = () => db.table('orders')[0];

// ───────────── recognising a stitching order ─────────────

test('only orders with the stitching marker are ours; the reference code must look right', () => {
  assert.equal(orders.stitchingLines(shopifyOrder({ note_attributes: [] })).length, 0, 'no marker: not ours');
  assert.equal(orders.stitchingLines(shopifyOrder()).length, 1, 'the cart attribute marks every line');
  const mixed = shopifyOrder({ note_attributes: [], line_items: [{ id: 1, title: 'A', properties: [{ name: '_stitchship', value: 'yes' }] }, { id: 2, title: 'B', properties: [] }] });
  assert.deepEqual(orders.stitchingLines(mixed).map((l) => l.id), [1], 'with a marked line, only that line is for stitching');
  assert.equal(orders.stitchingRef(shopifyOrder()), 'SS-AB12CD');
  assert.equal(orders.stitchingRef(shopifyOrder({ note_attributes: [{ name: 'stitchship', value: 'yes' }, { name: 'stitchship_ref', value: 'hello' }] })), null);
});

test('the address must be the atelier: street and city match and the reference code is still there', () => {
  const atelier = { shipToAddress: 'House 12 Street 4 Gulberg', shipToCity: 'Lahore' };
  const ok = (shipping, ref = 'SS-AB12CD') => orders.addressMatchesAtelier({ shipping, atelier, ref });
  assert.equal(ok(atelierAddress()), true);
  assert.equal(ok(atelierAddress({ address1: 'house 12 street 4, gulberg' })), true, 'case and punctuation do not matter');
  assert.equal(ok(atelierAddress({ address2: '' })), false, 'the reference code was removed');
  assert.equal(ok(atelierAddress({ city: 'Karachi' })), false);
  assert.equal(ok(atelierAddress({ address1: '5 Canal Road' })), false, 'the customer typed their own street');
  assert.equal(ok(null), false);
  assert.equal(ok(atelierAddress({ address2: '' }), null), true, 'without a code (another entry path) the street and city decide');
});

test('orders without the marker are ignored and nothing is stored', async () => {
  const result = await orders.processOrderCreate(STORE, shopifyOrder({ note_attributes: [] }));
  assert.equal(result.status, 'ignored');
  assert.equal(db.table('shopify_orders').length, 0);
  assert.equal(db.table('orders').length, 0);
  assert.deepEqual(calls.holds, []);
});

// ───────────── the normal case ─────────────

test('a correct order: shipment held then released, customer found or made, draft with its articles, tag and email', async () => {
  const result = await orders.processOrderCreate(STORE, shopifyOrder());
  assert.deepEqual({ s: result.status, ok: result.addressOk }, { s: 'processed', ok: true });

  assert.deepEqual(calls.holds, ['gid://shopify/Order/5001']);
  assert.equal(calls.releases.length, 1, 'the address is right, so the brand may ship');
  assert.deepEqual(calls.tags, [{ gid: 'gid://shopify/Order/5001', tag: 'stitchship' }]);

  assert.equal(db.table('profiles')[0].email, 'ali@example.com', 'the email is the customer\'s login (lower case)');
  assert.equal(db.table('orders').length, 1);
  const o = order();
  assert.deepEqual(
    { status: o.status, brand_order_number: o.brand_order_number, source: o.order_source, ext: o.external_source, ref: o.shopify_ref, mode: o.stitching_mode, total: o.brand_order_total, cur: o.brand_order_currency, payment: o.brand_payment_method, paid: o.brand_payment_status },
    { status: 'draft', brand_order_number: '#1001', source: 'email', ext: 'shopify', ref: 'SS-AB12CD', mode: 'custom', total: 12500, cur: 'PKR', payment: 'Cash on Delivery (COD)', paid: 'pending' }
  );
  assert.equal(o.destination_country, 'United Arab Emirates', 'the customer\'s own address is offered for the final delivery');
  assert.equal(o.destination_phone, '+971500000000');
  assert.equal(o.partner_id, 'pt1');

  const units = db.table('order_units');
  assert.equal(units.length, 2, 'two of the same suit = two articles');
  assert.equal(units[0].unit_title, 'Unstitched 3-piece suit · Green');
  assert.equal(units[0].product_image_url, 'https://cdn.example/a.png');
  assert.equal(units[0].unit_price, 6250);

  assert.equal(calls.emails.length, 1);
  assert.equal(calls.emails[0].to, 'ali@example.com');
  assert.match(calls.emails[0].text, /Add your sizes/);
  assert.match(calls.emails[0].text, /sign-in\?email=ali%40example\.com&token=[0-9a-f]{48}&next=%2Fapp%2Forders%2F/);
  assert.equal(db.table('login_codes').length, 1, 'one link token was issued');

  assert.deepEqual({ state: row().state, addr: row().address_state, hold: row().hold_state, order: row().order_id === o.id }, { state: 'draft_created', addr: 'address_ok', hold: 'released', order: true });
  assert.ok(row().notified_at);
  assert.equal(row().payload, null, 'the Shopify copy with personal data is dropped when nothing is open');
  assert.ok(calls.users.some((n) => n.id === db.table('profiles')[0].id), 'the customer also gets an in-app notice');
});

test('the same Shopify order delivered twice makes one order, one hold and one email', async () => {
  await orders.processOrderCreate(STORE, shopifyOrder());
  const again = await orders.processOrderCreate(STORE, shopifyOrder());
  assert.equal(again.status, 'duplicate');
  assert.equal(db.table('orders').length, 1);
  assert.equal(db.table('order_units').length, 2);
  assert.equal(calls.holds.length, 1);
  assert.equal(calls.emails.length, 1);
  assert.equal(db.table('shopify_orders').length, 1);
});

test('an existing customer account is reused', async () => {
  db.table('profiles').push({ id: 'u_old', email: 'ali@example.com', role: 'customer', full_name: 'Ali', customer_code: 'STX-10001', is_active: true });
  await orders.processOrderCreate(STORE, shopifyOrder());
  assert.equal(db.table('profiles').length, 1);
  assert.equal(order().customer_id, 'u_old');
});

// ───────────── wrong address ─────────────

test('a changed address keeps the shipment on hold, tells the admins and asks the customer; the app changes nothing by itself', async () => {
  const wrong = shopifyOrder({ shipping_address: atelierAddress({ address1: '5 Canal Road', address2: '', company: '', city: 'Dubai' }) });
  const result = await orders.processOrderCreate(STORE, wrong);
  assert.equal(result.addressOk, false);
  assert.equal(calls.releases.length, 0, 'still on hold');
  assert.deepEqual(calls.addressUpdates, [], 'the address is never changed without the customer');
  assert.equal(row().address_state, 'address_mismatch');
  assert.equal(row().hold_state, 'held');
  assert.ok(row().payload, 'the order is kept while it is open');
  assert.ok(calls.admins.some((a) => /not going to the atelier/.test(a.title)));
  assert.match(calls.emails[0].text, /Please confirm where your order/);
  assert.equal(order().status, 'draft', 'the customer still gets their draft');
});

test('when the customer confirms, the atelier address is put on the brand order and the shipment is released', async () => {
  await orders.processOrderCreate(STORE, shopifyOrder({ shipping_address: atelierAddress({ address1: '5 Canal Road', address2: '', company: '', city: 'Dubai' }) }));
  const result = await orders.confirmAtelierAddress({ order: order(), actorId: 'u_1' });
  assert.equal(result.changed, true);
  assert.equal(calls.addressUpdates.length, 1);
  assert.deepEqual(calls.addressUpdates[0].address, {
    firstName: 'Ali',
    lastName: 'Khan',
    company: 'Stitch&Ship Atelier',
    address1: 'House 12 Street 4 Gulberg',
    address2: 'SS-AB12CD',
    city: 'Lahore',
    countryCode: 'PK',
    phone: '042 111 2222',
  });
  assert.equal(calls.releases.length, 1);
  assert.deepEqual({ addr: row().address_state, hold: row().hold_state }, { addr: 'address_ok', hold: 'released' });
  assert.equal((await orders.confirmAtelierAddress({ order: order(), actorId: 'u_1' })).changed, false, 'confirming twice does nothing');
  assert.equal(calls.addressUpdates.length, 1);
});

test('if the brand fixes the address itself, the next update releases the shipment', async () => {
  await orders.processOrderCreate(STORE, shopifyOrder({ shipping_address: atelierAddress({ address1: '5 Canal Road', address2: '', company: '', city: 'Dubai' }) }));
  assert.equal(calls.releases.length, 0);
  await orders.processOrderUpdated(STORE, shopifyOrder());
  assert.equal(calls.releases.length, 1);
  assert.equal(row().address_state, 'address_ok');
});

// ───────────── things going wrong ─────────────

test('if the shipment cannot be held the order is still taken in and the admins are told', async () => {
  behave.holdFails = true;
  await orders.processOrderCreate(STORE, shopifyOrder());
  assert.equal(row().hold_state, 'failed');
  assert.equal(db.table('orders').length, 1);
  assert.ok(calls.admins.some((a) => /could not hold/.test(a.title)));
  assert.equal(calls.releases.length, 0, 'nothing to release');
});

test('a failed release is reported, a failed tag or a failed email does not stop the order', async () => {
  behave.releaseFails = true;
  behave.tagFails = true;
  behave.emailFails = true;
  await orders.processOrderCreate(STORE, shopifyOrder());
  assert.equal(row().hold_state, 'failed');
  assert.ok(calls.admins.some((a) => /release the hold/.test(a.title)));
  assert.equal(db.table('orders').length, 1);
  assert.equal(row().notified_at ?? null, null, 'the customer was not emailed');
  assert.ok(row().payload, 'kept so the admin can resend');
  behave.emailFails = false;
  behave.releaseFails = false;
  await orders.resendCustomerEmail(row().id);
  assert.equal(calls.emails.length, 1);
  assert.ok(row().notified_at);
});

test('an email that belongs to a staff account is never used for a customer order', async () => {
  db.table('profiles').push({ id: 'staff1', email: 'ali@example.com', role: 'admin', full_name: 'Admin', is_active: true });
  const result = await orders.processOrderCreate(STORE, shopifyOrder());
  assert.equal(result.status, 'failed');
  assert.equal(db.table('orders').length, 0);
  assert.equal(row().state, 'failed');
  assert.ok(calls.admins.some((a) => /could not be taken in/.test(a.title)));
});

test('an order with no email cannot be matched to a customer', async () => {
  const result = await orders.processOrderCreate(STORE, shopifyOrder({ email: null, contact_email: null, customer: null }));
  assert.equal(result.status, 'failed');
  assert.equal(db.table('orders').length, 0);
});

// ───────────── changes after the order ─────────────

test('cancelling the brand order cancels the draft, and warns when our order is already in progress', async () => {
  await orders.processOrderCreate(STORE, shopifyOrder());
  await orders.processOrderCancelled(STORE, shopifyOrder());
  assert.equal(order().status, 'cancelled');
  assert.equal(row().state, 'cancelled');
  assert.equal((await orders.processOrderCreate(STORE, shopifyOrder())).status, 'cancelled', 'a late repeat of the order cannot bring it back');

  db = createFakeDb({ shopify_stores: [{ ...STORE }], shopify_orders: [], orders: [], order_units: [], order_events: [], brands: [], partners: [{ id: 'pt1', is_default: true, status: 'active' }], profiles: [], platform_settings: [ATELIER], login_codes: [] }, { uniques: { shopify_orders: { when: () => true, key: (r) => `${r.store_id}:${r.shopify_order_id}` } } });
  await orders.processOrderCreate(STORE, shopifyOrder());
  order().status = 'received';
  calls.admins.length = 0;
  await orders.processOrderUpdated(STORE, shopifyOrder({ cancelled_at: '2026-10-21T10:00:00Z' }));
  assert.equal(order().status, 'received', 'work already started is not cancelled behind anyone\'s back');
  assert.ok(calls.admins.some((a) => /was cancelled/.test(a.title)));
});

test('the admin queue lists what needs attention', async () => {
  await orders.processOrderCreate(STORE, shopifyOrder({ id: 1, admin_graphql_api_id: 'gid://shopify/Order/1', name: '#1' }));
  await orders.processOrderCreate(STORE, shopifyOrder({ id: 2, admin_graphql_api_id: 'gid://shopify/Order/2', name: '#2', email: 'sara@example.com', shipping_address: atelierAddress({ address1: 'Elsewhere', address2: '', city: 'Dubai' }) }));
  const queue = await orders.shopifyQueue();
  const byName = Object.fromEntries(queue.map((q) => [q.shopify_order_name, q.needs_attention]));
  assert.deepEqual(byName, { '#1': false, '#2': true });
});

// ───────────── text messages ─────────────

const smsStore = () => {
  STORE.settings = { sms_enabled: true };
  db.table('shopify_stores')[0].settings = { sms_enabled: true };
};

test('phone numbers are understood only when it is certain what they are', () => {
  const t = (v) => sms.toE164(v, 'PK');
  assert.equal(t('+971 50 000 0000'), '+971500000000');
  assert.equal(t('00923001234567'), '+923001234567');
  assert.equal(t('0300 1234567'), '+923001234567');
  assert.equal(t('923001234567'), '+923001234567');
  for (const bad of ['042 111 2222', '123', '', null, '05001234567', 'abc']) assert.equal(t(bad), null, String(bad));
  assert.equal(sms.toE164('0300 1234567', 'AE'), null, 'a local format is not guessed in another country');
});

test("the customer's own phone is picked, never the atelier's pre-filled one", () => {
  const atelier = { shipToPhone: '042 111 2222' };
  assert.equal(orders.pickCustomerPhone(shopifyOrder(), atelier), '+971500000000', 'from the billing address');
  assert.equal(orders.pickCustomerPhone(shopifyOrder({ phone: '+92 300 1234567' }), atelier), '+923001234567', 'the contact phone first');
  const onlyAtelier = shopifyOrder({ billing_address: { phone: '+92 42 111 2222' }, shipping_address: atelierAddress() });
  assert.equal(orders.pickCustomerPhone(onlyAtelier, { shipToPhone: '+92 42 111 2222' }), null);
  assert.equal(orders.pickCustomerPhone(shopifyOrder({ billing_address: { phone: '' } }), atelier), null);
});

test('no text is sent, and no number is kept, unless the store switched texts on', async () => {
  await orders.processOrderCreate(STORE, shopifyOrder());
  assert.equal(calls.sms.length, 0);
  assert.equal(row().customer_phone ?? null, null);
  assert.equal(calls.emails.length, 1, 'the email goes anyway');
});

test('with texts on, the customer gets the email and a text with the same link, once; their number is dropped afterwards', async () => {
  smsStore();
  await orders.processOrderCreate(STORE, shopifyOrder());
  assert.equal(calls.sms.length, 1);
  assert.equal(calls.sms[0].to, '+971500000000');
  assert.match(calls.sms[0].body, /add your sizes for your .* order #1001/);
  const token = /token=([0-9a-f]{48})/;
  assert.equal(token.exec(calls.sms[0].body)[1], token.exec(calls.emails[0].text)[1], 'one link for both');
  assert.equal(db.table('login_codes').length, 1);
  assert.ok(row().sms_notified_at);
  assert.equal(row().customer_phone, null);
  await orders.processOrderCreate(STORE, shopifyOrder());
  assert.equal(calls.sms.length, 1, 'a repeated delivery sends nothing more');
});

test('a changed address sends the "confirm" text', async () => {
  smsStore();
  await orders.processOrderCreate(STORE, shopifyOrder({ shipping_address: atelierAddress({ address1: '5 Canal Road', address2: '', company: '', city: 'Dubai' }) }));
  assert.match(calls.sms[0].body, /please confirm where your .* order #1001 goes/);
});

test('texts need the account to be set up and a number we understand; a failed text never stops the order', async () => {
  smsStore();
  behave.smsConfigured = false;
  await orders.processOrderCreate(STORE, shopifyOrder());
  assert.equal(calls.sms.length, 0);

  beforeEachReset();
  smsStore();
  behave.smsFails = true;
  await orders.processOrderCreate(STORE, shopifyOrder());
  assert.equal(db.table('orders').length, 1);
  assert.equal(calls.emails.length, 1);
  assert.equal(row().sms_notified_at ?? null, null);
  assert.equal(row().customer_phone, '+971500000000', 'kept so a resend can try again');
});

test('resending the email does not text a customer who already got the text', async () => {
  smsStore();
  behave.emailFails = true;
  await orders.processOrderCreate(STORE, shopifyOrder());
  assert.equal(calls.sms.length, 1);
  behave.emailFails = false;
  await orders.resendCustomerEmail(row().id);
  assert.equal(calls.emails.length, 1);
  assert.equal(calls.sms.length, 1);
});
