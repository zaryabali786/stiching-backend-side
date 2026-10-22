import { supabaseAdmin } from '../config/supabase.js';
import { config } from '../config/env.js';
import { ConflictError, NotFoundError } from '../utils/error.helper.js';
import { shopifyGraphql } from './shopify.service.js';
import { retrievePaymentIntent, toMinorUnits } from './stripe.service.js';
import { notifyAdmins, notifyUser } from './notification.service.js';
import { round2 } from './shop.service.js';

/**
 * The life of a Shop order after checkout.
 *  - The customer paid the PLATFORM once (Stripe). Only a verified successful payment starts anything.
 *  - One child order per brand is created in that brand's own Shopify store, tagged, as PENDING payment: it is never marked paid there
 *    (the platform holds the money and settles the brand's share later), and it is created once (claimed atomically, found again by its
 *    source identifier if the answer was lost).
 *  - Shopify then tells us what happens (webhooks; a recovery sync asks Shopify directly): confirmed, cancelled, fulfilled + tracking,
 *    refunds. "Delivered" only when Shopify reports a delivered shipment; otherwise the last confirmed status is shown.
 */

export const dropshipTag = () => config.shop.dropshipTag;
const gidTail = (v) => String(v || '').split('/').pop();
const now = () => new Date().toISOString();

const STATUS_LABELS = {
  pending_payment: 'Waiting for payment',
  payment_failed: 'Payment failed',
  processing: 'Placing your order with the brands',
  confirmed: 'Confirmed by the brands',
  partially_dispatched: 'Partly dispatched',
  dispatched: 'Dispatched',
  delivered: 'Delivered',
  cancelled: 'Cancelled',
  attention: 'Needs attention',
};
export const statusLabel = (s) => STATUS_LABELS[s] || s;

export const logEvent = (shopOrderId, text, brandOrderId = null) => supabaseAdmin.from('shop_order_events').insert({ shop_order_id: shopOrderId, brand_order_id: brandOrderId, text });

// ───────────── the parent status, always derived from the facts ─────────────

export const deriveStatus = (order, brandOrders) => {
  if (order.cancelled_at) return 'cancelled';
  if (order.payment_status === 'unpaid') return 'pending_payment';
  if (order.payment_status === 'failed') return 'payment_failed';
  if (brandOrders.some((b) => b.state === 'failed')) return 'attention';
  const live = brandOrders.filter((b) => b.state !== 'cancelled');
  if (!live.length) return 'cancelled';
  if (live.some((b) => b.state !== 'created')) return 'processing';
  if (live.every((b) => b.fulfillment_status === 'delivered' && b.delivery_verified)) return 'delivered';
  if (live.every((b) => ['dispatched', 'delivered'].includes(b.fulfillment_status))) return 'dispatched';
  if (live.some((b) => ['dispatched', 'delivered', 'partial'].includes(b.fulfillment_status))) return 'partially_dispatched';
  return 'confirmed';
};

export const refreshParentStatus = async (shopOrderId) => {
  const { data: order } = await supabaseAdmin.from('shop_orders').select('*').eq('id', shopOrderId).single();
  const { data: brandOrders } = await supabaseAdmin.from('shop_brand_orders').select('*').eq('shop_order_id', shopOrderId);
  const status = deriveStatus(order, brandOrders || []);
  const refunded = round2((brandOrders || []).reduce((a, b) => a + Number(b.refunded_amount || 0), 0));
  if (status !== order.status || refunded !== Number(order.refunded_total)) {
    await supabaseAdmin.from('shop_orders').update({ status, refunded_total: refunded, updated_at: now() }).eq('id', shopOrderId);
    if (status !== order.status) await logEvent(shopOrderId, `Order status: ${statusLabel(status)}.`);
  }
  return status;
};

// ───────────── payment ─────────────

/**
 * A Stripe payment for a Shop order succeeded. Idempotent (a repeated event or the app's confirm call finds it already done).
 * The amount and currency must match the order; the money is for the platform; then the brand orders are created.
 */
export const settleShopIntent = async (intent) => {
  const orderId = intent.metadata?.shop_order_id;
  if (!orderId) return { status: 'ignored' };
  const { data: order } = await supabaseAdmin.from('shop_orders').select('*').eq('id', orderId).maybeSingle();
  if (!order) return { status: 'unknown_order' };
  if (intent.status !== 'succeeded') return { status: 'not_paid' };
  if (intent.currency !== String(order.currency).toLowerCase() || (intent.amount_received ?? intent.amount) !== toMinorUnits(order.total, order.currency)) {
    await notifyAdmins({ type: 'alert', title: `Shop payment mismatch ${order.reference}`, body: `Stripe took ${(intent.amount_received ?? intent.amount) / 100} ${intent.currency} but the order is ${order.total} ${order.currency}. Nothing was started: check it in Stripe.`, link: '/admin/ecommerce' }).catch(() => undefined);
    return { status: 'mismatch' };
  }
  await supabaseAdmin.from('shop_payments').upsert({ shop_order_id: order.id, provider_ref: intent.id, amount: order.total, currency: order.currency, status: 'succeeded', updated_at: now() }, { onConflict: 'provider_ref' });
  if (order.payment_status === 'paid') {
    if (order.payment_intent_id && order.payment_intent_id !== intent.id) {
      await notifyAdmins({ type: 'alert', title: `Shop order ${order.reference} was paid twice`, body: `A second payment (${intent.id}) succeeded for an order that was already paid. Refund one of them in Stripe.`, link: '/admin/ecommerce' }).catch(() => undefined);
    }
    return { status: 'already_paid' };
  }
  // the first successful payment wins (conditional update: two events at the same moment settle it once)
  const upd = await supabaseAdmin.from('shop_orders').update({ payment_status: 'paid', paid_at: now(), payment_intent_id: intent.id, status: 'processing', updated_at: now() }).eq('id', order.id).in('payment_status', ['unpaid', 'failed']).select('id').maybeSingle();
  if (!upd.data) return { status: 'already_paid' };
  if (order.cancelled_at) {
    // paid after the attempt was closed (a late payment): the order is revived, an administrator is told
    await supabaseAdmin.from('shop_orders').update({ cancelled_at: null }).eq('id', order.id);
    await supabaseAdmin.from('shop_brand_orders').update({ state: 'pending', commission_status: 'estimated' }).eq('shop_order_id', order.id).eq('state', 'cancelled');
    await notifyAdmins({ type: 'alert', title: `Shop order ${order.reference} paid after it was closed`, body: 'The customer paid a payment that had been replaced by a newer attempt. The order was revived.', link: '/admin/ecommerce' }).catch(() => undefined);
  }
  await logEvent(order.id, `Payment of ${Number(order.total).toFixed(2)} ${order.currency} received.`);
  // the cart is emptied of what was bought
  const { data: items } = await supabaseAdmin.from('shop_order_items').select('variant_id').eq('shop_order_id', order.id);
  const variantIds = (items || []).map((i) => i.variant_id).filter(Boolean);
  if (variantIds.length) await supabaseAdmin.from('shop_cart_items').delete().eq('customer_id', order.customer_id).in('variant_id', variantIds);
  await notifyUser(order.customer_id, { type: 'info', title: `Payment received for ${order.reference}`, body: 'Your order is being placed with the brands.', link: `/app/shop/orders/${order.id}` }).catch(() => undefined);
  await createBrandOrders(order.id);
  return { status: 'paid' };
};

export const recordFailedShopIntent = async (intent) => {
  const orderId = intent.metadata?.shop_order_id;
  if (!orderId) return { status: 'ignored' };
  const message = intent.last_payment_error?.message || 'The payment was declined.';
  await supabaseAdmin.from('shop_payments').update({ status: 'failed', failure_message: message, updated_at: now() }).eq('provider_ref', intent.id);
  const upd = await supabaseAdmin.from('shop_orders').update({ payment_status: 'failed', status: 'payment_failed', updated_at: now() }).eq('id', orderId).eq('payment_status', 'unpaid').is('cancelled_at', null).select('id').maybeSingle();
  if (upd.data) await logEvent(orderId, `Payment failed: ${message}`);
  return { status: 'failed' };
};

/** The app asks right after the payment sheet closes: ask Stripe, settle if it succeeded. */
export const confirmShopPayment = async ({ customerId, orderId, paymentIntentId }) => {
  const { data: order } = await supabaseAdmin.from('shop_orders').select('*').eq('id', orderId).eq('customer_id', customerId).maybeSingle();
  if (!order) throw new NotFoundError('Order not found.');
  const id = paymentIntentId || order.payment_intent_id;
  if (id) {
    const intent = await retrievePaymentIntent(id);
    if (intent.metadata?.shop_order_id !== order.id) throw new ConflictError('That payment belongs to another order.');
    if (intent.status === 'succeeded') await settleShopIntent(intent);
    else if (intent.status === 'requires_payment_method' && intent.last_payment_error) await recordFailedShopIntent(intent);
  }
  return null;
};

// ───────────── the order in each brand's Shopify store ─────────────

const ORDER_CREATE = `mutation($order: OrderCreateOrderInput!, $options: OrderCreateOptionsInput) { orderCreate(order: $order, options: $options) { order { id name displayFinancialStatus } userErrors { field message } } }`;
const FIND_BY_SOURCE = `query($q: String!) { orders(first: 1, query: $q) { nodes { id name displayFinancialStatus } } }`;

export const sourceId = (brandOrder, shopOrder) => `${shopOrder.reference}/${brandOrder.id}`;

export const findShopifyOrderBySource = async (store, identifier) => {
  const res = await shopifyGraphql(store, FIND_BY_SOURCE, { q: `source_identifier:"${identifier}"` });
  return res.orders?.nodes?.[0] || null;
};

const splitName = (full) => {
  const parts = String(full || '').trim().split(/\s+/);
  return { firstName: parts.shift() || '', lastName: parts.join(' ') };
};

export const buildOrderInput = (store, brandOrder, shopOrder, items, email) => {
  const a = shopOrder.address;
  const money = (v) => ({ shopMoney: { amount: Number(v).toFixed(2), currencyCode: shopOrder.currency } });
  const input = {
    email,
    tags: [dropshipTag()],
    sourceIdentifier: sourceId(brandOrder, shopOrder),
    note: `Stitch&Ship Shop order ${shopOrder.reference}. The customer paid Stitch&Ship (the platform collects the payment): do not collect payment from the customer or from this order. Please fulfil and add tracking.`,
    customAttributes: [{ key: 'stitchship_shop_order', value: shopOrder.reference }, { key: 'stitchship_brand_order', value: brandOrder.id }],
    financialStatus: 'PENDING',
    shippingAddress: { ...splitName(a.name), address1: a.address1, address2: a.address2 || undefined, city: a.city, provinceCode: a.province || undefined, zip: a.zip || undefined, countryCode: a.country_code, phone: a.phone },
    lineItems: items.map((i) => ({ variantId: `gid://shopify/ProductVariant/${gidTail(i.shopify_variant_id)}`, quantity: i.quantity, priceSet: money(i.unit_price), requiresShipping: true })),
  };
  if (Number(brandOrder.shipping) > 0) input.shippingLines = [{ title: 'Shipping', code: 'stitchship-shop', priceSet: money(brandOrder.shipping) }];
  return input;
};

/**
 * Creates one brand's order in its Shopify store. Never creates a second one: the row is claimed first (pending -> creating), and an order
 * that already exists in Shopify (found by its source identifier) is adopted. A failure is written on the row; the parent order stays.
 * @param {{ manual?: boolean }} opts manual: an administrator retries a failed one
 */
export const createBrandOrderInShopify = async (brandOrderId, { manual = false } = {}) => {
  const { data: bo } = await supabaseAdmin.from('shop_brand_orders').select('*').eq('id', brandOrderId).maybeSingle();
  if (!bo) throw new NotFoundError('Brand order not found.');
  const { data: order } = await supabaseAdmin.from('shop_orders').select('*').eq('id', bo.shop_order_id).single();
  if (order.payment_status !== 'paid') throw new ConflictError('The order is not paid yet: nothing is sent to the brand.');
  if (order.cancelled_at) throw new ConflictError('This order is cancelled.');
  const claim = await supabaseAdmin.from('shop_brand_orders').update({ state: 'creating', last_error: null, updated_at: now() }).eq('id', bo.id).in('state', manual ? ['pending', 'failed'] : ['pending']).select('*').maybeSingle();
  if (!claim.data) return bo; // already created, being created, or cancelled: left exactly as it is
  const { data: store } = await supabaseAdmin.from('shopify_stores').select('*').eq('id', bo.store_id).maybeSingle();
  try {
    if (!store || store.status !== 'active') throw new Error('The brand store is not connected any more. Ask the brand to reconnect, then retry.');
    let created = await findShopifyOrderBySource(store, sourceId(bo, order));
    if (!created) {
      const { data: items } = await supabaseAdmin.from('shop_order_items').select('*').eq('brand_order_id', bo.id);
      const { data: customer } = await supabaseAdmin.from('profiles').select('email').eq('id', order.customer_id).single();
      const res = await shopifyGraphql(store, ORDER_CREATE, {
        order: buildOrderInput(store, bo, order, items || [], order.email || customer?.email),
        options: { inventoryBehaviour: 'DECREMENT_OBEYING_POLICY', sendReceipt: false, sendFulfillmentReceipt: false },
      });
      const errs = res?.orderCreate?.userErrors || [];
      if (errs.length || !res?.orderCreate?.order) throw new Error(errs.map((e) => e.message).join('; ') || 'Shopify did not create the order.');
      created = res.orderCreate.order;
    }
    await supabaseAdmin.from('shop_brand_orders').update({ state: 'created', last_error: null, shopify_order_id: gidTail(created.id), shopify_order_name: created.name, financial_status: created.displayFinancialStatus || 'PENDING', commission_status: 'pending', updated_at: now() }).eq('id', bo.id);
    await logEvent(order.id, `Order ${created.name} created in the brand's store.`, bo.id);
  } catch (err) {
    const message = String(err?.message || err).slice(0, 500);
    const denied = /access denied|write_orders|scope|permission|unauthorized|401|403/i.test(message);
    const text = denied ? `The brand has not granted the permission to create orders (write_orders): ask it to open the install link again and approve. (${message})`.slice(0, 500) : message;
    await supabaseAdmin.from('shop_brand_orders').update({ state: 'failed', last_error: text, updated_at: now() }).eq('id', bo.id);
    await logEvent(order.id, `Could not create the order in the brand's store: ${text}`, bo.id);
    await notifyAdmins({ type: 'alert', title: `Shop order ${order.reference}: a brand order failed`, body: text, link: '/admin/ecommerce' }).catch(() => undefined);
  }
  await refreshParentStatus(order.id);
  const { data: after } = await supabaseAdmin.from('shop_brand_orders').select('*').eq('id', bo.id).single();
  return after;
};

/** Every brand of a paid order, one after the other: one brand failing never stops (or repeats) another. */
export const createBrandOrders = async (shopOrderId) => {
  const { data } = await supabaseAdmin.from('shop_brand_orders').select('id').eq('shop_order_id', shopOrderId).eq('state', 'pending');
  for (const row of data || []) await createBrandOrderInShopify(row.id);
  return refreshParentStatus(shopOrderId);
};

// ───────────── what Shopify tells us back ─────────────

/** The REST payload of a webhook, in the shape the sync works with. */
export const normaliseRestOrder = (p) => ({
  financial_status: p.financial_status ? String(p.financial_status).toUpperCase() : null,
  cancelled: !!p.cancelled_at,
  fulfillment: p.fulfillment_status === 'fulfilled' ? 'fulfilled' : p.fulfillment_status === 'partial' ? 'partial' : null,
  fulfillments: (p.fulfillments || []).map((f) => ({
    ok: f.status === 'success',
    delivered: String(f.shipment_status || '').toLowerCase() === 'delivered',
    tracking: (f.tracking_numbers?.length ? f.tracking_numbers : [f.tracking_number]).filter(Boolean).map((n, i) => ({ company: f.tracking_company || null, number: n, url: f.tracking_urls?.[i] || (i === 0 ? f.tracking_url : null) || null })),
  })),
  refunds: (p.refunds || []).map((r) => ({ id: String(r.id), amount: round2((r.transactions || []).filter((t) => t.kind === 'refund' && t.status !== 'failure' && t.status !== 'error').reduce((a, t) => a + Number(t.amount || 0), 0) || (r.refund_line_items || []).reduce((a, l) => a + Number(l.subtotal || 0), 0)) })),
});

const SYNC_QUERY = `query($id: ID!) { order(id: $id) { id name displayFinancialStatus displayFulfillmentStatus cancelledAt
  fulfillments(first: 20) { status displayStatus trackingInfo { company number url } }
  refunds { id totalRefundedSet { shopMoney { amount } } } } }`;

export const normaliseGraphqlOrder = (o) => ({
  financial_status: o.displayFinancialStatus || null,
  cancelled: !!o.cancelledAt,
  fulfillment: o.displayFulfillmentStatus === 'FULFILLED' ? 'fulfilled' : o.displayFulfillmentStatus === 'PARTIALLY_FULFILLED' ? 'partial' : null,
  fulfillments: (o.fulfillments || []).map((f) => ({ ok: f.status === 'SUCCESS', delivered: f.displayStatus === 'DELIVERED', tracking: (f.trackingInfo || []).filter((t) => t.number).map((t) => ({ company: t.company || null, number: t.number, url: t.url || null })) })),
  refunds: (o.refunds || []).map((r) => ({ id: gidTail(r.id), amount: round2(r.totalRefundedSet?.shopMoney?.amount || 0) })),
});

/** Applies what Shopify says about one brand order. Idempotent: it writes the facts, so the same event twice changes nothing. */
export const applyShopifyState = async (bo, n) => {
  const patch = { updated_at: now() };
  const events = [];
  if (n.financial_status) patch.financial_status = n.financial_status;
  if (!n.keepFulfillment) {
    const ok = (n.fulfillments || []).filter((f) => f.ok);
    patch.tracking = ok.flatMap((f) => f.tracking);
    let fulfillment = 'unfulfilled';
    if (ok.length) fulfillment = n.fulfillment === 'fulfilled' ? (ok.every((f) => f.delivered) ? 'delivered' : 'dispatched') : 'partial';
    patch.fulfillment_status = fulfillment;
    patch.delivery_verified = fulfillment === 'delivered';
    if (fulfillment !== bo.fulfillment_status) events.push(fulfillment === 'delivered' ? 'Delivered (confirmed by the carrier through the brand).' : fulfillment === 'dispatched' ? 'Dispatched by the brand.' : fulfillment === 'partial' ? 'Partly dispatched by the brand.' : 'Back to not dispatched.');
    if (JSON.stringify(patch.tracking) !== JSON.stringify(bo.tracking || []) && patch.tracking.length) events.push(`Tracking: ${patch.tracking.map((t) => `${t.company || 'carrier'} ${t.number}`).join(', ')}.`);
  }

  if (n.cancelled && bo.state !== 'cancelled') {
    patch.state = 'cancelled';
    if (['estimated', 'pending'].includes(bo.commission_status)) patch.commission_status = 'reversed';
    else if (bo.commission_status === 'settled') {
      patch.commission_status = 'disputed';
      patch.dispute_note = 'The brand cancelled this order after it was settled: reconcile with the brand.';
    }
    events.push('Cancelled by the brand.');
  }
  // refunds: one row per Shopify refund (a repeat adds nothing)
  let refunded = Number(bo.refunded_amount || 0);
  if ((n.refunds || []).length) {
    for (const r of n.refunds) await supabaseAdmin.from('shop_refunds').upsert({ brand_order_id: bo.id, shopify_refund_id: r.id, amount: r.amount }, { onConflict: 'brand_order_id,shopify_refund_id', ignoreDuplicates: true });
    const { data: rows } = await supabaseAdmin.from('shop_refunds').select('amount').eq('brand_order_id', bo.id);
    refunded = round2((rows || []).reduce((a, r) => a + Number(r.amount), 0));
    if (refunded !== Number(bo.refunded_amount || 0)) {
      patch.refunded_amount = refunded;
      events.push(`Refund of ${refunded.toFixed(2)} recorded by the brand. The customer's money is not returned automatically: refund the customer in Stripe if due.`);
      if (refunded >= Number(bo.total) - 0.005) {
        if (['estimated', 'pending'].includes(patch.commission_status || bo.commission_status)) patch.commission_status = 'reversed';
        else if ((patch.commission_status || bo.commission_status) === 'settled') {
          patch.commission_status = 'disputed';
          patch.dispute_note = 'The order was fully refunded after it was settled: reconcile with the brand.';
        }
      }
    }
  }
  await supabaseAdmin.from('shop_brand_orders').update(patch).eq('id', bo.id);
  for (const text of events) await logEvent(bo.shop_order_id, text, bo.id);
  await refreshParentStatus(bo.shop_order_id);
};

const findBrandOrder = async (store, shopifyOrderId) => (await supabaseAdmin.from('shop_brand_orders').select('*').eq('store_id', store.id).eq('shopify_order_id', String(shopifyOrderId)).maybeSingle()).data;

/** Is this Shopify order one of OUR dropship orders (the tag, or a row we saved)? The stitching flow must never treat it as its own. */
export const isDropshipPayload = (payload) => String(payload?.tags || '').split(',').map((t) => t.trim().toLowerCase()).includes(dropshipTag().toLowerCase());

/** orders/create, orders/updated, orders/cancelled for a dropship order. Returns { handled } so the caller can skip the stitching flow. */
export const handleShopOrderWebhook = async (store, payload) => {
  let bo = await findBrandOrder(store, payload.id);
  if (!bo && isDropshipPayload(payload)) {
    // the webhook can arrive before we saved the Shopify id of the order we just created: match by our source identifier
    const ident = payload.source_identifier;
    const ref = String(ident || '').split('/')[1];
    if (ref) {
      const { data } = await supabaseAdmin.from('shop_brand_orders').select('*').eq('id', ref).eq('store_id', store.id).maybeSingle();
      if (data && !data.shopify_order_id) {
        await supabaseAdmin.from('shop_brand_orders').update({ shopify_order_id: String(payload.id), shopify_order_name: payload.name || null }).eq('id', data.id).is('shopify_order_id', null);
        bo = (await supabaseAdmin.from('shop_brand_orders').select('*').eq('id', data.id).single()).data;
      }
    }
  }
  if (!bo) return { handled: isDropshipPayload(payload), status: isDropshipPayload(payload) ? 'unknown_dropship_order' : 'not_ours' };
  await applyShopifyState(bo, normaliseRestOrder(payload));
  return { handled: true, status: 'synced' };
};

export const handleShopRefundWebhook = async (store, payload) => {
  const bo = await findBrandOrder(store, payload.order_id);
  if (!bo) return { handled: false };
  const { data: current } = await supabaseAdmin.from('shop_brand_orders').select('*').eq('id', bo.id).single();
  const amount = round2((payload.transactions || []).filter((t) => t.kind === 'refund').reduce((a, t) => a + Number(t.amount || 0), 0) || (payload.refund_line_items || []).reduce((a, l) => a + Number(l.subtotal || 0), 0));
  await applyShopifyState(current, { financial_status: null, cancelled: false, fulfillment: null, fulfillments: [], refunds: [{ id: String(payload.id), amount }], keepFulfillment: true });
  return { handled: true, status: 'refund_recorded' };
};

/** Recovery: ask Shopify directly for the current state of a brand order (a lost webhook, an old order, or "Sync" in the admin). */
export const syncBrandOrder = async (brandOrderId) => {
  const { data: bo } = await supabaseAdmin.from('shop_brand_orders').select('*').eq('id', brandOrderId).maybeSingle();
  if (!bo) throw new NotFoundError('Brand order not found.');
  const { data: store } = await supabaseAdmin.from('shopify_stores').select('*').eq('id', bo.store_id).maybeSingle();
  if (!store || store.status !== 'active') throw new ConflictError('The brand store is not connected.');
  if (!bo.shopify_order_id) {
    // maybe it was created but we never saved the answer
    const { data: order } = await supabaseAdmin.from('shop_orders').select('*').eq('id', bo.shop_order_id).single();
    const found = await findShopifyOrderBySource(store, sourceId(bo, order));
    if (!found) throw new ConflictError('This brand order does not exist in the brand\'s store yet. Use "Retry create".');
    await supabaseAdmin.from('shop_brand_orders').update({ state: 'created', shopify_order_id: gidTail(found.id), shopify_order_name: found.name, last_error: null, commission_status: order.payment_status === 'paid' ? 'pending' : 'estimated' }).eq('id', bo.id).in('state', ['pending', 'creating', 'failed']);
    return syncBrandOrder(bo.id);
  }
  const res = await shopifyGraphql(store, SYNC_QUERY, { id: `gid://shopify/Order/${bo.shopify_order_id}` });
  if (!res.order) {
    await supabaseAdmin.from('shop_brand_orders').update({ last_error: 'The order no longer exists in the brand\'s store.', updated_at: now() }).eq('id', bo.id);
    return (await supabaseAdmin.from('shop_brand_orders').select('*').eq('id', bo.id).single()).data;
  }
  await applyShopifyState(bo, normaliseGraphqlOrder(res.order));
  return (await supabaseAdmin.from('shop_brand_orders').select('*').eq('id', bo.id).single()).data;
};

// ───────────── cancelling ─────────────

const ORDER_CANCEL = `mutation($id: ID!) { orderCancel(orderId: $id, reason: OTHER, refund: false, restock: true, notifyCustomer: false) { job { id } orderCancelUserErrors { message } userErrors { message } } }`;

/** An administrator cancels a Shop order: what is not yet dispatched is cancelled in the brands' stores; dispatched parts are left and reported. */
export const cancelShopOrder = async ({ orderId, reason }) => {
  const { data: order } = await supabaseAdmin.from('shop_orders').select('*').eq('id', orderId).maybeSingle();
  if (!order) throw new NotFoundError('Order not found.');
  const { data: bos } = await supabaseAdmin.from('shop_brand_orders').select('*').eq('shop_order_id', orderId);
  const blocked = [];
  for (const bo of bos || []) {
    if (bo.state === 'cancelled') continue;
    if (['dispatched', 'delivered', 'partial'].includes(bo.fulfillment_status)) {
      blocked.push(bo);
      continue;
    }
    if (bo.state === 'created' && bo.shopify_order_id) {
      const { data: store } = await supabaseAdmin.from('shopify_stores').select('*').eq('id', bo.store_id).maybeSingle();
      try {
        const res = await shopifyGraphql(store, ORDER_CANCEL, { id: `gid://shopify/Order/${bo.shopify_order_id}` });
        const errs = [...(res?.orderCancel?.orderCancelUserErrors || []), ...(res?.orderCancel?.userErrors || [])];
        if (errs.length) throw new Error(errs.map((e) => e.message).join('; '));
      } catch (err) {
        blocked.push(bo);
        await logEvent(orderId, `Could not cancel in the brand's store: ${String(err.message).slice(0, 200)}`, bo.id);
        continue;
      }
    }
    const reverse = ['estimated', 'pending'].includes(bo.commission_status);
    await supabaseAdmin.from('shop_brand_orders').update({ state: 'cancelled', ...(reverse ? { commission_status: 'reversed' } : bo.commission_status === 'settled' ? { commission_status: 'disputed', dispute_note: 'Cancelled after settlement' } : {}), updated_at: now() }).eq('id', bo.id);
    await logEvent(orderId, 'Cancelled.', bo.id);
  }
  if (!blocked.length) await supabaseAdmin.from('shop_orders').update({ cancelled_at: now(), updated_at: now() }).eq('id', orderId);
  await logEvent(orderId, `Cancel requested by an administrator${reason ? `: ${reason}` : ''}.${blocked.length ? ` ${blocked.length} brand order(s) could not be cancelled (already dispatched or the brand's store refused).` : ''} If the customer paid, refund them in Stripe.`);
  await refreshParentStatus(orderId);
  return { cancelled: !blocked.length, blocked: blocked.length };
};

// ───────────── background recovery ─────────────

let timer = null;
const EVERY_MS = 5 * 60 * 1000;

/** Brand orders of PAID orders that are still pending, or stuck "creating" for 10+ minutes, are picked up again (never twice at once). */
export const recoverBrandOrders = async () => {
  const stale = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  await supabaseAdmin.from('shop_brand_orders').update({ state: 'pending' }).eq('state', 'creating').lt('updated_at', stale);
  const { data } = await supabaseAdmin.from('shop_brand_orders').select('id, shop_order:shop_orders!inner(payment_status, cancelled_at)').eq('state', 'pending').eq('shop_order.payment_status', 'paid').is('shop_order.cancelled_at', null).limit(50);
  for (const row of data || []) await createBrandOrderInShopify(row.id).catch(() => undefined);
};

export const startShopOrderTimer = () => {
  if (timer || process.env.NODE_ENV === 'test') return;
  timer = setInterval(() => recoverBrandOrders().catch((err) => console.warn('[Shop] recovery failed:', err.message)), EVERY_MS);
  timer.unref?.();
};
