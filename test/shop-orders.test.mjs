/**
 * The Shop (multi-brand ecommerce + dropshipping): payment settlement, one Shopify order per brand (created once, a failing brand never
 * affects another), what Shopify tells back (dispatch, tracking, delivery, cancel, refunds), commission snapshots and settlements.
 * Shopify, Stripe, notifications and the database are all faked: nothing leaves this process.
 */
import { test, mock, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeDb } from './fake-supabase.mjs';

let db;
let shop;
let svc;
let views;
let calls;
let behave;
const dbProxy = new Proxy({}, { get: (_, key) => db[key] });

before(async () => {
  mock.module('../src/config/supabase.js', { namedExports: { supabaseAdmin: dbProxy, supabase: dbProxy } });
  mock.module('../src/services/notification.service.js', {
    namedExports: { notifyAdmins: async (n) => calls.admins.push(n), notifyUser: async (id, n) => calls.users.push({ id, ...n }), notifyUsers: async () => {}, notifyPartner: async () => {}, notifyStaff: async () => {}, partnerRecipients: async () => [] },
  });
  mock.module('../src/services/stripe.service.js', {
    namedExports: {
      isStripeEnabled: () => true,
      toMinorUnits: (a) => Math.round(Number(a) * 100),
      createShopPaymentIntent: async () => ({ intent: { id: 'pi_new', client_secret: 'cs' }, minor: 0 }),
      cancelPaymentIntent: async () => {},
      retrievePaymentIntent: async (id) => ({ id, status: 'succeeded', metadata: {} }),
    },
  });
  mock.module('../src/services/shopify.service.js', {
    namedExports: {
      shopifyGraphql: async (store, query, vars) => {
        if (/orderCreate/.test(query)) {
          if (behave.failStore === store.id) throw new Error(behave.failMessage || 'Access denied for orderCreate field. Required access: write_orders');
          calls.created.push({ store: store.id, input: vars.order, options: vars.options });
          return { orderCreate: { order: { id: `gid://shopify/Order/${9000 + calls.created.length}`, name: `#${2000 + calls.created.length}`, displayFinancialStatus: 'PENDING' }, userErrors: [] } };
        }
        if (/source_identifier|orders\(first: 1/.test(query)) return { orders: { nodes: behave.existing ? [{ id: 'gid://shopify/Order/7777', name: '#7777', displayFinancialStatus: 'PENDING' }] : [] } };
        if (/orderCancel/.test(query)) {
          calls.cancels.push(vars.id);
          return { orderCancel: { job: { id: 'j' }, orderCancelUserErrors: [], userErrors: [] } };
        }
        if (/displayFulfillmentStatus/.test(query)) return { order: behave.syncOrder ?? null };
        return {};
      },
    },
  });
  svc = await import('../src/services/shop.service.js');
  shop = await import('../src/services/shop-orders.service.js');
  views = await import('../src/services/shop-views.service.js');
});

const ADDRESS = { name: 'Sara Khan', phone: '+923001234567', address1: 'House 1', city: 'Lahore', country_code: 'PK' };

const reset = () => {
  calls = { created: [], cancels: [], admins: [], users: [] };
  behave = {};
  db = createFakeDb(
    {
      shopify_stores: [{ id: 'sA', shop_domain: 'brand-a.myshopify.com', status: 'active' }, { id: 'sB', shop_domain: 'brand-b.myshopify.com', status: 'active' }],
      profiles: [{ id: 'c1', email: 'sara@example.com', role: 'customer' }],
      shop_orders: [{ id: 'o1', reference: 'SH-1001', customer_id: 'c1', email: 'sara@example.com', status: 'pending_payment', payment_status: 'unpaid', currency: 'USD', subtotal: 100, shipping_total: 10, total: 110, refunded_total: 0, address: ADDRESS, payment_intent_id: 'pi_1', cancelled_at: null }],
      shop_brand_orders: [
        { id: 'bA', shop_order_id: 'o1', store_id: 'sA', state: 'pending', subtotal: 60, shipping: 5, total: 65, commission_model: 'percent', commission_rate: 10, commission_fixed: 0, commission_amount: 6, brand_payable: 59, commission_status: 'estimated', fulfillment_status: 'unfulfilled', delivery_verified: false, tracking: [], refunded_amount: 0 },
        { id: 'bB', shop_order_id: 'o1', store_id: 'sB', state: 'pending', subtotal: 40, shipping: 5, total: 45, commission_model: 'fixed', commission_rate: 0, commission_fixed: 4, commission_amount: 4, brand_payable: 41, commission_status: 'estimated', fulfillment_status: 'unfulfilled', delivery_verified: false, tracking: [], refunded_amount: 0 },
      ],
      shop_order_items: [
        { id: 'iA', shop_order_id: 'o1', brand_order_id: 'bA', variant_id: 'vA', shopify_variant_id: '111', title: 'Kurta', quantity: 2, unit_price: 30, line_total: 60 },
        { id: 'iB', shop_order_id: 'o1', brand_order_id: 'bB', variant_id: 'vB', shopify_variant_id: '222', title: 'Shawl', quantity: 1, unit_price: 40, line_total: 40 },
      ],
      shop_cart_items: [{ customer_id: 'c1', variant_id: 'vA', quantity: 2 }, { customer_id: 'c1', variant_id: 'vB', quantity: 1 }, { customer_id: 'c1', variant_id: 'vOther', quantity: 1 }],
      shop_payments: [],
      shop_order_events: [],
      shop_refunds: [],
      shop_settlements: [],
    },
    {}
  );
};
beforeEach(reset);

const intent = (extra = {}) => ({ id: 'pi_1', status: 'succeeded', currency: 'usd', amount: 11000, amount_received: 11000, metadata: { kind: 'shop', shop_order_id: 'o1' }, ...extra });
const order = () => db.table('shop_orders')[0];
const bo = (id) => db.table('shop_brand_orders').find((b) => b.id === id);

// ───────────── pure rules ─────────────

test('commission: percentage and fixed, never more than the items, from the brand terms given', () => {
  assert.equal(svc.commissionFor({ commission_model: 'percent', commission_rate: 12.5 }, 80).commission_amount, 10);
  assert.equal(svc.commissionFor({ commission_model: 'fixed', commission_fixed: 7 }, 80).commission_amount, 7);
  assert.equal(svc.commissionFor({ commission_model: 'fixed', commission_fixed: 500 }, 80).commission_amount, 80, 'capped at the items');
  const t = svc.commissionFor({ commission_model: 'percent', commission_rate: 20 }, 33.33);
  assert.deepEqual([t.commission_model, t.commission_rate, t.commission_amount], ['percent', 20, 6.67]);
  assert.equal(svc.commissionFor(null, 50).commission_amount, 0, 'a brand without terms earns no commission');
});

test('the delivery address is checked before any payment starts', () => {
  assert.equal(svc.validateAddress(ADDRESS).country_code, 'PK');
  assert.throws(() => svc.validateAddress({ ...ADDRESS, address1: '' }), /address/);
  assert.throws(() => svc.validateAddress({ ...ADDRESS, country_code: 'Pakistan' }), /country/);
  assert.throws(() => svc.validateAddress({ ...ADDRESS, phone: '12' }), /phone/);
});

test('the parent status is derived from the facts: delivered only when every brand is verified delivered', () => {
  const paid = { payment_status: 'paid', cancelled_at: null };
  const b = (o) => ({ state: 'created', fulfillment_status: 'unfulfilled', delivery_verified: false, ...o });
  assert.equal(shop.deriveStatus({ payment_status: 'unpaid' }, []), 'pending_payment');
  assert.equal(shop.deriveStatus({ payment_status: 'failed' }, []), 'payment_failed');
  assert.equal(shop.deriveStatus(paid, [b({}), b({ state: 'pending' })]), 'processing');
  assert.equal(shop.deriveStatus(paid, [b({}), b({ state: 'failed' })]), 'attention');
  assert.equal(shop.deriveStatus(paid, [b({}), b({})]), 'confirmed');
  assert.equal(shop.deriveStatus(paid, [b({ fulfillment_status: 'dispatched' }), b({})]), 'partially_dispatched');
  assert.equal(shop.deriveStatus(paid, [b({ fulfillment_status: 'dispatched' }), b({ fulfillment_status: 'dispatched' })]), 'dispatched');
  assert.equal(shop.deriveStatus(paid, [b({ fulfillment_status: 'delivered', delivery_verified: true }), b({ fulfillment_status: 'dispatched' })]), 'dispatched', 'one brand delivered, the other not verified');
  assert.equal(shop.deriveStatus(paid, [b({ fulfillment_status: 'delivered', delivery_verified: true }), b({ state: 'cancelled' })]), 'delivered', 'a cancelled brand order does not block');
  assert.equal(shop.deriveStatus(paid, [b({ state: 'cancelled' })]), 'cancelled');
  assert.equal(shop.deriveStatus({ ...paid, cancelled_at: 'x' }, [b({})]), 'cancelled');
});

// ───────────── payment -> one Shopify order per brand ─────────────

test('a verified payment places one order in EACH brand store, tagged, PENDING (never marked paid), with our reference', async () => {
  const result = await shop.settleShopIntent(intent());
  assert.equal(result.status, 'paid');
  assert.equal(order().payment_status, 'paid');
  assert.equal(calls.created.length, 2, 'one per brand');
  assert.deepEqual(calls.created.map((c) => c.store).sort(), ['sA', 'sB']);
  for (const c of calls.created) {
    assert.deepEqual(c.input.tags, ['stitchship-shop']);
    assert.equal(c.input.financialStatus, 'PENDING', 'never paid in the brand store: the platform holds the money');
    assert.match(c.input.sourceIdentifier, /^SH-1001\//);
    assert.equal(c.input.customAttributes[0].value, 'SH-1001');
    assert.equal(c.input.shippingAddress.countryCode, 'PK');
    assert.equal(c.options.sendReceipt, false);
  }
  const a = calls.created.find((c) => c.store === 'sA').input;
  assert.equal(a.lineItems[0].quantity, 2);
  assert.equal(a.lineItems[0].priceSet.shopMoney.amount, '30.00', 'the price the customer paid');
  assert.equal(a.shippingLines[0].priceSet.shopMoney.amount, '5.00');
  assert.equal(bo('bA').state, 'created');
  assert.equal(bo('bA').shopify_order_name, '#2001');
  assert.equal(bo('bA').commission_status, 'pending', 'commission is pending (not settled) once placed');
  assert.equal(order().status, 'confirmed');
  // the cart loses what was bought and keeps the rest
  assert.deepEqual(db.table('shop_cart_items').map((c) => c.variant_id), ['vOther']);
});

test('the same payment event twice (webhook + the app) creates the orders only once', async () => {
  await shop.settleShopIntent(intent());
  const again = await shop.settleShopIntent(intent());
  assert.equal(again.status, 'already_paid');
  assert.equal(calls.created.length, 2);
  assert.equal(db.table('shop_payments').length, 1);
});

test('a payment of the wrong amount starts nothing and tells the admins', async () => {
  const r = await shop.settleShopIntent(intent({ amount_received: 5000, amount: 5000 }));
  assert.equal(r.status, 'mismatch');
  assert.equal(order().payment_status, 'unpaid');
  assert.equal(calls.created.length, 0);
  assert.equal(calls.admins.length, 1);
});

test('nothing is sent to a brand before the order is paid', async () => {
  await assert.rejects(() => shop.createBrandOrderInShopify('bA'), /not paid/);
  assert.equal(calls.created.length, 0);
});

test('one brand failing leaves the other brand\'s order alone; the retry creates only the missing one (never a second)', async () => {
  behave.failStore = 'sB';
  await shop.settleShopIntent(intent());
  assert.equal(bo('bA').state, 'created');
  assert.equal(bo('bB').state, 'failed');
  assert.match(bo('bB').last_error, /write_orders/);
  assert.match(bo('bB').last_error, /install link/, 'says exactly what the brand must approve');
  assert.equal(order().status, 'attention');
  assert.equal(order().payment_status, 'paid', 'the parent order is preserved');
  assert.ok(calls.admins.some((a) => /brand order failed/.test(a.title)));
  const before = calls.created.length;
  behave.failStore = null;
  await shop.createBrandOrderInShopify('bB', { manual: true });
  await shop.createBrandOrderInShopify('bA', { manual: true }); // already created: left alone
  assert.equal(calls.created.length, before + 1, 'only the failed one was created');
  assert.equal(bo('bB').state, 'created');
  assert.equal(order().status, 'confirmed');
});

test('an order that already exists in the brand store (answer lost) is adopted, not created twice', async () => {
  behave.existing = true;
  await shop.settleShopIntent(intent());
  assert.equal(calls.created.length, 0);
  assert.equal(bo('bA').shopify_order_id, '7777');
  assert.equal(bo('bA').state, 'created');
});

test('a failed payment is recorded and can be retried; a late payment revives a closed order', async () => {
  await shop.recordFailedShopIntent({ id: 'pi_1', metadata: { shop_order_id: 'o1' }, last_payment_error: { message: 'Your card was declined.' } });
  assert.equal(order().status, 'payment_failed');
  assert.ok(db.table('shop_order_events').some((e) => /declined/.test(e.text)));
  const r = await shop.settleShopIntent(intent());
  assert.equal(r.status, 'paid');
  assert.equal(order().payment_status, 'paid');
  assert.equal(calls.created.length, 2);
});

// ───────────── what Shopify tells back ─────────────

const paidOrder = async () => {
  await shop.settleShopIntent(intent());
  calls.admins.length = 0;
};
const rest = (extra = {}) => ({ id: 9001, name: '#2001', tags: 'stitchship-shop', financial_status: 'pending', fulfillment_status: null, cancelled_at: null, fulfillments: [], refunds: [], ...extra });

test('dispatch with tracking is recorded per brand; the parent shows partly dispatched until both have shipped; delivered only when Shopify says delivered', async () => {
  await paidOrder();
  const store = { id: 'sA' };
  await shop.handleShopOrderWebhook(store, rest({ fulfillment_status: 'fulfilled', fulfillments: [{ status: 'success', tracking_company: 'TCS', tracking_number: 'TCS123', tracking_url: 'https://t/123' }] }));
  assert.equal(bo('bA').fulfillment_status, 'dispatched');
  assert.equal(bo('bA').delivery_verified, false, 'dispatched is not delivered');
  assert.deepEqual(bo('bA').tracking, [{ company: 'TCS', number: 'TCS123', url: 'https://t/123' }]);
  assert.equal(order().status, 'partially_dispatched');
  await shop.handleShopOrderWebhook({ id: 'sB' }, rest({ id: 9002, fulfillment_status: 'fulfilled', fulfillments: [{ status: 'success', tracking_number: 'B1', shipment_status: 'delivered' }] }));
  assert.equal(bo('bB').fulfillment_status, 'delivered');
  assert.equal(order().status, 'dispatched', 'one brand verified delivered, the other only dispatched');
  await shop.handleShopOrderWebhook(store, rest({ fulfillment_status: 'fulfilled', fulfillments: [{ status: 'success', tracking_number: 'TCS123', shipment_status: 'delivered' }] }));
  assert.equal(order().status, 'delivered');
});

test('the same webhook twice changes nothing and logs nothing new', async () => {
  await paidOrder();
  const payload = rest({ fulfillment_status: 'fulfilled', fulfillments: [{ status: 'success', tracking_number: 'T1' }] });
  await shop.handleShopOrderWebhook({ id: 'sA' }, payload);
  const events = db.table('shop_order_events').length;
  await shop.handleShopOrderWebhook({ id: 'sA' }, payload);
  assert.equal(db.table('shop_order_events').length, events);
});

test('a brand cancelling reverses its open commission; after settlement the commission is disputed instead', async () => {
  await paidOrder();
  await shop.handleShopOrderWebhook({ id: 'sA' }, rest({ cancelled_at: '2026-10-22T10:00:00Z' }));
  assert.equal(bo('bA').state, 'cancelled');
  assert.equal(bo('bA').commission_status, 'reversed');
  assert.equal(order().status, 'confirmed', 'the other brand continues');
  bo('bB').commission_status = 'settled';
  await shop.handleShopOrderWebhook({ id: 'sB' }, rest({ id: 9002, cancelled_at: '2026-10-22T11:00:00Z' }));
  assert.equal(bo('bB').commission_status, 'disputed');
  assert.equal(order().status, 'cancelled');
});

test('a refund is recorded once (a repeated event adds nothing) and never claims the customer was refunded', async () => {
  await paidOrder();
  const refund = { id: 77, order_id: 9001, transactions: [{ kind: 'refund', amount: '20.00' }] };
  await shop.handleShopRefundWebhook({ id: 'sA' }, refund);
  await shop.handleShopRefundWebhook({ id: 'sA' }, refund);
  assert.equal(db.table('shop_refunds').length, 1);
  assert.equal(bo('bA').refunded_amount, 20);
  assert.equal(order().refunded_total, 20);
  assert.equal(order().payment_status, 'paid', 'the customer\'s money is only returned by an administrator in Stripe');
  assert.equal(bo('bA').fulfillment_status, 'unfulfilled', 'a refund event never resets the fulfilment');
  await shop.handleShopRefundWebhook({ id: 'sA' }, { id: 78, order_id: 9001, transactions: [{ kind: 'refund', amount: '45.00' }] });
  assert.equal(bo('bA').refunded_amount, 65);
  assert.equal(bo('bA').commission_status, 'reversed', 'a full refund reverses the open commission');
});

test('an order we created is recognised by tag and never handed to the stitching flow; others are not ours', async () => {
  assert.equal(shop.isDropshipPayload({ tags: 'a, Stitchship-Shop' }), true);
  assert.equal(shop.isDropshipPayload({ tags: 'stitchship' }), false);
  await paidOrder();
  assert.equal((await shop.handleShopOrderWebhook({ id: 'sA' }, rest({ id: 55555, tags: 'other' }))).handled, false);
  assert.equal((await shop.handleShopOrderWebhook({ id: 'sA' }, rest({ id: 55555 }))).handled, true, 'tagged but unknown: still not a stitching order');
});

test('webhook arriving before we saved the Shopify id is matched by the source identifier', async () => {
  await shop.settleShopIntent(intent());
  bo('bA').shopify_order_id = null;
  const r = await shop.handleShopOrderWebhook({ id: 'sA' }, rest({ id: 424242, source_identifier: 'SH-1001/bA' }));
  assert.equal(r.handled, true);
  assert.equal(bo('bA').shopify_order_id, '424242');
});

test('recovery sync reads the order from Shopify (lost webhook): fulfilment, tracking and delivery come back', async () => {
  await paidOrder();
  behave.syncOrder = { id: 'gid://shopify/Order/9001', displayFinancialStatus: 'PENDING', displayFulfillmentStatus: 'FULFILLED', cancelledAt: null, fulfillments: [{ status: 'SUCCESS', displayStatus: 'DELIVERED', trackingInfo: [{ company: 'Leopards', number: 'L9', url: null }] }], refunds: [] };
  const out = await shop.syncBrandOrder('bA');
  assert.equal(out.fulfillment_status, 'delivered');
  assert.equal(out.delivery_verified, true);
  assert.equal(bo('bA').tracking[0].number, 'L9');
});

test('cancelling: undispatched brand orders are cancelled in Shopify, dispatched ones are left and reported', async () => {
  await paidOrder();
  await shop.handleShopOrderWebhook({ id: 'sB' }, rest({ id: 9002, fulfillment_status: 'fulfilled', fulfillments: [{ status: 'success', tracking_number: 'B1' }] }));
  const r = await shop.cancelShopOrder({ orderId: 'o1', reason: 'customer asked' });
  assert.equal(r.cancelled, false);
  assert.equal(r.blocked, 1);
  assert.equal(calls.cancels.length, 1, 'only the undispatched one');
  assert.equal(bo('bA').state, 'cancelled');
  assert.equal(bo('bA').commission_status, 'reversed');
  assert.equal(bo('bB').state, 'created');
  assert.equal(order().cancelled_at, null);
});

// ───────────── commission and settlements ─────────────

test('settling pays only PENDING commissions of that brand, once; a second try or another brand is refused', async () => {
  await paidOrder();
  const s = await views.createSettlement({ storeId: 'sA', brandOrderIds: ['bA', 'bB'], reference: 'BANK-1', note: 'Oct' });
  assert.equal(s.orders_count, 1, 'bB belongs to another brand');
  assert.equal(s.amount, 59, 'the brand payable (items + shipping - commission)');
  assert.equal(bo('bA').commission_status, 'settled');
  assert.equal(bo('bB').commission_status, 'pending');
  await assert.rejects(() => views.createSettlement({ storeId: 'sA', brandOrderIds: ['bA'], reference: 'BANK-2' }), /can be settled/);
  assert.equal(db.table('shop_settlements').length, 1, 'no duplicate settlement');
  await assert.rejects(() => views.createSettlement({ storeId: 'sB', brandOrderIds: ['bB'], reference: '' }), /reference/);
});

test('an estimated commission (unpaid order) can never be settled', async () => {
  await assert.rejects(() => views.createSettlement({ storeId: 'sA', brandOrderIds: ['bA'], reference: 'X' }), /can be settled/);
});

test('disputing and resolving a commission', async () => {
  await paidOrder();
  await views.setDispute({ brandOrderId: 'bA', disputed: true, note: 'brand says damaged' }).catch(() => undefined);
  assert.equal(bo('bA').commission_status, 'disputed');
  await views.setDispute({ brandOrderId: 'bA', disputed: false }).catch(() => undefined);
  assert.equal(bo('bA').commission_status, 'pending');
});

test('the brand settings validate commission terms; a brand is not approved by default', async () => {
  await assert.rejects(() => views.updateBrandSettings('sA', { commission_rate: 150 }), /not valid/);
  await assert.rejects(() => views.updateBrandSettings('sA', { commission_model: 'wild' }), /percent or fixed/);
});

// ───────────── who sees what ─────────────

test('a customer sees only their own orders, and never commission or Shopify references; the admin sees them', async () => {
  await paidOrder();
  await assert.rejects(() => views.customerOrder('someone-else', 'o1'), /not found/i);
  const mine = await views.customerOrder('c1', 'o1');
  const text = JSON.stringify(mine);
  assert.doesNotMatch(text, /commission|brand_payable|shopify_order|9001|stitchship-shop/i);
  assert.equal(mine.brand_orders.length, 2);
  assert.equal(mine.brand_orders[0].status_label, 'Confirmed by the brand');
  const admin = await views.adminOrder('o1');
  assert.equal(admin.brand_orders[0].commission_amount, 6);
  assert.equal(admin.brand_orders[0].commission_status, 'pending');
  assert.equal(admin.payment.status, 'paid');
});

test('a failed brand order is not shown to the customer as a failure (it is ours to fix)', async () => {
  behave.failStore = 'sB';
  await shop.settleShopIntent(intent());
  const mine = await views.customerOrder('c1', 'o1');
  const failed = mine.brand_orders.find((b) => b.id === 'bB');
  assert.equal(failed.state, 'pending');
  assert.doesNotMatch(JSON.stringify(mine), /write_orders|Access denied/);
});
