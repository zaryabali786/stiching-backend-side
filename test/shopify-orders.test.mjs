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
const ATELIER = { key: 'ship_to', value: { shipToName: 'Stitch&Ship Atelier', shipToAddress: 'House 12 Street 4 Gulberg', shipToAddress2: 'Unit 4, 2nd floor', shipToCity: 'Lahore', shipToPhone: '042 111 2222' } };

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
        calls.seq.push('hold');
        calls.holds.push(gid);
        return [{ fo: 'gid://shopify/FulfillmentOrder/1', hold: 'gid://shopify/FulfillmentHold/1' }];
      },
      releaseFulfillment: async (store, holds) => {
        if (behave.releaseFails) throw new Error('Shopify refused the release');
        calls.releases.push(holds);
      },
      addOrderTag: async (store, gid, tag) => {
        if (behave.tagFails) throw new Error('no write access');
        if (behave.tagFailCount > 0) {
          behave.tagFailCount -= 1;
          throw new Error('Shopify is busy');
        }
        calls.seq.push('tag');
        calls.tags.push({ gid, tag });
      },
      updateShippingAddress: async (store, gid, address) => {
        if (behave.addressRefused) throw Object.assign(new Error(behave.addressRefused), { status: 422 });
        if (behave.addressDown) throw new Error('Shopify is down');
        calls.seq.push('address');
        calls.addressUpdates.push({ gid, address });
      },
      fetchLineItemDetails: async () => new Map([['111', { image_url: 'https://cdn.example/a.png', url: 'https://brand.example/products/suit' }]]),
      tagAndNoteOrder: async (store, gid, tag, line) => {
        if (behave.tagNoteFails) throw new Error('no write access');
        calls.tagNotes.push({ gid, tag, line });
      },
      fetchRestOrder: async () => null,
      productsStitchEnabled: async (store, ids) => {
        calls.enabledChecks.push(ids.map(String));
        if (behave.enabledFails) throw new Error('Shopify is down');
        const set = new Set(ids.filter(Boolean).map(String).filter((id) => !behave.enabled || behave.enabled.includes(id)));
        set.metafieldValues = new Map(ids.filter(Boolean).map((id) => [String(id), set.has(String(id)) ? 'true' : null]));
        return set;
      },
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
  calls = { holds: [], releases: [], tags: [], addressUpdates: [], emails: [], admins: [], users: [], sms: [], enabledChecks: [], tagNotes: [], seq: [] };
  behave = {};
  STORE.settings = { stitch_mode: 'customer' }; // these tests are about the customer's tick; the product-box mode has its own tests below
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
  line_items: [{ id: 111, product_id: 9001, title: 'Unstitched 3-piece suit', variant_title: 'Green', quantity: 2, price: '6250.00', sku: 'SKU-1', properties: [] }],
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

test('the address must be the atelier: street and city match (the reference code is not part of the address)', () => {
  const atelier = { shipToAddress: 'House 12 Street 4 Gulberg', shipToCity: 'Lahore' };
  const ok = (shipping, ref = 'SS-AB12CD') => orders.addressMatchesAtelier({ shipping, atelier, ref });
  assert.equal(ok(atelierAddress()), true);
  assert.equal(ok(atelierAddress({ address1: 'house 12 street 4, gulberg' })), true, 'case and punctuation do not matter');
  assert.equal(ok(atelierAddress({ address2: '' })), true, 'the apartment line does not decide: the reference code travels as an order property');
  assert.equal(ok(atelierAddress({ city: 'Karachi' })), false);
  assert.equal(ok(atelierAddress({ address1: '5 Canal Road' })), false, 'the customer typed their own street');
  assert.equal(ok(null), false);
  assert.equal(ok(atelierAddress({ address2: '' }), null), true);
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
  behave.addressRefused = 'Could not change the shipping address: Country/region not supported'; // the app cannot move it itself: the customer is asked
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
  behave.addressRefused = 'Could not change the shipping address: Country/region not supported'; // the app cannot move it itself: the customer is asked
  await orders.processOrderCreate(STORE, shopifyOrder({ shipping_address: atelierAddress({ address1: '5 Canal Road', address2: '', company: '', city: 'Dubai' }) }));
  behave.addressRefused = null; // the store now accepts the address (a shipping zone was added)
  const result = await orders.confirmAtelierAddress({ order: order(), actorId: 'u_1' });
  assert.equal(result.changed, true);
  assert.equal(calls.addressUpdates.length, 1);
  assert.deepEqual(calls.addressUpdates[0].address, {
    firstName: 'Ali',
    lastName: 'Khan',
    company: 'Stitch&Ship Atelier',
    address1: 'House 12 Street 4 Gulberg',
    address2: 'Unit 4, 2nd floor',
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
  behave.addressRefused = 'Could not change the shipping address: Country/region not supported'; // the app cannot move it itself: the customer is asked
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
  behave.addressRefused = 'Could not change the shipping address: Country/region not supported'; // the app cannot move it itself: the customer is asked
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
  behave.addressRefused = 'Could not change the shipping address: Country/region not supported'; // the app cannot move it itself: the customer is asked
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

// ───────────── what Shopify says about the payment ─────────────

test('Shopify payment status is read from its own figures, never assumed', () => {
  const info = (extra) => orders.shopifyPaymentInfo(shopifyOrder(extra));
  assert.deepEqual(pick(info({ financial_status: 'paid' })), { kind: 'paid', outstanding: 0, paid: 12500 });
  assert.deepEqual(pick(info({ financial_status: 'pending' })), { kind: 'unpaid', outstanding: 12500, paid: 0 });
  assert.deepEqual(pick(info({ financial_status: 'authorized' })), { kind: 'unpaid', outstanding: 12500, paid: 0 }, 'authorized money is not collected yet');
  assert.deepEqual(pick(info({ financial_status: 'partially_paid', total_outstanding: '4500.00' })), { kind: 'unpaid', outstanding: 4500, paid: 8000 });
  assert.deepEqual(pick(info({ financial_status: 'partially_paid', total_received: '10000.00' })), { kind: 'unpaid', outstanding: 2500, paid: 10000 }, 'outstanding = total minus received');
  assert.equal(info({ financial_status: 'partially_paid' }).kind, 'unknown', 'partly paid with no figures: not guessed');
  assert.equal(info({ financial_status: 'refunded' }).kind, 'unknown');
  assert.equal(info({ financial_status: 'voided' }).kind, 'unknown');
  assert.equal(info({ financial_status: undefined }).kind, 'unknown');
  assert.equal(info({ financial_status: 'paid', currency: undefined }).kind, 'unknown', 'no currency: cannot be trusted');
  assert.equal(info({ financial_status: 'paid', total_outstanding: '300.00' }).kind, 'unpaid', 'a paid status with money still outstanding is not paid');
});
const pick = (i) => ({ kind: i.kind, outstanding: i.outstanding, paid: i.amount_paid });

test('a Shopify order that is already fully paid is Non-COD: no choice, no payment asked', async () => {
  const result = await orders.processOrderCreate(STORE, shopifyOrder({ financial_status: 'paid', payment_gateway_names: ['shopify_payments'] }));
  assert.equal(result.status, 'processed');
  const o = order();
  assert.equal(o.payment_type, 'NON_COD');
  assert.equal(o.cod_payment_status, null);
  assert.equal(o.cod_amount, undefined, 'nothing to collect');
  assert.equal(o.brand_payment_status, 'paid');
  assert.equal(o.shopify_financial_status, 'paid');
  assert.equal(o.shopify_outstanding, 0);
  assert.equal(o.shopify_amount_paid, 12500);
  const cod = await import('../src/services/cod-payment.service.js');
  assert.equal(cod.codView(o).can_choose, false, 'the customer is not asked COD or Non-COD');
  assert.equal(cod.codView(o).can_pay, false, 'and is not asked to pay again');
  assert.doesNotThrow(() => cod.assertReceivable(o), 'receiving is open');
});

test('an unpaid Shopify order is COD for the amount outstanding, and cannot be received until it is paid', async () => {
  await orders.processOrderCreate(STORE, shopifyOrder({ financial_status: 'pending' }));
  const o = order();
  assert.equal(o.payment_type, 'COD');
  assert.equal(o.cod_payment_status, 'UNPAID');
  assert.equal(o.cod_amount, 12500);
  assert.equal(o.cod_currency, 'PKR');
  assert.equal(o.cod_amount_status, 'verified');
  assert.equal(o.cod_amount_source, 'shopify');
  assert.equal(o.brand_payment_status, 'pending');
  const cod = await import('../src/services/cod-payment.service.js');
  const view = cod.codView(o);
  assert.equal(view.can_pay, true);
  assert.equal(view.source, 'shopify');
  assert.equal(view.receive_blocked, true);
  assert.equal(view.shopify.financial_status, 'pending');
  assert.equal(view.shopify.outstanding, 12500);
  assert.throws(() => cod.assertReceivable(o), /Payment is required/);
});

test('a partly paid Shopify order asks only for what is outstanding', async () => {
  await orders.processOrderCreate(STORE, shopifyOrder({ financial_status: 'partially_paid', total_outstanding: '4500.00' }));
  const o = order();
  assert.equal(o.payment_type, 'COD');
  assert.equal(o.cod_amount, 4500);
  assert.equal(o.shopify_amount_paid, 8000);
  assert.equal(o.shopify_outstanding, 4500);
});

test('when Shopify does not say clearly whether it is paid, nothing is assumed: our team confirms the total first', async () => {
  await orders.processOrderCreate(STORE, shopifyOrder({ financial_status: 'refunded' }));
  const o = order();
  assert.equal(o.payment_type, 'COD');
  assert.equal(o.cod_amount_status, 'needs_verification');
  assert.equal(o.cod_amount, undefined);
  const cod = await import('../src/services/cod-payment.service.js');
  const view = cod.codView(o);
  assert.equal(view.can_pay, false, 'cannot be paid until confirmed');
  assert.equal(view.payment_state, 'verification_pending');
  assert.equal(view.receive_blocked, true);
});

test('when Shopify later shows the order as paid, the unpaid COD order becomes Non-COD (no charge, receiving opens)', async () => {
  await orders.processOrderCreate(STORE, shopifyOrder({ financial_status: 'pending' }));
  assert.equal(order().payment_type, 'COD');
  await orders.processOrderUpdated(STORE, shopifyOrder({ financial_status: 'paid' }));
  assert.equal(order().payment_type, 'NON_COD');
  assert.equal(order().cod_payment_status, null);
  assert.equal(order().shopify_financial_status, 'paid');
  assert.equal(order().brand_payment_status, 'paid');
  assert.ok(db.table('order_events').some((e) => /Shopify reports the brand order as fully paid/.test(e.note || '')));
});

test('a Shopify update that is not paid changes nothing about the payment type', async () => {
  await orders.processOrderCreate(STORE, shopifyOrder({ financial_status: 'pending' }));
  await orders.processOrderUpdated(STORE, shopifyOrder({ financial_status: 'pending' }));
  assert.equal(order().payment_type, 'COD');
  assert.equal(order().cod_payment_status, 'UNPAID');
});

// ───────────── ONE order: a Stitch&Ship line sends the whole purchase to the atelier ─────────────

const HOME = { first_name: 'Ali', last_name: 'Khan', address1: '5 Canal Road', address2: '', city: 'Lahore', province: 'Punjab', zip: '54000', country: 'Pakistan', country_code: 'PK', phone: '+923001112222' };
const MARK = [{ name: '_stitchship', value: 'yes' }, { name: '_stitchship_ref', value: 'SS-AB12CD' }];
const mkLine = (id, price, quantity, extra = {}) => ({ id, title: `Product ${id}`, variant_title: 'M', sku: `SKU-${id}`, product_id: 900 + id, variant_id: 800 + id, price, quantity, properties: [], discount_allocations: [], tax_lines: [], ...extra });
/** The customer's checkout at their own address. Lines are [id, price, quantity, ticked]. */
const checkout = (lines, extra = {}) => {
  const total = lines.reduce((n, [, price, qty]) => n + Number(price) * qty, 0);
  return shopifyOrder({ note_attributes: [], taxes_included: false, financial_status: 'paid', total_price: total.toFixed(2), shipping_address: HOME, line_items: lines.map(([id, price, qty, ticked]) => mkLine(id, price, qty, { properties: ticked ? MARK : [] })), shipping_lines: [], ...extra });
};
const unitsOf = () => db.table('order_units').map((u) => u.unit_title);

test('the atelier own country, state and postal code (chosen in the admin) are what Shopify receives, not a fixed country', async () => {
  const setting = db.table('platform_settings').find((r) => r.key === 'ship_to');
  setting.value = { ...setting.value, shipToCountry: 'United Kingdom', shipToCountryCode: 'GB', shipToState: 'England', shipToProvinceCode: 'ENG', shipToZip: 'M1 1AE' };
  await orders.processOrderCreate(STORE, checkout([[1, '749.95', 1, true]]));
  const a = calls.addressUpdates[0].address;
  assert.deepEqual([a.countryCode, a.provinceCode, a.zip, a.city], ['GB', 'ENG', 'M1 1AE', 'Lahore']);
});

test('an atelier saved before the country existed still goes to Pakistan (nothing that worked stops working)', async () => {
  await orders.processOrderCreate(STORE, checkout([[1, '749.95', 1, true]]));
  const a = calls.addressUpdates[0].address;
  assert.equal(a.countryCode, 'PK');
  assert.equal('provinceCode' in a, false);
  assert.equal('zip' in a, false);
});

test('one product with Stitch&Ship ticked: one order, tagged, the whole order goes to the atelier, one order in the app', async () => {
  const result = await orders.processOrderCreate(STORE, checkout([[1, '749.95', 1, true]]));
  assert.equal(result.status, 'processed');
  assert.deepEqual(result.warnings, []);
  assert.deepEqual(calls.tags.map((t) => t.tag), ['stitchship']);
  assert.equal(calls.addressUpdates.length, 1);
  assert.equal(calls.addressUpdates[0].address.address1, 'House 12 Street 4 Gulberg');
  assert.equal(calls.addressUpdates[0].address.address2, 'Unit 4, 2nd floor');
  assert.equal(db.table('orders').length, 1);
  assert.equal(order().brand_order_total, 749.95);
  assert.equal(order().external_source, 'shopify');
  assert.equal(row().state, 'draft_created');
  assert.equal(calls.emails.length, 1);
});

test('a mixed purchase stays ONE order: the Stitch&Ship dress and the normal accessories, all in it, all going to the atelier', async () => {
  const result = await orders.processOrderCreate(STORE, checkout([[1, '100.00', 1, true], [2, '10.00', 2, false]]));
  assert.equal(result.status, 'processed');
  assert.equal(db.table('orders').length, 1, 'one order in the app, not one per group');
  assert.equal(unitsOf().length, 3, 'the dress and both accessories');
  assert.deepEqual(unitsOf().sort(), ['Product 1 · M', 'Product 2 · M', 'Product 2 · M']);
  assert.equal(order().brand_order_total, 120, 'the whole checkout');
  assert.equal(calls.addressUpdates.length, 1, 'one address change: the whole order');
  assert.equal(calls.addressUpdates[0].address.address1, 'House 12 Street 4 Gulberg');
  assert.deepEqual(calls.tags.map((t) => t.tag), ['stitchship'], 'the plain tag, never a mixed or split tag');
  assert.equal(db.table('shopify_orders').length, 1);
  assert.ok(calls.tagNotes.some((t) => /own delivery address: 5 Canal Road/.test(t.line)), 'the customer\'s own address is kept in the note');
});

test('nothing is split: no second Shopify order, no edit of the order, no group records', async () => {
  await orders.processOrderCreate(STORE, checkout([[1, '100.00', 1, true], [2, '10.00', 1, false], [3, '5.00', 1, false]]));
  assert.equal(db.table('shopify_orders').length, 1);
  assert.equal(db.table('orders').length, 1);
  assert.equal(calls.tagNotes.filter((t) => t.tag).length, 0);
  assert.equal(orders.splitOriginalOrder, undefined, 'the splitting code is gone');
  assert.equal(orders.STITCH_MIXED_TAG, undefined);
});

test('a quantity of three of the ticked product is one line, one order, three articles', async () => {
  await orders.processOrderCreate(STORE, checkout([[1, '40.00', 3, true]]));
  assert.equal(db.table('orders').length, 1);
  assert.equal(unitsOf().length, 3);
  assert.equal(calls.tags.length, 1);
});

test('prepaid, Cash on Delivery and unpaid orders are treated alike: the same tag, the same routing', async () => {
  for (const [status, gateway] of [['paid', 'shopify_payments'], ['pending', 'Cash on Delivery (COD)'], ['pending', 'bank_transfer']]) {
    beforeEachReset();
    await orders.processOrderCreate(STORE, checkout([[1, '50.00', 1, true], [2, '20.00', 1, false]], { financial_status: status, payment_gateway_names: [gateway] }));
    assert.deepEqual(calls.tags.map((t) => t.tag), ['stitchship'], `${status} / ${gateway}`);
    assert.equal(calls.addressUpdates.length, 1, `${status} / ${gateway}`);
    assert.equal(db.table('orders').length, 1);
  }
});

test('payment is not touched: a paid order stays Non-COD, a Cash on Delivery order stays unpaid for the whole total', async () => {
  await orders.processOrderCreate(STORE, checkout([[1, '100.00', 1, true], [2, '10.00', 2, false]], { financial_status: 'paid' }));
  assert.equal(order().payment_type, 'NON_COD');
  assert.equal(order().cod_payment_status, null);
  beforeEachReset();
  await orders.processOrderCreate(STORE, checkout([[1, '100.00', 1, true], [2, '10.00', 2, false]], { financial_status: 'pending', payment_gateway_names: ['Cash on Delivery (COD)'] }));
  assert.equal(order().payment_type, 'COD');
  assert.equal(order().cod_payment_status, 'UNPAID');
  assert.equal(order().cod_amount, 120, 'the whole order, not a share');
  assert.equal(order().brand_payment_status, 'pending');
});

test('no ticked line, or only products that are not enabled: a normal order, nothing changes', async () => {
  const none = await orders.processOrderCreate(STORE, checkout([[1, '100.00', 1, false], [2, '10.00', 1, false]]));
  assert.equal(none.status, 'ignored');
  behave.enabled = [];
  const notEnabled = await orders.processOrderCreate(STORE, checkout([[1, '100.00', 1, true]]));
  assert.equal(notEnabled.status, 'ignored');
  assert.equal(db.table('shopify_orders').length, 0);
  assert.equal(calls.tags.length, 0);
  assert.equal(calls.addressUpdates.length, 0);
});

test('the customer must have ticked Stitch&Ship AND the product must be enabled; a store can choose to need only the product\'s box', async () => {
  behave.enabled = ['901'];
  assert.equal((await orders.processOrderCreate(STORE, checkout([[1, '100.00', 1, false]]))).status, 'ignored', 'enabled but not ticked');
  STORE.settings = { stitch_mode: 'enabled' };
  const result = await orders.processOrderCreate(STORE, checkout([[1, '100.00', 1, false], [2, '10.00', 1, false]]));
  assert.equal(result.status, 'processed', 'product box only');
  assert.equal(db.table('orders').length, 1);
  assert.equal(unitsOf().length, 2, 'still every line');
});

test('an administrator can import an order the tick never reached (force): processed once, the product box is still required, a repeat adds nothing', async () => {
  behave.enabled = ['901'];
  const payload = checkout([[1, '100.00', 1, false], [2, '10.00', 1, false]]);
  assert.equal((await orders.processOrderCreate(STORE, payload)).status, 'ignored', 'the webhook alone ignores it');
  assert.equal((await orders.processOrderCreate(STORE, payload, { force: true })).status, 'processed');
  assert.equal(db.table('orders').length, 1);
  assert.equal(calls.tags.length, 1);
  assert.equal((await orders.processOrderCreate(STORE, payload, { force: true })).status, 'duplicate');
  assert.equal(db.table('orders').length, 1, 'no second order');
});

test('the same order delivered twice: one order, one tag, one address change, one email', async () => {
  await orders.processOrderCreate(STORE, checkout([[1, '100.00', 1, true], [2, '10.00', 1, false]]));
  const again = await orders.processOrderCreate(STORE, checkout([[1, '100.00', 1, true], [2, '10.00', 1, false]]));
  assert.equal(again.status, 'duplicate');
  assert.equal(db.table('orders').length, 1);
  assert.equal(calls.tags.length, 1);
  assert.equal(calls.addressUpdates.length, 1);
  assert.equal(calls.emails.length, 1);
});

test('the tag is the FIRST thing done to the order, before the address, the hold, the internal order and the email', async () => {
  await orders.processOrderCreate(STORE, checkout([[1, '100.00', 1, true]], { financial_status: 'pending', payment_gateway_names: ['Cash on Delivery (COD)'] }));
  assert.equal(calls.seq[0], 'tag', JSON.stringify(calls.seq));
  assert.ok(calls.seq.indexOf('tag') < calls.seq.indexOf('address'));
  assert.ok(calls.seq.indexOf('tag') < calls.seq.indexOf('hold'));
  assert.equal(calls.tags.length, 1);
});

test('when Shopify refuses the atelier address (the store does not ship there) the order is STILL Stitch&Ship: tagged, in the app, on hold, the problem shown, and Try again fixes it', async () => {
  behave.addressRefused = 'Could not change the shipping address: Country/region not supported';
  const result = await orders.processOrderCreate(STORE, checkout([[1, '100.00', 1, true], [2, '10.00', 1, false]]));
  assert.equal(result.status, 'processed');
  assert.equal(result.warnings.length, 1);
  assert.deepEqual(calls.tags.map((t) => t.tag), ['stitchship']);
  assert.equal(db.table('orders').length, 1);
  assert.equal(calls.releases.length, 0, 'the address is not the atelier\'s: the shipment stays on hold');
  assert.equal(row().hold_state, 'held');
  assert.match(row().last_error, /shipping zones/);
  assert.equal((await orders.shopifyQueue())[0].needs_attention, true);
  behave.addressRefused = null;
  const retry = await orders.retryShopifyOrder(row().id);
  assert.equal(retry.status, 'repaired');
  assert.equal(calls.addressUpdates.length, 1);
  assert.equal(row().hold_state, 'released');
  assert.equal(row().last_error, null);
  assert.equal(db.table('orders').length, 1);
  assert.equal(calls.emails.length, 1);
});

test('if the tag cannot be set it is tried again, then recorded and shown, and Try again tags the order', async () => {
  behave.tagFailCount = 1;
  const once = await orders.processOrderCreate(STORE, checkout([[1, '100.00', 1, true]]));
  assert.deepEqual(once.warnings, []);
  assert.deepEqual(calls.tags.map((t) => t.tag), ['stitchship']);
  beforeEachReset();
  behave.tagFailCount = 2;
  const twice = await orders.processOrderCreate(STORE, checkout([[1, '100.00', 1, true]]));
  assert.equal(twice.warnings.length, 1);
  assert.match(row().last_error, /Could not tag the order/);
  assert.equal(calls.tags.length, 0);
  assert.equal((await orders.shopifyQueue())[0].needs_attention, true);
  const retry = await orders.retryShopifyOrder(row().id);
  assert.equal(retry.status, 'repaired');
  assert.deepEqual(calls.tags.map((t) => t.tag), ['stitchship']);
  assert.equal(row().last_error, null);
});

test('a Shopify failure while asking which products are enabled is retried, never silently treated as "a normal order"', async () => {
  behave.enabledFails = true;
  await assert.rejects(() => orders.processOrderCreate(STORE, checkout([[1, '100.00', 1, true]])), /Shopify is down/);
  assert.equal(db.table('shopify_orders').length, 0);
  assert.equal(calls.tags.length, 0);
  behave.enabledFails = false;
  assert.equal((await orders.processOrderCreate(STORE, checkout([[1, '100.00', 1, true]]))).status, 'processed');
});

test('the log says, per line, the product, the metafield value Shopify gave and the decision', async () => {
  behave.enabled = ['901'];
  const real = console.info;
  const lines = [];
  console.info = (...a) => lines.push(a.join(' '));
  try {
    await orders.processOrderCreate(STORE, checkout([[1, '100.00', 1, true], [2, '10.00', 1, true]]));
  } finally {
    console.info = real;
  }
  assert.ok(lines.some((l) => /line 1 "Product 1" product 901 metafield \$app:stitchship\.enabled=true -> Stitch&Ship/.test(l)));
  assert.ok(lines.some((l) => /line 2 "Product 2" product 902 metafield \$app:stitchship\.enabled=not set -> normal/.test(l)));
  assert.ok(lines.some((l) => /1 of 2 line\(s\) qualify, so the WHOLE order is one Stitch&Ship order/.test(l)));
});

test('without the Stitch&Ship address in the settings the order is still taken in, tagged and flagged (a clear error), and Try again works once it is set', async () => {
  const saved = db.table('platform_settings').splice(0);
  const result = await orders.processOrderCreate(STORE, checkout([[1, '100.00', 1, true]]));
  assert.equal(result.status, 'processed');
  assert.match(row().last_error, /Stitch&Ship shipping address is not set/);
  assert.equal(calls.addressUpdates.length, 0);
  assert.deepEqual(calls.tags.map((t) => t.tag), ['stitchship']);
  db.table('platform_settings').push(...saved);
  const retry = await orders.retryShopifyOrder(row().id);
  assert.equal(retry.status, 'repaired');
  assert.equal(calls.addressUpdates.length, 1);
});

test('an order an earlier version of the app split in Shopify is left exactly as it is', async () => {
  db.table('shopify_orders').push({ id: 'old1', store_id: 'st1', shopify_order_id: '5001', shopify_order_name: '#1001', state: 'split', payload: null, address_state: 'unknown', hold_state: 'released' });
  const again = await orders.processOrderCreate(STORE, checkout([[1, '100.00', 1, true], [2, '10.00', 1, false]]));
  assert.equal(again.status, 'duplicate');
  assert.equal(calls.tags.length, 0);
  assert.equal(calls.addressUpdates.length, 0);
  await assert.rejects(() => orders.retryShopifyOrder('old1'), /earlier version of the app split this order/);
});

test('cancelling a Stitch&Ship order in Shopify cancels the order in the app', async () => {
  await orders.processOrderCreate(STORE, checkout([[1, '100.00', 1, true], [2, '10.00', 1, false]]));
  await orders.processOrderCancelled(STORE, checkout([[1, '100.00', 1, true]], { cancelled_at: '2026-10-22T10:00:00Z' }));
  assert.equal(row().state, 'cancelled');
  assert.equal(order().status, 'cancelled');
});
