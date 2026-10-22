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
      // Shopify's own payment record of the order (the transactions), the collection of the clothing products, and who belongs to it
      fetchOrderFinancials: async (store, gid) => {
        calls.financialReads.push(gid);
        if (behave.financialsFail) throw new Error('Shopify is down');
        return behave.financials ? behave.financials(gid) : null;
      },
      // splitting in Shopify: the new order, the lookup of an earlier one, taking lines off the original, tag + note
      createShopifyOrder: async (store, order) => {
        if (behave.createFails) throw new Error('Shopify refused the new order');
        calls.createdOrders.push(order);
        const total = behave.childTotal ?? Math.round(order.lineItems.reduce((n, l) => n + Math.round(Number(l.priceSet.shopMoney.amount) * 100) * l.quantity + l.taxLines.reduce((t, x) => t + Math.round(Number(x.priceSet.shopMoney.amount) * 100), 0), 0) - (order.discountCode ? Math.round(Number(order.discountCode.itemFixedDiscountCode.amountSet.shopMoney.amount) * 100) : 0));
        const made = { id: `gid://shopify/Order/900${calls.createdOrders.length}`, name: `#${1100 + calls.createdOrders.length}`, total_cents: total, financial_status: order.financialStatus.toLowerCase() };
        calls.madeOrders.push(made);
        return made;
      },
      findOrderBySourceIdentifier: async (store, sid) => {
        calls.sourceLookups.push(sid);
        return behave.alreadyMade ? calls.madeOrders[0] ?? null : null;
      },
      removeLinesFromOrder: async (store, gid, targets, note) => {
        calls.edits.push({ gid, targets, note });
        if (behave.editFails) throw new Error('Shopify could not edit the order');
        return { total_cents: behave.originalAfter ?? 0 };
      },
      tagAndNoteOrder: async (store, gid, tag, line) => {
        if (behave.tagNoteFails) throw new Error('no write access');
        calls.tagNotes.push({ gid, tag, line });
      },
      productsStitchEnabled: async (store, ids) => {
        calls.enabledChecks.push(ids.map(String));
        if (behave.enabledFails) throw new Error('Shopify is down');
        return new Set(ids.filter(Boolean).map(String).filter((id) => !behave.enabled || behave.enabled.includes(id)));
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
  calls = { holds: [], releases: [], tags: [], addressUpdates: [], emails: [], admins: [], users: [], sms: [], financialReads: [], enabledChecks: [], createdOrders: [], madeOrders: [], sourceLookups: [], edits: [], tagNotes: [] };
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
      shopify_order_splits: [],
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

// ───────────── mixed orders: clothing eligibility, the split, tags, addresses ─────────────

const mkLine = (id, price, quantity, extra = {}) => ({ id, title: `Product ${id}`, variant_title: 'M', sku: `SKU-${id}`, product_id: 900 + id, variant_id: 800 + id, price, quantity, properties: [], discount_allocations: [], tax_lines: [], ...extra });
const MARK = [{ name: '_stitchship', value: 'yes' }, { name: '_stitchship_ref', value: 'SS-AB12CD' }];
/** The customer's five-product checkout: A and B are ticked for stitching, C, D and E are normal. */
const mixedOrder = (extra = {}) =>
  shopifyOrder({
    note_attributes: [],
    taxes_included: false,
    financial_status: 'paid',
    total_price: '311.30',
    line_items: [
      mkLine(1, '100.00', 1, { properties: MARK, tax_lines: [{ price: '10.00' }] }),
      mkLine(2, '50.00', 2, { properties: MARK, discount_allocations: [{ amount: '10.00' }], tax_lines: [{ price: '9.00' }] }),
      mkLine(3, '30.00', 1, { tax_lines: [{ price: '3.00' }] }),
      mkLine(4, '20.00', 1, { discount_allocations: [{ amount: '2.00' }], tax_lines: [{ price: '1.80' }] }),
      mkLine(5, '10.00', 3, { tax_lines: [{ price: '3.00' }] }),
    ],
    shipping_lines: [{ price: '15.00', discounted_price: '15.00', tax_lines: [{ price: '1.50' }] }],
    ...extra,
  });
const splits = () => db.table('shopify_order_splits');
const splitOf = (kind) => splits().find((r) => r.kind === kind);
const unitsOf = () => db.table('order_units').map((u) => u.unit_title);

test('a mixed order: the customer\'s stitching order has only the ticked lines, worth only those lines', async () => {
  const result = await orders.processOrderCreate(STORE, mixedOrder());
  assert.equal(result.status, 'processed');
  assert.equal(db.table('orders').length, 1, 'one internal order');
  assert.equal(unitsOf().length, 3, 'A once and B twice: B has a quantity of 2');
  assert.ok(unitsOf().every((t) => /Product [12]/.test(t)), 'no normal product reached the stitching order');
  assert.equal(order().brand_order_total, 220.69, 'its total is the stitching share, not the whole checkout');
  assert.equal(order().brand_order_currency, 'PKR');
});

test('the split is saved once per group with products, amounts, payment and the original order\'s reference', async () => {
  await orders.processOrderCreate(STORE, mixedOrder());
  assert.equal(splits().length, 2);
  const s = splitOf('stitchship');
  const n = splitOf('normal');
  assert.equal(s.shopify_order_id, '5001');
  assert.equal(s.shopify_order_name, '#1001');
  assert.equal(s.order_id, order().id, 'the stitching group points at the internal order');
  assert.equal(n.order_id, null, 'the normal group is not an operational order of ours');
  assert.deepEqual(s.line_ids, ['1', '2']);
  assert.deepEqual(n.line_ids, ['3', '4', '5']);
  assert.equal(s.total, 220.69);
  assert.equal(n.total, 90.61);
  assert.equal(s.subtotal + n.subtotal, 280);
  assert.equal(s.currency, 'PKR');
  assert.equal(s.reconciled, true);
  assert.equal(s.tag, 'stitchship');
  assert.equal(n.tag, null);
});

test('only the stitching order is tagged stitchship: a mixed Shopify order carries the mixed tag, never the plain one', async () => {
  await orders.processOrderCreate(STORE, mixedOrder());
  assert.deepEqual(calls.tags.map((t) => t.tag), ['stitchship-mixed']);
  beforeEachReset();
  await orders.processOrderCreate(STORE, shopifyOrder({ financial_status: 'pending' }));
  assert.deepEqual(calls.tags.map((t) => t.tag), ['stitchship'], 'an order that is all stitching keeps the plain tag');
  assert.equal(splits().length, 1, 'and has only a stitching group');
});

test('the original payment is allocated, counted once, and each group is paid only to the extent the payment covers it', async () => {
  behave.financials = () => ({ financial_status: 'paid', total_received: 311.3, total_refunded: 0, outstanding: 0, transactions_ok: true, refunds: [] });
  await orders.processOrderCreate(STORE, mixedOrder());
  assert.equal(calls.financialReads.length, 1, 'Shopify was asked for the real transactions');
  const s = splitOf('stitchship');
  const n = splitOf('normal');
  assert.equal(s.payment_status, 'paid');
  assert.equal(n.payment_status, 'paid');
  assert.equal(s.payment_verified, true);
  assert.equal(Math.round((s.amount_paid + n.amount_paid) * 100), 31130, 'the payment is not counted twice');
  assert.equal(order().payment_type, 'NON_COD', 'a paid order asks the customer for nothing more');
  assert.equal(order().cod_payment_status, null);
});

test('an unpaid mixed order: the customer is asked for the stitching share only, never the whole checkout', async () => {
  behave.financials = () => ({ financial_status: 'pending', total_received: 0, total_refunded: 0, outstanding: 311.3, transactions_ok: true, refunds: [] });
  await orders.processOrderCreate(STORE, mixedOrder({ financial_status: 'pending' }));
  assert.equal(order().payment_type, 'COD');
  assert.equal(order().cod_amount, 220.69, 'not 311.30');
  assert.equal(order().cod_currency, 'PKR');
  assert.equal(splitOf('stitchship').payment_status, 'unpaid');
  assert.equal(splitOf('stitchship').outstanding, 220.69);
  assert.equal(splitOf('normal').outstanding, 90.61);
});

test('a partly paid mixed order: each group is owed only what the one payment does not cover', async () => {
  behave.financials = () => ({ financial_status: 'partially_paid', total_received: 100, total_refunded: 0, outstanding: 211.3, transactions_ok: true, refunds: [] });
  await orders.processOrderCreate(STORE, mixedOrder({ financial_status: 'partially_paid', total_outstanding: '211.30', total_received: '100.00' }));
  assert.equal(splitOf('stitchship').payment_status, 'partially_paid');
  assert.equal(splitOf('stitchship').amount_paid, 70.89);
  assert.equal(order().payment_type, 'COD');
  assert.equal(order().cod_amount, 149.8, 'what the stitching share still owes: 220.69 - 70.89');
});

test('if Shopify\'s transactions cannot be read, the order is still taken in and nothing is called verified paid', async () => {
  behave.financialsFail = true;
  const result = await orders.processOrderCreate(STORE, mixedOrder());
  assert.equal(result.status, 'processed');
  assert.equal(splitOf('stitchship').payment_status, 'paid_unverified');
  assert.equal(splitOf('stitchship').payment_verified, false);
  assert.equal(splitOf('stitchship').payment_source, 'webhook');
  const queue = await orders.shopifyQueue();
  assert.equal(queue[0].needs_attention, true, 'an administrator is shown that the payment is not verified');
  // Shopify is back: "Try again" checks the saved split with Shopify and settles the payment
  behave.financialsFail = false;
  behave.financials = () => ({ financial_status: 'paid', total_received: 311.3, total_refunded: 0, outstanding: 0, transactions_ok: true, refunds: [] });
  const again = await orders.retryShopifyOrder(row().id);
  assert.equal(again.status, 'payment_rechecked');
  assert.equal(splitOf('stitchship').payment_status, 'paid');
  assert.equal(splitOf('stitchship').payment_verified, true);
  assert.equal(splits().length, 2, 'no duplicate rows');
});

test('the address each group uses: the stitching address on the stitching order, the customer\'s own for the normal items', async () => {
  // the brand order has one shipping address and it is the atelier: the normal items cannot be delivered to the customer by this order
  await orders.processOrderCreate(STORE, mixedOrder());
  const s = splitOf('stitchship');
  const n = splitOf('normal');
  assert.equal(s.address.kind, 'atelier');
  assert.equal(s.address.matches_atelier, true);
  assert.equal(n.address.kind, 'billing', 'the customer\'s own address is the intended one');
  assert.equal(n.address.needs_separate_delivery, true);
  assert.equal(n.address.city, 'Dubai');
  assert.ok(calls.admins.some((a) => /mixes stitching and normal items/.test(a.title)), 'the admins are told');
  assert.equal((await orders.shopifyQueue())[0].needs_attention, true);
  assert.equal(calls.addressUpdates.length, 0, 'no address was changed by the app');
});

test('a mixed order whose address is not the atelier keeps the customer\'s address for the normal items and holds the shipment as before', async () => {
  await orders.processOrderCreate(STORE, mixedOrder({ shipping_address: atelierAddress({ address1: '5 Canal Road', address2: '', city: 'Dubai', company: '' }) }));
  assert.equal(splitOf('stitchship').address.matches_atelier, false);
  assert.equal(splitOf('normal').address.kind, 'shipping');
  assert.equal(splitOf('normal').address.needs_separate_delivery, undefined);
  assert.equal(row().address_state, 'address_mismatch');
  assert.equal(row().hold_state, 'held');
  assert.equal(calls.addressUpdates.length, 0);
});

test('the same mixed order delivered twice makes one order, one tag and no duplicate split rows', async () => {
  await orders.processOrderCreate(STORE, mixedOrder());
  const again = await orders.processOrderCreate(STORE, mixedOrder());
  assert.equal(again.status, 'duplicate');
  assert.equal(db.table('orders').length, 1);
  assert.equal(calls.tags.length, 1);
  assert.equal(splits().length, 2);
  assert.equal(calls.emails.length, 1);
});

test('a failure while saving the split does not lose the order or make a second one, and "Try again" is safe', async () => {
  const real = db.from;
  let failing = true;
  db.from = (table) => (table === 'shopify_order_splits' && failing ? { upsert: async () => ({ error: { message: 'connection reset' } }) } : real(table));
  const result = await orders.processOrderCreate(STORE, mixedOrder());
  assert.equal(result.status, 'processed');
  assert.equal(db.table('orders').length, 1);
  assert.match(row().last_error, /price split/);
  assert.ok(calls.admins.some((a) => /price split/.test(a.title)));
  failing = false;
  db.from = real;
  assert.equal(splits().length, 0);
  assert.ok(row().payload, 'the Shopify copy is kept while the split is not saved');
  // "Try again" builds the split from the kept copy: no second order, no second email, no second tag
  const retry = await orders.retryShopifyOrder(row().id);
  assert.equal(retry.status, 'split_saved');
  assert.equal(splits().length, 2);
  assert.equal(row().last_error, null);
  assert.equal(db.table('orders').length, 1);
  assert.equal(calls.emails.length, 1);
  assert.equal(calls.tags.length, 1);
  assert.equal(row().payload, null, 'now that everything is saved the personal data is cleared as before');
  // and again: nothing changes
  const twice = await orders.retryShopifyOrder(row().id);
  assert.equal(splits().length, 2);
  assert.equal(twice.status, 'payment_rechecked');
});

// ───────────── only products with "Stitch&Ship available" ticked are stitched ─────────────

test('only ticked lines whose product has "Stitch&Ship available" in Shopify are stitched; the rest follow the normal flow', async () => {
  behave.enabled = ['901']; // product A is enabled; B carries the tick on the page but is not enabled in Shopify
  const result = await orders.processOrderCreate(STORE, mixedOrder());
  assert.equal(result.status, 'processed');
  assert.equal(calls.enabledChecks.length, 1, 'Shopify itself was asked, once');
  assert.deepEqual(calls.enabledChecks[0].sort(), ['901', '902'], 'only the ticked lines were checked');
  assert.deepEqual(unitsOf(), ['Product 1 · M'], 'only the enabled product was taken in');
  assert.deepEqual(splitOf('stitchship').line_ids, ['1']);
  assert.deepEqual(splitOf('normal').line_ids, ['2', '3', '4', '5'], 'B is a normal line: it carried the tick but is not enabled');
  assert.ok(calls.admins.some((a) => /not enabled for Stitch&Ship/.test(a.title)));
});

test('a tick on a product that is not enabled, and nothing else ticked, is not a Stitch&Ship order at all', async () => {
  behave.enabled = [];
  const result = await orders.processOrderCreate(STORE, mixedOrder());
  assert.equal(result.status, 'ignored');
  assert.equal(db.table('orders').length, 0);
  assert.equal(db.table('shopify_orders').length, 0, 'nothing is stored');
  assert.equal(calls.tags.length, 0, 'no stitchship tag lands on an ordinary order');
});

test('products without a tick never become stitching, even when enabled in Shopify', async () => {
  behave.enabled = ['901', '902', '903', '904', '905'];
  await orders.processOrderCreate(STORE, mixedOrder());
  assert.deepEqual(splitOf('stitchship').line_ids, ['1', '2']);
  assert.deepEqual(splitOf('normal').line_ids, ['3', '4', '5']);
  assert.deepEqual(calls.enabledChecks[0].sort(), ['901', '902'], 'only the ticked lines are checked');
});

test('a ticked line without a product (a custom item) cannot be checked and is not stitched', async () => {
  const o = mixedOrder();
  o.line_items[0].product_id = null;
  await orders.processOrderCreate(STORE, o);
  assert.deepEqual(splitOf('stitchship').line_ids, ['2']);
});

test('the cart-attribute checkout (every line marked) is also limited to enabled products', async () => {
  behave.enabled = ['9001'];
  const o = shopifyOrder({ line_items: [{ id: 111, product_id: 9001, title: 'Suit', quantity: 1, price: '6250.00', properties: [] }, { id: 222, product_id: 9002, title: 'Scarf', quantity: 1, price: '500.00', properties: [] }], total_price: '6750.00', financial_status: 'paid' });
  await orders.processOrderCreate(STORE, o);
  assert.deepEqual(splitOf('stitchship').line_ids, ['111']);
  assert.deepEqual(splitOf('normal').line_ids, ['222']);
});

test('if Shopify cannot be asked which products are enabled, nothing is stored and the delivery is retried cleanly', async () => {
  behave.enabledFails = true;
  await assert.rejects(() => orders.processOrderCreate(STORE, mixedOrder()), /Shopify is down/);
  assert.equal(db.table('shopify_orders').length, 0);
  assert.equal(db.table('orders').length, 0);
  assert.equal(calls.tags.length, 0);
  behave.enabledFails = false;
  const again = await orders.processOrderCreate(STORE, mixedOrder());
  assert.equal(again.status, 'processed');
  assert.equal(db.table('orders').length, 1, 'one order after the retry');
  assert.equal(splits().length, 2);
});

// ───────────── refunds, cancellations ─────────────

test('a refund in Shopify updates the split: the refunded line\'s group only, with nothing counted twice', async () => {
  behave.financials = () => ({ financial_status: 'paid', total_received: 311.3, total_refunded: 0, outstanding: 0, transactions_ok: true, refunds: [] });
  await orders.processOrderCreate(STORE, mixedOrder());
  behave.financials = () => ({ financial_status: 'partially_refunded', total_received: 311.3, total_refunded: 110, outstanding: 0, transactions_ok: true, refunds: [{ total: 11000, lines: [{ line_id: '1', cents: 11000 }] }] });
  await orders.processOrderUpdated(STORE, mixedOrder({ financial_status: 'partially_refunded' }));
  assert.equal(splitOf('stitchship').refunded, 110);
  assert.equal(splitOf('stitchship').payment_status, 'partially_refunded');
  assert.equal(splitOf('normal').refunded, 0);
  assert.equal(splitOf('normal').payment_status, 'paid');
  assert.equal(splits().length, 2, 'the same two rows, updated');
  // the same event again changes nothing
  await orders.processOrderUpdated(STORE, mixedOrder({ financial_status: 'partially_refunded' }));
  assert.equal(splitOf('stitchship').refunded, 110);
});

test('a payment that arrives later settles the groups: unpaid becomes paid once Shopify says so, and the app asks nothing more', async () => {
  behave.financials = () => ({ financial_status: 'pending', total_received: 0, total_refunded: 0, outstanding: 311.3, transactions_ok: true, refunds: [] });
  await orders.processOrderCreate(STORE, mixedOrder({ financial_status: 'pending' }));
  assert.equal(order().payment_type, 'COD');
  behave.financials = () => ({ financial_status: 'paid', total_received: 311.3, total_refunded: 0, outstanding: 0, transactions_ok: true, refunds: [] });
  await orders.processOrderUpdated(STORE, mixedOrder({ financial_status: 'paid' }));
  assert.equal(splitOf('stitchship').payment_status, 'paid');
  assert.equal(splitOf('normal').payment_status, 'paid');
  assert.equal(order().payment_type, 'NON_COD');
});

test('cancelling the Shopify order closes both groups: nothing is shown as owed', async () => {
  behave.financials = () => ({ financial_status: 'pending', total_received: 0, total_refunded: 0, outstanding: 311.3, transactions_ok: true, refunds: [] });
  await orders.processOrderCreate(STORE, mixedOrder({ financial_status: 'pending' }));
  await orders.processOrderCancelled(STORE, mixedOrder({ financial_status: 'voided' }));
  assert.equal(splitOf('stitchship').payment_status, 'cancelled');
  assert.equal(splitOf('normal').payment_status, 'cancelled');
  assert.equal(splitOf('stitchship').outstanding, 0);
  assert.equal(row().state, 'cancelled');
});

test('the admin queue carries the split of every order', async () => {
  await orders.processOrderCreate(STORE, mixedOrder());
  const queue = await orders.shopifyQueue();
  assert.equal(queue[0].split.length, 2);
  assert.deepEqual(queue[0].split.map((s) => s.kind), ['stitchship', 'normal']);
});

// ───────────── splitting in Shopify: a new order for the Stitch&Ship lines, the lines taken off the original ─────────────

const HOME = { first_name: 'Ali', last_name: 'Khan', address1: '5 Canal Road', address2: '', city: 'Lahore', province: 'Punjab', zip: '54000', country: 'Pakistan', country_code: 'PK', phone: '+923001112222' };
/** The customer's checkout of ten products at 10.00 (tax 1.00 each, shipping 20.00); the first `ticked` are Stitch&Ship. Total 130.00. */
const tenProducts = (ticked, extra = {}) =>
  shopifyOrder({
    note_attributes: [],
    taxes_included: false,
    financial_status: 'paid',
    total_price: '130.00',
    shipping_address: HOME,
    line_items: Array.from({ length: 10 }, (_, i) => mkLine(i + 1, '10.00', 1, { properties: i < ticked ? MARK : [], tax_lines: [{ title: 'GST', rate: 0.1, price: '1.00' }] })),
    shipping_lines: [{ title: 'Standard', price: '20.00', discounted_price: '20.00', tax_lines: [] }],
    ...extra,
  });
/** What the original order should total once k lines are off it: the other lines with their tax, and all the shipping. */
const normalCents = (k) => (10 - k) * 1100 + 2000;
const splitStore = () => {
  STORE.settings = { auto_split: true };
  db.table('shopify_stores')[0].settings = STORE.settings; // "Try again" reads the store from the database
  behave.originalAfter = undefined;
};
const prepare = (k) => {
  splitStore();
  behave.originalAfter = normalCents(k);
};
const paidFinancials = (received) => () => ({ financial_status: received >= 130 ? 'paid' : 'partially_paid', total_received: received, total_refunded: 0, outstanding: 130 - received, transactions_ok: true, refunds: [], transactions: [{ id: '4001', kind: 'sale', gateway: 'shopify_payments', amount: received }] });

test('10 products, 1 Stitch&Ship: a new order with that 1 product, and the other 9 stay on the original order', async () => {
  prepare(1);
  behave.financials = paidFinancials(130);
  const result = await orders.processOrderCreate(STORE, tenProducts(1));
  assert.equal(result.status, 'split');
  assert.equal(calls.createdOrders.length, 1, 'exactly one new order');
  assert.equal(calls.createdOrders[0].lineItems.length, 1);
  assert.equal(calls.createdOrders[0].lineItems[0].title, 'Product 1');
  assert.equal(calls.edits.length, 1);
  assert.equal(calls.edits[0].targets.length, 1, 'one line taken off the original');
  assert.equal(calls.edits[0].targets[0].title, 'Product 1');
  assert.equal(splitOf('stitchship').lines.length, 1);
  assert.equal(splitOf('normal').lines.length, 9);
  assert.equal(row().state, 'split');
});

test('10 products, 4 Stitch&Ship: ONE new order with all 4, and the other 6 stay together on the original', async () => {
  prepare(4);
  behave.financials = paidFinancials(130);
  await orders.processOrderCreate(STORE, tenProducts(4));
  assert.equal(calls.createdOrders.length, 1, 'not one order per product');
  assert.deepEqual(calls.createdOrders[0].lineItems.map((l) => l.title), ['Product 1', 'Product 2', 'Product 3', 'Product 4']);
  assert.equal(calls.edits[0].targets.length, 4);
  assert.deepEqual(splitOf('stitchship').line_ids, ['1', '2', '3', '4']);
  assert.deepEqual(splitOf('normal').line_ids, ['5', '6', '7', '8', '9', '10']);
  assert.equal(splitOf('stitchship').total, 44);
  assert.equal(splitOf('normal').total, 86, '6 lines with tax (66) and all the shipping (20)');
});

test('10 products, all Stitch&Ship: no empty normal order, no new order; the order itself goes to the atelier', async () => {
  splitStore();
  behave.financials = paidFinancials(130);
  const result = await orders.processOrderCreate(STORE, tenProducts(10, { total_price: '130.00' }));
  assert.equal(result.status, 'processed');
  assert.equal(calls.createdOrders.length, 0, 'nothing to split off');
  assert.equal(calls.edits.length, 0);
  assert.equal(splits().filter((r) => r.kind === 'normal').length, 0, 'no empty normal order');
  assert.equal(calls.addressUpdates.length, 1, 'the delivery address becomes the atelier\'s');
  assert.equal(calls.addressUpdates[0].address.address1, 'House 12 Street 4 Gulberg');
  assert.match(calls.addressUpdates[0].address.address2, /^SS-/);
  assert.ok(calls.tagNotes.some((t) => /own delivery address: 5 Canal Road/.test(t.line)), 'the customer\'s own address is kept in the note');
  assert.equal(db.table('orders').length, 1, 'the customer\'s Stitch&Ship order in the app');
  assert.equal(order().payment_type, 'NON_COD');
  assert.equal(calls.holds.length, 1);
  assert.equal(calls.releases.length, 1, 'the address is now the atelier\'s: the shipment is released');
});

test('10 products, none Stitch&Ship: nothing is split, nothing is stored', async () => {
  splitStore();
  const result = await orders.processOrderCreate(STORE, tenProducts(0));
  assert.equal(result.status, 'ignored');
  assert.equal(calls.createdOrders.length, 0);
  assert.equal(calls.edits.length, 0);
  assert.equal(db.table('shopify_orders').length, 0);
  assert.equal(calls.tags.length + calls.tagNotes.length, 0);
});

test('a store that has not switched splitting on keeps the old behaviour: no new order, no edit', async () => {
  STORE.settings = {};
  behave.financials = paidFinancials(130);
  const result = await orders.processOrderCreate(STORE, tenProducts(4));
  assert.equal(result.status, 'processed');
  assert.equal(calls.createdOrders.length, 0);
  assert.equal(calls.edits.length, 0);
});

test('prepaid: the new order records the payment as "paid on the original order" with its real transactions, for its own total only', async () => {
  prepare(4);
  behave.financials = paidFinancials(130);
  await orders.processOrderCreate(STORE, tenProducts(4));
  const child = calls.createdOrders[0];
  assert.equal(child.financialStatus, 'PAID');
  assert.equal(child.transactions.length, 1);
  assert.equal(child.transactions[0].amountSet.shopMoney.amount, '44.00', 'its own total, not the whole checkout');
  assert.equal(child.transactions[0].kind, 'SALE');
  assert.equal(child.transactions[0].status, 'SUCCESS');
  assert.match(child.transactions[0].gateway, /Paid on order #1001/);
  const receipt = JSON.parse(child.transactions[0].receiptJson);
  assert.equal(receipt.split_from_order, '#1001');
  assert.equal(receipt.original_transactions[0].id, '4001', 'the original payment stays traceable');
  assert.match(receipt.note, /No new charge/);
  assert.equal(child.shippingLines, undefined, 'the shipping stays with the original order');
  assert.equal(splitOf('stitchship').payment_status, 'paid');
  assert.equal(splitOf('stitchship').overpaid_on_original, 44, 'the original shows 44.00 more paid than it now totals: it belongs to the new order');
});

test('COD or unpaid: the new order is Pending with no payment at all, and its total is what the customer will pay on delivery', async () => {
  prepare(4);
  behave.financials = () => ({ financial_status: 'pending', total_received: 0, total_refunded: 0, outstanding: 130, transactions_ok: true, refunds: [], transactions: [] });
  await orders.processOrderCreate(STORE, tenProducts(4, { financial_status: 'pending' }));
  const child = calls.createdOrders[0];
  assert.equal(child.financialStatus, 'PENDING');
  assert.equal(child.transactions, undefined, 'no payment is invented');
  assert.equal(splitOf('stitchship').total, 44);
  assert.equal(splitOf('stitchship').outstanding, 44);
  assert.equal(splitOf('normal').outstanding, 86);
  assert.equal(splitOf('stitchship').payment_status, 'unpaid');
});

test('a payment Shopify\'s transactions cannot confirm is never recorded as paid on the new order', async () => {
  prepare(4);
  behave.financialsFail = true;
  await orders.processOrderCreate(STORE, tenProducts(4));
  assert.equal(calls.createdOrders[0].financialStatus, 'PENDING');
  assert.equal(calls.createdOrders[0].transactions, undefined);
});

test('a part-paid original: the new order records only its share of what was really paid', async () => {
  prepare(4);
  behave.financials = paidFinancials(65);
  await orders.processOrderCreate(STORE, tenProducts(4, { financial_status: 'partially_paid' }));
  const child = calls.createdOrders[0];
  assert.equal(child.financialStatus, 'PARTIALLY_PAID');
  assert.equal(child.transactions[0].amountSet.shopMoney.amount, '22.00', '44 of 130, on 65 paid');
});

test('the new order keeps variant, quantity, price, tax, properties and the customer; its address is the atelier\'s; the original\'s address is not touched', async () => {
  prepare(4);
  behave.financials = paidFinancials(130);
  await orders.processOrderCreate(STORE, tenProducts(4));
  const child = calls.createdOrders[0];
  const first = child.lineItems[0];
  assert.equal(first.variantId, 'gid://shopify/ProductVariant/801');
  assert.equal(first.quantity, 1);
  assert.equal(first.priceSet.shopMoney.amount, '10.00');
  assert.equal(first.taxLines[0].priceSet.shopMoney.amount, '1.00');
  assert.ok(first.properties.some((p) => p.name === '_stitchship' && p.value === 'yes'));
  assert.equal(child.email, 'Ali@Example.com');
  assert.equal(child.shippingAddress.company, 'Stitch&Ship Atelier');
  assert.equal(child.shippingAddress.address1, 'House 12 Street 4 Gulberg');
  assert.match(child.shippingAddress.address2, /^SS-AB12CD$/);
  assert.equal(child.shippingAddress.city, 'Lahore');
  assert.equal(child.billingAddress.address1, '5 Canal Road', 'the customer\'s own billing address');
  assert.equal(calls.addressUpdates.length, 0, 'the original order\'s address is never changed');
  assert.deepEqual(child.tags, ['stitchship']);
  assert.ok(child.customAttributes.some((a) => a.key === 'stitchship_split_from' && a.value === '#1001'));
  assert.equal(child.sourceIdentifier, 'stitchship-split-5001');
  const s = splitOf('stitchship');
  const n = splitOf('normal');
  assert.equal(s.ship_to.address1, 'House 12 Street 4 Gulberg');
  assert.equal(n.ship_to.address1, '5 Canal Road', 'the normal group keeps the customer\'s original address');
  assert.equal(n.ship_to.city, 'Lahore');
  assert.equal(s.reference, '#1101', 'the new order\'s number');
  assert.equal(n.reference, '#1001', 'the original order, now only normal items');
  assert.equal(s.original_order_name, '#1001');
});

test('the original is tagged stitchship-split (not stitchship), noted, and its shipment held during the split and released after', async () => {
  prepare(4);
  behave.financials = paidFinancials(130);
  await orders.processOrderCreate(STORE, tenProducts(4));
  assert.deepEqual(calls.tagNotes.map((t) => t.tag), ['stitchship-split']);
  assert.match(calls.tagNotes[0].line, /moved to order #1101/);
  assert.equal(calls.tags.length, 0, 'the plain stitchship tag is only on the Stitch&Ship order');
  assert.equal(calls.holds.length, 1);
  assert.equal(calls.releases.length, 1);
  assert.equal(row().hold_state, 'released');
});

test('the same delivery twice makes one new order and one edit', async () => {
  prepare(4);
  behave.financials = paidFinancials(130);
  await orders.processOrderCreate(STORE, tenProducts(4));
  const again = await orders.processOrderCreate(STORE, tenProducts(4));
  assert.equal(again.status, 'duplicate');
  assert.equal(calls.createdOrders.length, 1);
  assert.equal(calls.edits.length, 1);
  assert.equal(splits().length, 2);
});

test('a delivery that arrives while the split is running is refused, not run twice', async () => {
  prepare(4);
  behave.financials = paidFinancials(130);
  await orders.processOrderCreate(STORE, tenProducts(4)).catch(() => undefined);
  db.table('shopify_orders')[0].state = 'split_pending';
  const second = await orders.processOrderCreate(STORE, tenProducts(4));
  assert.equal(second.status, 'duplicate');
  assert.equal(calls.createdOrders.length, 1);
});

test('if the new order cannot be made, the original is not touched, stays on hold, and Try again finishes the job', async () => {
  prepare(4);
  behave.financials = paidFinancials(130);
  behave.createFails = true;
  await assert.rejects(() => orders.processOrderCreate(STORE, tenProducts(4)), /refused the new order/);
  assert.equal(calls.edits.length, 0, 'the original was not edited');
  assert.equal(row().state, 'split_failed');
  assert.equal(row().hold_state, 'held', 'nothing ships meanwhile');
  assert.equal(calls.releases.length, 0);
  assert.ok(calls.admins.some((a) => /could not be split/.test(a.title)));
  behave.createFails = false;
  const retry = await orders.retryShopifyOrder(row().id);
  assert.equal(retry.status, 'split');
  assert.equal(calls.createdOrders.length, 1);
  assert.equal(calls.edits.length, 1);
  assert.equal(row().state, 'split');
  assert.equal(calls.holds.length, 1, 'the shipment was held once, not again');
});

test('if the edit of the original fails after the new order was made, Try again does not make a second new order', async () => {
  prepare(4);
  behave.financials = paidFinancials(130);
  behave.editFails = true;
  await assert.rejects(() => orders.processOrderCreate(STORE, tenProducts(4)), /could not edit/);
  assert.equal(calls.createdOrders.length, 1);
  assert.equal(splitOf('stitchship').split_state, 'order_created');
  assert.equal(splitOf('stitchship').split_order_name, '#1101');
  assert.equal(row().hold_state, 'held', 'the original (which still has all the lines) does not ship');
  behave.editFails = false;
  const retry = await orders.retryShopifyOrder(row().id);
  assert.equal(retry.status, 'split');
  assert.equal(calls.createdOrders.length, 1, 'still one new order');
  assert.equal(calls.edits.length, 2, 'the failed edit and the one that worked');
  assert.equal(splitOf('stitchship').split_state, 'done');
  assert.equal(row().state, 'split');
});

test('a crash after the new order was made but before it was saved: the earlier order is found, never made twice', async () => {
  prepare(4);
  behave.financials = paidFinancials(130);
  await orders.processOrderCreate(STORE, tenProducts(4));
  // the saved progress is lost (as if the process died), the new order exists in Shopify
  splits().length = 0;
  db.table('shopify_orders')[0].state = 'split_failed';
  db.table('shopify_orders')[0].payload = tenProducts(4);
  behave.alreadyMade = true;
  await orders.retryShopifyOrder(row().id);
  assert.equal(calls.createdOrders.length, 1, 'found by its source identifier, not made again');
  assert.deepEqual(calls.sourceLookups, ['stitchship-split-5001', 'stitchship-split-5001']);
});

test('a new order with the wrong total is never followed by an edit of the original, and Try again does not push on', async () => {
  prepare(4);
  behave.financials = paidFinancials(130);
  behave.childTotal = 4000;
  const result = await orders.processOrderCreate(STORE, tenProducts(4));
  assert.equal(result.status, 'failed');
  assert.equal(calls.edits.length, 0);
  assert.equal(splitOf('stitchship').split_state, 'child_total_mismatch');
  assert.match(row().last_error, /was NOT changed/);
  await assert.rejects(() => orders.retryShopifyOrder(row().id), /did not have the expected total/).catch(() => undefined);
  assert.equal(calls.edits.length, 0);
  assert.equal(calls.createdOrders.length, 1);
});

test('if the shipment of the original cannot be held, nothing is created or changed', async () => {
  prepare(4);
  behave.holdFails = true;
  await assert.rejects(() => orders.processOrderCreate(STORE, tenProducts(4)), /Shopify refused the hold/);
  assert.equal(calls.createdOrders.length, 0);
  assert.equal(calls.edits.length, 0);
});

test('without database update 0046 nothing in Shopify is touched (the progress cannot be saved)', async () => {
  prepare(4);
  const real = db.from;
  db.from = (table) => (table === 'shopify_order_splits' ? { upsert: async () => ({ error: { message: 'column "split_state" of relation "shopify_order_splits" does not exist' } }), select: real(table).select.bind(real(table)) } : real(table));
  await assert.rejects(() => orders.processOrderCreate(STORE, tenProducts(4)), /database update 0046/);
  db.from = real;
  assert.equal(calls.createdOrders.length, 0);
  assert.equal(calls.edits.length, 0);
  assert.equal(calls.holds.length, 0);
});

test('if the original does not total what it should after the edit (an order-level discount), it is flagged but the split stands', async () => {
  splitStore();
  behave.financials = paidFinancials(130);
  behave.originalAfter = normalCents(4) - 500;
  const result = await orders.processOrderCreate(STORE, tenProducts(4));
  assert.equal(result.status, 'split');
  assert.match(splitOf('stitchship').split_error || '', /expected/);
  assert.ok(calls.admins.some((a) => /does not add up after the split/.test(a.title)));
});

test('only enabled products go to the new order; a ticked product that is not enabled stays on the original', async () => {
  prepare(3);
  behave.enabled = ['901', '902']; // the third ticked product is not enabled
  behave.originalAfter = normalCents(2);
  behave.financials = paidFinancials(130);
  await orders.processOrderCreate(STORE, tenProducts(3));
  assert.deepEqual(calls.createdOrders[0].lineItems.map((l) => l.title), ['Product 1', 'Product 2']);
  assert.equal(calls.edits[0].targets.length, 2);
  assert.equal(splitOf('normal').line_ids.length, 8);
});

test('the new order is processed like any Stitch&Ship order (never split again), and its internal order is linked back to the split', async () => {
  prepare(4);
  behave.financials = paidFinancials(130);
  await orders.processOrderCreate(STORE, tenProducts(4));
  const made = calls.madeOrders[0];
  const child = shopifyOrder({
    id: 7001,
    admin_graphql_api_id: made.id,
    name: made.name,
    financial_status: 'paid',
    total_price: '44.00',
    note_attributes: [{ name: 'stitchship', value: 'yes' }, { name: 'stitchship_ref', value: 'SS-AB12CD' }, { name: 'stitchship_split_from', value: '#1001' }, { name: 'stitchship_split_from_id', value: '5001' }],
    line_items: Array.from({ length: 4 }, (_, i) => mkLine(i + 1, '10.00', 1, { properties: MARK, tax_lines: [{ title: 'GST', rate: 0.1, price: '1.00' }] })),
    shipping_lines: [],
    shipping_address: atelierAddress(),
  });
  behave.financials = () => ({ financial_status: 'paid', total_received: 44, total_refunded: 0, outstanding: 0, transactions_ok: true, refunds: [], transactions: [] });
  const result = await orders.processOrderCreate(STORE, child);
  assert.equal(result.status, 'processed');
  assert.equal(calls.createdOrders.length, 1, 'no second split');
  assert.equal(db.table('orders').length, 1, 'the customer\'s order in the app');
  assert.equal(order().brand_order_total, 44);
  assert.equal(order().payment_type, 'NON_COD');
  assert.equal(calls.emails.length, 1);
  const linked = splitOf('stitchship');
  assert.equal(linked.order_id, order().id, 'the split points at the customer\'s order');
  assert.equal(linked.internal_reference ?? null, order().reference ?? null, 'the app own reference of that order');
});

test('a COD split: the customer is asked for the Stitch&Ship total only, when the new order reaches the app', async () => {
  prepare(4);
  behave.financials = () => ({ financial_status: 'pending', total_received: 0, total_refunded: 0, outstanding: 130, transactions_ok: true, refunds: [], transactions: [] });
  await orders.processOrderCreate(STORE, tenProducts(4, { financial_status: 'pending' }));
  const made = calls.madeOrders[0];
  const child = shopifyOrder({
    id: 7002, admin_graphql_api_id: made.id, name: made.name, financial_status: 'pending', total_price: '44.00',
    note_attributes: [{ name: 'stitchship_split_from', value: '#1001' }, { name: 'stitchship_split_from_id', value: '5001' }],
    line_items: Array.from({ length: 4 }, (_, i) => mkLine(i + 1, '10.00', 1, { properties: MARK, tax_lines: [{ title: 'GST', rate: 0.1, price: '1.00' }] })),
    shipping_lines: [], shipping_address: atelierAddress(),
  });
  behave.financials = () => ({ financial_status: 'pending', total_received: 0, total_refunded: 0, outstanding: 44, transactions_ok: true, refunds: [], transactions: [] });
  await orders.processOrderCreate(STORE, child);
  assert.equal(order().payment_type, 'COD');
  assert.equal(order().cod_amount, 44);
  assert.equal(order().cod_payment_status, 'UNPAID');
});
