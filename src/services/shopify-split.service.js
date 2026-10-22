import { supabaseAdmin } from '../config/supabase.js';

/**
 * Splitting a mixed Shopify order into its Stitch&Ship part and its normal part, in OUR records only.
 *
 * Shopify keeps ONE order and ONE payment for the checkout (it cannot divide a payment between two orders, and creating or editing
 * orders to fake that would put invented transactions into the books). So the original Shopify order stays the financial source of
 * truth, and for each group of lines this service records what belongs to it: products, subtotal, discounts, taxes, shipping, total,
 * and how much of the ONE real payment covers it. Nothing here moves money or writes to Shopify.
 *
 * All amounts are worked out in whole cents (no floating point drift) from Shopify's own order data, and the groups always add up to the
 * order: shipping and payments are shared out by the largest-remainder method, and any difference to Shopify's total is shown, not hidden.
 */

export const GROUPS = ['stitchship', 'normal'];

const cents = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
};
const money = (c) => Math.round(c) / 100;
const sum = (list, pick) => (list || []).reduce((t, x) => t + cents(pick(x)), 0);

/** Share `total` (cents) over `weights` so the parts add up to exactly `total` (largest remainder). All-zero weights give everything to `fallback`. */
export const shareOut = (total, weights, fallback = 0) => {
  const out = weights.map(() => 0);
  if (!total) return out;
  const w = weights.map((x) => Math.max(0, x));
  const all = w.reduce((a, b) => a + b, 0);
  if (!all) {
    out[fallback] = total;
    return out;
  }
  const raw = w.map((x) => (total * x) / all);
  const base = raw.map(Math.floor);
  let left = total - base.reduce((a, b) => a + b, 0);
  const order = raw.map((r, i) => ({ i, frac: r - base[i] })).sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (let k = 0; left > 0 && k < order.length; k++, left--) base[order[k].i] += 1;
  return base;
};

/**
 * What each group of lines is worth, from the order Shopify sent (REST order object).
 * @param {object} payload the Shopify order
 * @param {Set<string>|string[]} stitchLineIds ids of the lines that are for stitching (already validated)
 */
export const allocateOrder = (payload, stitchLineIds, options = {}) => {
  const stitch = new Set([...stitchLineIds].map(String));
  const included = payload?.taxes_included === true;
  const lines = (payload?.line_items || []).map((l) => {
    const qty = Number(l.quantity) || 0;
    const gross = cents(l.price) * qty;
    const discount = sum(l.discount_allocations, (d) => d.amount);
    return { id: String(l.id), group: stitch.has(String(l.id)) ? 'stitchship' : 'normal', title: l.title, variant_title: l.variant_title || null, sku: l.sku || null, product_id: l.product_id ?? null, variant_id: l.variant_id ?? null, quantity: qty, gross, discount, net: gross - discount, tax: sum(l.tax_lines, (t) => t.price) };
  });
  const shipping = sum(payload?.shipping_lines, (s) => s.discounted_price ?? s.price);
  const shippingTax = (payload?.shipping_lines || []).reduce((t, s) => t + sum(s.tax_lines, (x) => x.price), 0);

  const groups = Object.fromEntries(GROUPS.map((g) => [g, { kind: g, line_ids: [], lines: [], subtotal: 0, discounts: 0, taxes: 0, shipping: 0, shipping_tax: 0, total: 0 }]));
  for (const l of lines) {
    const g = groups[l.group];
    g.line_ids.push(l.id);
    g.lines.push({ line_id: l.id, title: l.title, variant_title: l.variant_title, sku: l.sku, product_id: l.product_id, variant_id: l.variant_id, quantity: l.quantity, subtotal: money(l.gross), discount: money(l.discount), tax: money(l.tax) });
    g.subtotal += l.gross;
    g.discounts += l.discount;
    g.taxes += l.tax;
  }
  const weights = GROUPS.map((g) => groups[g].subtotal - groups[g].discounts);
  const only = GROUPS.findIndex((g) => groups[g].line_ids.length > 0);
  // 'normal': all the shipping stays with the normal group (the original order keeps its shipping line when the stitching lines are moved off it)
  const toNormal = (v) => (groups.normal.line_ids.length || !groups.stitchship.line_ids.length ? [0, v] : [v, 0]);
  const shippingParts = options.shipping === 'normal' ? toNormal(shipping) : shareOut(shipping, weights, only < 0 ? 1 : only);
  const shippingTaxParts = options.shipping === 'normal' ? toNormal(shippingTax) : shareOut(shippingTax, weights, only < 0 ? 1 : only);
  GROUPS.forEach((name, i) => {
    const g = groups[name];
    g.shipping = shippingParts[i];
    g.shipping_tax = shippingTaxParts[i];
    // prices that already include tax: the tax is part of the price, not added on top
    g.total = g.subtotal - g.discounts + g.shipping + (included ? 0 : g.taxes + g.shipping_tax);
  });

  const orderTotal = cents(payload?.total_price);
  const allocated = GROUPS.reduce((t, g) => t + groups[g].total, 0);
  const difference = orderTotal - allocated;
  const out = Object.fromEntries(
    GROUPS.map((name) => {
      const g = groups[name];
      return [name, { ...g, subtotal: money(g.subtotal), discounts: money(g.discounts), taxes: money(g.taxes), shipping: money(g.shipping), shipping_tax: money(g.shipping_tax), total: money(g.total), _cents: g.total }];
    })
  );
  return {
    groups: out,
    mixed: groups.stitchship.line_ids.length > 0 && groups.normal.line_ids.length > 0,
    currency: payload?.currency ? String(payload.currency).toUpperCase() : null,
    taxes_included: included,
    order_total: money(orderTotal),
    allocated_total: money(allocated),
    // anything Shopify counted that no line owns (a tip, duties, rounding): shown, never silently moved to a group
    unallocated: money(difference),
    reconciled: Math.abs(difference) <= 1,
  };
};

/**
 * What Shopify has actually collected, in cents, from the order Shopify sent and (when it could be fetched) the authoritative
 * transactions. Returns verified:false when the payment cannot be confirmed: nothing is then shown as paid.
 * @param {object} payload the Shopify order (webhook)
 * @param {object|null} fetched result of fetchOrderFinancials, or null
 */
export const readFinancials = (payload, fetched = null) => {
  const status = String(fetched?.financial_status || payload?.financial_status || '').toLowerCase();
  const total = cents(payload?.total_price);
  if (fetched && fetched.transactions_ok) {
    return { verified: true, source: 'shopify_transactions', financial_status: status, received: cents(fetched.total_received), refunded: cents(fetched.total_refunded), total, refunds: fetched.refunds || [] };
  }
  // no transaction list: Shopify's own signed order can still say paid or not, but it is not "verified" against transactions
  const refundsRaw = payload?.refunds || [];
  const refunded = refundsRaw.reduce((t, r) => t + sum((r.transactions || []).filter((x) => String(x.kind).toLowerCase() === 'refund' && String(x.status || 'success').toLowerCase() === 'success'), (x) => x.amount), 0);
  const refunds = refundsRaw.map((r) => ({
    lines: (r.refund_line_items || []).map((x) => ({ line_id: String(x.line_item_id ?? x.line_item?.id), cents: cents(x.subtotal) + cents(x.total_tax) })),
    total: sum((r.transactions || []).filter((x) => String(x.kind).toLowerCase() === 'refund'), (x) => x.amount),
  }));
  // Shopify's own word: paid / refunded = the whole total came in; pending / authorized = nothing was collected; partly paid = only its figure counts
  const paidWords = ['paid', 'partially_refunded', 'refunded'];
  const received = paidWords.includes(status) ? total : ['pending', 'authorized'].includes(status) ? 0 : Number.isFinite(Number(payload?.total_received)) && payload?.total_received !== null && payload?.total_received !== '' ? cents(payload.total_received) : null;
  return { verified: false, source: 'webhook', financial_status: status, received, refunded, total, refunds };
};

/**
 * How much of the ONE real payment covers each group, what is still owed, and what was refunded. A group is "paid" only when the order is
 * verified paid for at least its whole total.
 */
export const allocatePayment = (alloc, fin) => {
  const names = GROUPS;
  const totals = names.map((n) => alloc.groups[n]._cents);
  const orderTotal = totals.reduce((a, b) => a + b, 0);
  const known = fin.received !== null && fin.received !== undefined;
  const paidTotal = known ? Math.min(Math.max(fin.received - 0, 0), orderTotal) : 0;
  const paidParts = shareOut(paidTotal, totals, 0);

  // refunds: a refunded line belongs to its group; money not tied to a line (shipping, adjustment) is shared by total
  const byGroup = { stitchship: 0, normal: 0 };
  let tied = 0;
  const lineGroup = new Map();
  for (const n of names) for (const id of alloc.groups[n].line_ids) lineGroup.set(String(id), n);
  for (const r of fin.refunds || []) {
    for (const l of r.lines || []) {
      const g = lineGroup.get(String(l.line_id));
      if (g) {
        byGroup[g] += l.cents;
        tied += l.cents;
      }
    }
  }
  const loose = Math.max(0, (fin.refunded || 0) - tied);
  const looseParts = shareOut(loose, totals, 0);
  const result = {};
  names.forEach((n, i) => {
    const refunded = Math.min(totals[i], byGroup[n] + looseParts[i]);
    const paid = paidParts[i];
    const outstanding = known ? totals[i] - paid : null;
    let status;
    if (!known) status = 'verification_pending';
    else if (totals[i] > 0 && refunded >= totals[i]) status = 'refunded';
    else if (refunded > 0) status = 'partially_refunded';
    else if (totals[i] > 0 && paid >= totals[i]) status = fin.verified ? 'paid' : 'paid_unverified';
    else if (paid > 0) status = 'partially_paid';
    else status = 'unpaid';
    result[n] = { amount_paid: known ? money(paid) : null, outstanding: outstanding === null ? null : money(Math.max(0, outstanding)), refunded: money(refunded), payment_status: status };
  });
  return { groups: result, payment_verified: fin.verified, payment_source: fin.source, financial_status: fin.financial_status || null, original_received: known ? money(fin.received) : null, original_refunded: money(fin.refunded || 0) };
};

// ───────────── saving the split ─────────────

const splitKey = (rowId, kind) => `${rowId}:${kind}`;

/** Best effort and idempotent: one row per original Shopify order (our row id) and group. Never throws. Returns { saved, error }. */
export const saveSplit = async ({ row, store, payload, alloc, pay, addresses = {}, tags = {}, orderId = null, extra = {} }) => {
  try {
    const now = new Date().toISOString();
    for (const kind of GROUPS) {
      const g = alloc.groups[kind];
      const p = pay.groups[kind];
      if (!g.line_ids.length) continue; // a group without lines has nothing to record
      const record = {
        split_key: splitKey(row.id, kind),
        shopify_order_row_id: row.id,
        store_id: store?.id ?? row.store_id ?? null,
        shopify_order_id: String(payload?.id ?? row.shopify_order_id),
        shopify_order_name: payload?.name ?? row.shopify_order_name ?? null,
        kind,
        order_id: kind === 'stitchship' ? orderId ?? row.order_id ?? null : null,
        line_ids: g.line_ids,
        lines: g.lines,
        subtotal: g.subtotal,
        discounts: g.discounts,
        taxes: g.taxes,
        shipping: g.shipping,
        shipping_tax: g.shipping_tax,
        total: g.total,
        currency: alloc.currency,
        amount_paid: p.amount_paid,
        outstanding: p.outstanding,
        refunded: p.refunded,
        payment_status: p.payment_status,
        payment_verified: pay.payment_verified,
        payment_source: pay.payment_source,
        financial_status: pay.financial_status,
        reconciled: alloc.reconciled,
        unallocated: alloc.unallocated,
        taxes_included: alloc.taxes_included,
        address: addresses[kind] || null,
        tag: tags[kind] || null,
        ...(extra[kind] || {}),
        updated_at: now,
      };
      const { error } = await supabaseAdmin.from('shopify_order_splits').upsert(record, { onConflict: 'split_key' });
      if (error) return { saved: false, error: error.message };
    }
    return { saved: true };
  } catch (err) {
    return { saved: false, error: err.message };
  }
};

/** The saved split of the given Shopify order rows, grouped by row id. Never throws (an empty map before database update 0045). */
export const loadSplits = async (rowIds) => {
  const map = new Map();
  try {
    if (!rowIds?.length) return map;
    const { data, error } = await supabaseAdmin.from('shopify_order_splits').select('*').in('shopify_order_row_id', rowIds);
    if (error || !data) return map;
    for (const s of data) {
      const list = map.get(s.shopify_order_row_id) || [];
      list.push(s);
      map.set(s.shopify_order_row_id, list);
    }
  } catch {
    /* the page works without it */
  }
  return map;
};

/** The saved split of one Shopify order row, or []. */
export const loadSplit = async (rowId) => (await loadSplits([rowId])).get(rowId) || [];

/** The order was cancelled in Shopify: both groups say so and nothing is shown as owed. */
export const markSplitCancelled = async (rowId) => {
  try {
    await supabaseAdmin.from('shopify_order_splits').update({ payment_status: 'cancelled', outstanding: 0, updated_at: new Date().toISOString() }).eq('shopify_order_row_id', rowId);
  } catch {
    /* best effort */
  }
};

// ───────────── the new Shopify order for the stitching lines ─────────────

const gid = (type, id) => `gid://shopify/${type}/${id}`;
const bag = (amount, currency) => ({ shopMoney: { amount: (Math.round(Number(amount) * 100) / 100).toFixed(2), currencyCode: currency } });
const clean = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== null && v !== ''));
/** A Shopify (REST) address as the GraphQL MailingAddressInput. */
const mailing = (a, over = {}) => (a ? clean({ firstName: a.first_name, lastName: a.last_name, company: a.company, address1: a.address1, address2: a.address2, city: a.city, zip: a.zip, phone: a.phone, countryCode: a.country_code, provinceCode: a.province_code, ...over }) : undefined);

export const SPLIT_TAG = 'stitchship-split';
export const splitSourceIdentifier = (payload) => `stitchship-split-${payload.id}`;

/**
 * The order input for the new Stitch&Ship order: only the stitching lines (variant, quantity, price, tax lines and properties as the customer
 * bought them), the atelier as the shipping address, the customer's own billing address, and the payment ONLY as far as Shopify's own
 * transactions prove it was paid on the original order:
 *   verified paid        -> PAID, with one transaction whose gateway and receipt name the original order and its real transactions
 *   verified part paid   -> PARTIALLY_PAID for that share
 *   anything else        -> PENDING, no transaction (never "paid" on a guess)
 * Discounts of the moved lines go on as one fixed discount (orderCreate takes only one). Shipping stays with the original order.
 * @param {{ payload: object, alloc: object, pay: object, fin: object, atelier: object, ref: string, transactions?: object[] }} args
 */
export const buildChildOrder = ({ payload, alloc, pay, atelier, ref, transactions = [] }) => {
  const cur = alloc.currency || String(payload.currency || '').toUpperCase();
  const g = alloc.groups.stitchship;
  const p = pay.groups.stitchship;
  const ids = new Set(g.line_ids.map(String));
  const lines = (payload.line_items || []).filter((l) => ids.has(String(l.id)));
  const receipt = { split_from_order: payload.name, split_from_order_id: payload.admin_graphql_api_id || gid('Order', payload.id), original_transactions: transactions, note: 'Recorded by Stitch&Ship: this amount was paid on the original order. No new charge was made.' };
  let financialStatus = 'PENDING';
  let txs;
  if (pay.payment_verified && p.payment_status === 'paid' && g.total > 0) {
    financialStatus = 'PAID';
    txs = [{ kind: 'SALE', status: 'SUCCESS', gateway: `Paid on order ${payload.name}`, amountSet: bag(g.total, cur), receiptJson: JSON.stringify(receipt), processedAt: payload.created_at, test: payload.test === true }];
  } else if (pay.payment_verified && p.payment_status === 'partially_paid' && Number(p.amount_paid) > 0) {
    financialStatus = 'PARTIALLY_PAID';
    txs = [{ kind: 'SALE', status: 'SUCCESS', gateway: `Paid on order ${payload.name}`, amountSet: bag(p.amount_paid, cur), receiptJson: JSON.stringify(receipt), processedAt: payload.created_at, test: payload.test === true }];
  }
  const ship = payload.shipping_address || {};
  const customerId = payload.customer?.id;
  return clean({
    currency: cur,
    taxesIncluded: payload.taxes_included === true,
    email: payload.email || payload.contact_email || payload.customer?.email,
    customer: customerId ? { toAssociate: { id: gid('Customer', customerId) } } : undefined,
    phone: payload.phone || undefined,
    processedAt: payload.created_at,
    test: payload.test === true ? true : undefined,
    tags: ['stitchship'],
    note: `Stitch&Ship lines of order ${payload.name}. ${financialStatus === 'PENDING' ? 'Payment is still pending (nothing was paid for these lines on the original order).' : 'Paid on the original order; no new charge.'}`,
    customAttributes: [
      { key: 'stitchship', value: 'yes' },
      { key: 'stitchship_ref', value: ref },
      { key: 'stitchship_split_from', value: String(payload.name) },
      { key: 'stitchship_split_from_id', value: String(payload.id) },
    ],
    sourceName: 'Stitch&Ship',
    sourceIdentifier: splitSourceIdentifier(payload),
    billingAddress: mailing(payload.billing_address),
    // the atelier's address (from the settings), addressed to the customer's name so the parcel can be matched; the reference code in line 2
    shippingAddress: clean({ firstName: ship.first_name, lastName: ship.last_name, company: atelier.shipToName || 'Stitch&Ship Atelier', address1: atelier.shipToAddress, address2: ref, city: atelier.shipToCity, countryCode: atelier.countryCode || 'PK', phone: atelier.shipToPhone }),
    lineItems: lines.map((l) =>
      clean({
        title: l.title,
        variantTitle: l.variant_title && l.variant_title !== 'Default Title' ? l.variant_title : undefined,
        sku: l.sku,
        vendor: l.vendor,
        quantity: Number(l.quantity),
        variantId: l.variant_id ? gid('ProductVariant', l.variant_id) : undefined,
        productId: l.product_id ? gid('Product', l.product_id) : undefined,
        priceSet: bag(l.price, cur),
        taxable: l.taxable !== false,
        requiresShipping: l.requires_shipping !== false,
        taxLines: (l.tax_lines || []).map((t) => ({ title: t.title || 'Tax', rate: Number(t.rate) || 0, priceSet: bag(t.price, cur) })),
        properties: (l.properties || []).map((x) => ({ name: String(x.name), value: String(x.value ?? '') })),
      })
    ),
    discountCode: g.discounts > 0 ? { itemFixedDiscountCode: { code: 'STITCHSHIP-SPLIT', amountSet: bag(g.discounts, cur) } } : undefined,
    financialStatus,
    transactions: txs,
  });
};
