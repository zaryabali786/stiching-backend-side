import { supabaseAdmin } from '../config/supabase.js';
import { config } from '../config/env.js';
import { ConflictError } from '../utils/error.helper.js';
import { loadShipTo } from './ship-to.service.js';
import { addOrderTag, createShopifyOrder, fetchLineItemDetails, fetchOrderFinancials, findOrderBySourceIdentifier, getActiveStore, holdFulfillment, productsStitchEnabled, releaseFulfillment, removeLinesFromOrder, tagAndNoteOrder, updateShippingAddress } from './shopify.service.js';
import { allocateOrder, allocatePayment, buildChildOrder, loadSplit, loadSplits, markSplitCancelled, readFinancials, saveSplit, SPLIT_TAG, splitSourceIdentifier } from './shopify-split.service.js';
import { randomBytes } from 'node:crypto';
import { findOrCreateCustomerByEmail } from './customer-accounts.service.js';
import { issueLoginCode, normaliseEmail } from './login-code.service.js';
import { renderEmail, sendTransactionalEmail } from './transactional-email.service.js';
import { cleanBrandName, defaultPartnerId, ensureBrand, expandItemsToUnits } from './order-import.service.js';
import { addEvent } from './order.service.js';
import { isCod } from './email-order-match.service.js';
import { markPaidAtShopify } from './cod-payment.service.js';
import { notifyAdmins, notifyUser } from './notification.service.js';
import { sendSms, smsEnabled, toE164 } from './sms.service.js';

/**
 * Orders placed on a brand's Shopify store with "Customise stitching with Stitch&Ship".
 *
 * For each order (identified by the hidden stitching property the product-page block adds, never by guessing):
 *   1. hold the brand's shipment until we have looked at the address,
 *   2. check that the shipping address is our atelier (the reference code in address line 2 proves the customer kept it),
 *   3. address right -> release the hold; wrong -> keep the hold and ask the customer to confirm (we never change it silently),
 *   4. make the customer's draft order (matched by the email on the Shopify order) from the stitching line items,
 *   5. tag the order in Shopify, and email the customer a link to add sizes and choices.
 * Every step is safe to repeat, so a retried or duplicate notification never makes a second order or a second hold.
 */

export const STITCH_TAG = 'stitchship';
/** A Shopify order that holds stitching lines AND normal lines: it is not "a Stitch&Ship order", so it does not get the plain tag. */
export const STITCH_MIXED_TAG = 'stitchship-mixed';

const prop = (line, name) => (line.properties || []).find((p) => String(p?.name ?? '').toLowerCase() === name)?.value;
const attr = (payload, name) => (payload.note_attributes || []).find((a) => String(a?.name ?? '').toLowerCase() === name)?.value;
const yes = (v) => String(v ?? '').trim().toLowerCase() === 'yes';

/** The lines of this order that are for stitching. Empty = not a Stitch&Ship order: it is ignored and nothing is stored. */
export const stitchingLines = (payload) => {
  const lines = payload?.line_items || [];
  const marked = lines.filter((l) => yes(prop(l, '_stitchship')));
  if (marked.length) return marked;
  // the "Buy with Stitch&Ship" checkout link carries the marker as a cart attribute, so every line in that checkout is for stitching
  return yes(attr(payload, 'stitchship')) ? lines : [];
};

/** The reference code the block put on the order (SS-XXXXXX), or null. */
export const stitchingRef = (payload) => {
  const fromLine = (payload?.line_items || []).map((l) => prop(l, '_stitchship_ref')).find(Boolean);
  const raw = String(fromLine || attr(payload, 'stitchship_ref') || '').trim().toUpperCase();
  return /^SS-[A-Z0-9]{6,10}$/.test(raw) ? raw : null;
};

const norm = (v) => String(v ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/** Is this shipping address our atelier? The reference code must still be in it, and the street and city must match. */
export const addressMatchesAtelier = ({ shipping, atelier, ref }) => {
  if (!shipping) return false;
  const haystack = norm([shipping.address1, shipping.address2, shipping.company].join(' '));
  if (ref && !haystack.includes(norm(ref))) return false;
  if (atelier?.shipToCity && norm(shipping.city) !== norm(atelier.shipToCity)) return false;
  const want = norm(atelier?.shipToAddress).split(' ').filter((t) => t.length > 2);
  if (want.length) {
    const have = new Set(norm(shipping.address1).split(' '));
    const hits = want.filter((t) => have.has(t)).length;
    if (hits / want.length < 0.6) return false;
  }
  return true;
};

const digits = (v) => String(v ?? '').replace(/\D/g, '');

/** The customer's own phone number from the brand's order, as +<country><number>; never the atelier's, null when unclear. */
export const pickCustomerPhone = (payload, atelier) => {
  const atelierDigits = digits(atelier?.shipToPhone);
  const candidates = [payload?.phone, payload?.customer?.phone, payload?.billing_address?.phone, payload?.customer?.default_address?.phone];
  for (const c of candidates) {
    const e164 = toE164(c);
    if (e164 && (!atelierDigits || !digits(e164).endsWith(atelierDigits.slice(-9)))) return e164;
  }
  return null;
};

/**
 * The lines that could be Stitch&Ship. By default (stitch_mode "enabled") every line is a candidate and the product's own "Stitch&Ship
 * available" box decides: a product the brand enabled is stitched, any other is a normal product, whatever the customer saw on the page.
 * With stitch_mode "customer" only the lines the customer ticked on the product page (the marker) are candidates.
 */
export const candidateLines = (store, payload) => (store.settings?.stitch_mode === 'customer' ? stitchingLines(payload) : payload?.line_items || []);

/**
 * The candidate lines whose product has "Stitch&Ship available" ticked in the Shopify admin (Shopify answers, never the page). A marked line
 * on a product that is not ticked follows the normal flow and an administrator is told. Throws when Shopify cannot be reached, so the
 * order is retried and nothing is half done.
 */
export const eligibleLines = async (store, candidates) => {
  if (!candidates.length) return candidates;
  const enabled = await productsStitchEnabled(store, candidates.map((l) => l.product_id));
  const kept = candidates.filter((l) => l.product_id && enabled.has(String(l.product_id)));
  // one line per product line: what Shopify said and what was decided (never silent)
  for (const l of candidates) {
    const value = l.product_id ? enabled.metafieldValues?.get(String(l.product_id)) : undefined;
    console.info(`[Shopify] ${store.shop_domain} line ${l.id} "${l.title}" product ${l.product_id ?? 'none'} metafield $app:stitchship.enabled=${value === undefined ? 'no product (custom item)' : value === null ? 'not set' : value} -> ${kept.includes(l) ? 'Stitch&Ship' : 'normal'}`);
  }
  if (kept.length < candidates.length && store.settings?.stitch_mode === 'customer') {
    await alert(`Shopify: ${candidates.length - kept.length} marked item(s) are not enabled for Stitch&Ship`, `${store.shop_domain}: ${candidates.filter((l) => !kept.includes(l)).map((l) => l.title).join(', ')} carried the Stitch&Ship marker but "Stitch&Ship available" is not ticked on the product, so it follows the normal flow.`);
  }
  return kept;
};

const num = (v) => (v === null || v === undefined || v === '' ? NaN : Number(v));

/**
 * What Shopify itself says about this order's payment, never assumed:
 *   paid     fully paid (nothing outstanding)
 *   unpaid   money is still owed: pending, authorized-but-not-captured, or partially paid (with the amount outstanding)
 *   unknown  refunded / voided / missing / unreadable: not treated as paid, a person confirms it
 * `outstanding` is Shopify's own figure when it gives one; otherwise total minus what was received.
 */
export const shopifyPaymentInfo = (payload) => {
  const status = String(payload?.financial_status || '').toLowerCase();
  const total = num(payload?.total_price);
  const currency = payload?.currency ? String(payload.currency).toUpperCase() : null;
  const received = num(payload?.total_received);
  const stated = num(payload?.total_outstanding);
  const base = { financial_status: status || null, total: Number.isFinite(total) ? total : null, currency };
  if (!(total > 0) || !currency) return { ...base, kind: 'unknown', amount_paid: null, outstanding: null };
  const owed = Number.isFinite(stated) ? stated : Number.isFinite(received) ? total - received : NaN;
  if (status === 'paid' || status === 'partially_refunded') {
    if (Number.isFinite(owed) && owed > 0.005) return { ...base, kind: 'unpaid', amount_paid: Number.isFinite(received) ? received : total - owed, outstanding: round(owed) };
    return { ...base, kind: 'paid', amount_paid: Number.isFinite(received) && received > 0 ? received : total, outstanding: 0 };
  }
  if (status === 'partially_paid') {
    if (Number.isFinite(owed) && owed > 0.005) return { ...base, kind: 'unpaid', amount_paid: Number.isFinite(received) ? received : round(total - owed), outstanding: round(owed) };
    return { ...base, kind: 'unknown', amount_paid: Number.isFinite(received) ? received : null, outstanding: null };
  }
  if (status === 'pending' || status === 'authorized') return { ...base, kind: 'unpaid', amount_paid: 0, outstanding: round(Number.isFinite(owed) && owed > 0 ? owed : total) };
  return { ...base, kind: 'unknown', amount_paid: null, outstanding: null };
};
const round = (n) => Math.round(n * 100) / 100;

/** The payment facts of the stitching lines only when the order also holds normal lines (their share of the one real payment). */
const groupInfo = (payload, split) => {
  const g = split.alloc.groups.stitchship;
  const p = split.pay.groups.stitchship;
  const base = { financial_status: split.pay.financial_status || null, total: g.total, currency: split.alloc.currency };
  if (['paid', 'paid_unverified'].includes(p.payment_status)) return { ...base, kind: 'paid', amount_paid: p.amount_paid, outstanding: 0 };
  if (p.outstanding > 0) return { ...base, kind: 'unpaid', amount_paid: p.amount_paid ?? 0, outstanding: p.outstanding };
  return { ...base, kind: 'unknown', amount_paid: null, outstanding: null };
};
const infoFor = (payload, split) => (split?.alloc?.mixed ? groupInfo(payload, split) : shopifyPaymentInfo(payload));

const paymentFields = (store, payload, split = null) => {
  const gateways = (payload.payment_gateway_names || []).map((g) => String(g)).filter(Boolean);
  const extra = (store.settings?.cod_gateway_names || []).map((g) => String(g).toLowerCase());
  const cod = gateways.find((g) => isCod(g) || extra.includes(g.toLowerCase()));
  const method = cod || gateways[0] || null;
  const info = infoFor(payload, split);
  const now = new Date().toISOString();
  const base = { brand_payment_method: method ? method.slice(0, 80) : null, brand_payment_status: method ? (info.kind === 'paid' ? 'paid' : 'pending') : null };
  // Shopify says paid: the order is Non-COD and nothing is asked for again. Anything else is COD: the customer pays what is outstanding
  // (or, when Shopify is unclear, our team confirms the total first). The customer is not asked to choose.
  if (info.kind === 'paid') return { ...base, payment_type: 'NON_COD', payment_type_set_at: now, cod_payment_status: null };
  if (info.kind === 'unpaid') {
    return { ...base, payment_type: 'COD', payment_type_set_at: now, cod_payment_status: 'UNPAID', cod_amount: info.outstanding, cod_currency: info.currency, cod_amount_status: 'verified', cod_amount_source: 'shopify', cod_amount_note: 'The amount Shopify reports as outstanding.' };
  }
  return { ...base, payment_type: 'COD', payment_type_set_at: now, cod_payment_status: 'UNPAID', cod_amount_status: 'needs_verification', cod_amount_source: 'shopify', cod_amount_note: 'Shopify did not say clearly whether this order is paid.' };
};

/** Keep Shopify's own payment facts on the order (migration 0044). Never throws: the order does not depend on these columns. */
const saveShopifyPayment = async (orderId, payload, split = null) => {
  try {
    const info = infoFor(payload, split);
    await supabaseAdmin.from('orders').update({ shopify_financial_status: info.financial_status, shopify_amount_paid: info.amount_paid, shopify_outstanding: info.outstanding, shopify_payment_checked_at: new Date().toISOString() }).eq('id', orderId);
  } catch (err) {
    console.warn('[Shopify] could not save the payment status:', err.message);
  }
};

const addressSummary = (a, kind, extra = {}) => (a ? { kind, name: [a.first_name, a.last_name].filter(Boolean).join(' ') || a.name || null, city: a.city || null, country: a.country || null, ...extra } : null);

/** Which address belongs to which group. Shopify has ONE shipping address per order, so a mixed order cannot deliver two ways: it is flagged. */
const groupAddresses = (payload, alloc, atelierOk) => {
  const ship = payload.shipping_address;
  const out = { stitchship: addressSummary(ship, atelierOk ? 'atelier' : 'other', { matches_atelier: !!atelierOk }) };
  if (alloc.mixed) {
    // the normal items should reach the customer, but the one shipping address is the atelier: the brand must ship them separately
    out.normal = atelierOk
      ? addressSummary(payload.billing_address || ship, 'billing', { matches_atelier: false, needs_separate_delivery: true, note: 'The order has one shipping address and it is the atelier. These normal items need to be delivered to the customer separately.' })
      : addressSummary(ship, 'shipping', { matches_atelier: false });
  }
  return out;
};

const patchRow = async (row, patch) => {
  const { data } = await supabaseAdmin.from('shopify_orders').update({ ...patch, updated_at: new Date().toISOString() }).eq('id', row.id).select('*').maybeSingle();
  Object.assign(row, data || patch);
  return row;
};

const alert = (title, body, orderId = null) => notifyAdmins({ type: 'alert', title, body, link: '/admin/shopify', ...(orderId ? { orderId } : {}) }).catch(() => undefined);

/** Make the customer's draft order from the stitching lines (same shape as a draft made from a forwarded email). */
const createDraft = async ({ store, payload, lines, profile, ref, email, split = null }) => {
  const details = await fetchLineItemDetails(store, payload.admin_graphql_api_id).catch(() => new Map());
  const items = lines.map((l) => ({
    title: String([l.title, l.variant_title && l.variant_title !== 'Default Title' ? `· ${l.variant_title}` : ''].filter(Boolean).join(' ')).slice(0, 160),
    quantity: l.quantity,
    unit_price: Number(l.price) > 0 ? Number(l.price) : null,
    url: details.get(String(l.id))?.url || null,
    image_url: details.get(String(l.id))?.image_url || null,
    sku: l.sku || null,
    notes: null,
  }));
  const { units } = expandItemsToUnits(items);
  const brandRow = store.brand_id ? (await supabaseAdmin.from('brands').select('id, name').eq('id', store.brand_id).maybeSingle()).data : null;
  const brandName = brandRow?.name || cleanBrandName(store.settings?.brand_name || store.shop_domain.replace('.myshopify.com', '').replace(/-/g, ' '));
  const brand = brandRow || (await ensureBrand(brandName, profile.id));

  const atelier = await loadShipTo().catch(() => ({}));
  const billing = payload.billing_address;
  // the customer's own address, offered as the delivery address of the stitched outfit (they confirm it in the portal)
  const home = billing && !addressMatchesAtelier({ shipping: billing, atelier, ref: null }) ? billing : null;
  const country = String(home?.country || profile.country || '').trim();
  // a mixed order: the customer's stitching order is worth its own lines, not the whole checkout
  const total = split?.alloc?.mixed ? split.alloc.groups.stitchship.total : Number(payload.total_price);
  const due = new Date();
  due.setUTCDate(due.getUTCDate() + 12);

  const insert = {
    status: 'draft',
    customer_id: profile.id,
    customer_name: profile.full_name || email,
    customer_code: profile.customer_code,
    brand: brand?.name || brandName,
    brand_id: brand?.id || null,
    brand_order_number: String(payload.name || payload.order_number || payload.id),
    international_shipping: country ? country.toLowerCase() !== 'pakistan' : null,
    shipping_service: country && country.toLowerCase() !== 'pakistan' ? 'express' : 'standard',
    partner_id: await defaultPartnerId(),
    // the same workflow as an order made from a forwarded brand email
    import_source: 'email',
    order_source: 'email',
    external_source: 'shopify',
    shopify_store_id: store.id,
    shopify_order_id: String(payload.id),
    shopify_ref: ref,
    stitching_mode: 'custom',
    brand_order_total: Number.isFinite(total) && total > 0 ? total : null,
    brand_order_currency: payload.currency || null,
    ...paymentFields(store, payload, split),
    priority: 'normal',
    due_date: due.toISOString().slice(0, 10),
    destination_country: country || null,
    destination_city: home?.city || profile.city || null,
    destination_address: [home?.address1, home?.address2].filter(Boolean).join(', ') || profile.address || null,
    destination_phone: home?.phone || payload.phone || profile.phone || null,
  };
  let { data: order, error } = await supabaseAdmin.from('orders').insert(insert).select('*').single();
  if (error?.code === '23505') {
    // the same brand order number for this customer already has an order: use it, never a second one
    const { data: existing } = await supabaseAdmin.from('orders').select('*').eq('customer_id', profile.id).ilike('brand_order_number', insert.brand_order_number).neq('status', 'cancelled').limit(1).maybeSingle();
    if (existing) return existing;
  }
  if (error) throw error;

  const { error: unitsError } = await supabaseAdmin.from('order_units').insert(
    units.map((it, i) => ({
      order_id: order.id,
      line_no: i + 1,
      unit_title: it.title,
      product_link: it.url,
      product_image_url: it.image_url,
      brand_sku: it.sku,
      notes: it.notes,
      quantity: 1,
      unit_price: it.unit_price,
      currency: payload.currency || null,
    }))
  );
  if (unitsError) {
    await supabaseAdmin.from('orders').delete().eq('id', order.id);
    throw unitsError;
  }
  await saveShopifyPayment(order.id, payload, split);
  await addEvent(order.id, 'draft', `Order ${insert.brand_order_number} from ${insert.brand} (Shopify) with customised stitching`, null);
  return order;
};

const signInLink = async (email, orderId) => {
  const base = String(config.urls.clientApp || '').replace(/\/$/, '');
  const next = encodeURIComponent(`/app/orders/${orderId}`);
  try {
    const token = await issueLoginCode(email, { kind: 'link' });
    return `${base}/sign-in?email=${encodeURIComponent(email)}&token=${token}&next=${next}`;
  } catch {
    return `${base}/sign-in?email=${encodeURIComponent(email)}&next=${next}`;
  }
};

/**
 * The messages that bring the customer to the portal: an email (add sizes, or confirm a changed address) and, when the store has
 * switched it on and the customer's own number is known, a text with the same link. One link is made for both.
 */
export const sendCustomerEmail = async ({ row, order, email, mismatch, store = null }) => {
  const url = await signInLink(email, order.id);
  const name = order.brand_order_number;
  const subject = mismatch ? `Please confirm where your order ${name} goes` : `Add your sizes for your ${order.brand} order ${name}`;
  const content = mismatch
    ? renderEmail({
        heading: subject,
        paragraphs: [
          `Your ${order.brand} order ${name} is set up for customised stitching, but its shipping address is not our atelier.`,
          'To have it stitched, the parcel has to come to us first. Open your order and confirm, or contact us if you want something else. The brand will not ship it until this is settled.',
        ],
        button: { label: 'Open my order', url },
        footer: `Sign in with this email address: ${email}`,
      })
    : renderEmail({
        heading: subject,
        paragraphs: [
          'We received your order for customised stitching.',
          'Please add your sizes and choices so we can start as soon as your parcel arrives. It takes about 3 minutes.',
        ],
        button: { label: 'Add my sizes', url },
        footer: `Sign in with this email address: ${email}`,
      });
  const result = await sendTransactionalEmail({ to: email, subject, ...content });
  if (result.sent) await patchRow(row, { notified_at: new Date().toISOString(), last_error: null });
  else await patchRow(row, { last_error: result.detail ? `The customer email could not be sent: ${result.detail}`.slice(0, 500) : 'The customer email could not be sent.' });

  // the text: only when this store allows it, the account is set up, and the customer's own number is known
  const storeRow = store || (await supabaseAdmin.from('shopify_stores').select('settings').eq('id', row.store_id).maybeSingle()).data;
  if (storeRow?.settings?.sms_enabled === true && smsEnabled() && row.customer_phone && !row.sms_notified_at) {
    const text = mismatch
      ? `Stitch&Ship: please confirm where your ${order.brand} order ${name} goes: ${url}`
      : `Stitch&Ship: add your sizes for your ${order.brand} order ${name}: ${url}`;
    const sms = await sendSms({ to: row.customer_phone, body: text });
    if (sms.sent) await patchRow(row, { sms_notified_at: new Date().toISOString(), customer_phone: null });
  }

  await notifyUser(order.customer_id, {
    type: 'order',
    title: mismatch ? `Please confirm where order ${name} goes` : 'Add your sizes',
    body: mismatch ? 'Its shipping address is not our atelier.' : `Your ${order.brand} order ${name} is waiting for your sizes and choices.`,
    link: `/app/orders/${order.id}`,
    orderId: order.id,
  }).catch(() => undefined);
  return result;
};

const releaseHold = async (store, row) => {
  if (row.hold_state !== 'held') return row;
  try {
    await releaseFulfillment(store, row.hold_ids);
    return patchRow(row, { hold_state: 'released' });
  } catch (err) {
    await patchRow(row, { hold_state: 'failed', last_error: `Could not release the shipment: ${err.message}` });
    await alert(`Shopify: release the hold of ${row.shopify_order_name || row.shopify_order_id}`, `${store.shop_domain}: we could not release the held shipment (${err.message}). Release it in Shopify, otherwise the brand cannot ship it.`);
    return row;
  }
};

const REF_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const makeRef = () => `SS-${[...randomBytes(6)].map((b) => REF_ALPHABET[b % REF_ALPHABET.length]).join('')}`;

/** Splitting mixed orders in Shopify itself is switched on per store (Admin > Shopify stores > Store settings): it changes the brand's real orders. */
export const autoSplitOn = (store) => store.settings?.auto_split === true;

/** An order this app made when it split another one: it is a plain Stitch&Ship order, never split again. */
export const isSplitChild = (payload) => !!attr(payload, 'stitchship_split_from');

/** The Stitch&Ship address from the settings must be there before anything is split or moved: a clear error, never a silent skip. */
const assertAtelierAddress = (atelier) => {
  if (!atelier?.shipToAddress || !atelier?.shipToCity) throw new ConflictError('The Stitch&Ship shipping address is not set (Admin > Settings > Stitch&Ship address: street and city), so the order was not split.');
};

const shipSummary = (a) => (a ? { name: [a.first_name, a.last_name].filter(Boolean).join(' ') || a.name || null, company: a.company || null, address1: a.address1 || null, address2: a.address2 || null, city: a.city || null, province: a.province || null, zip: a.zip || null, country: a.country || null, phone: a.phone || null } : null);

/**
 * Every item of the order is for stitching: the order itself becomes the Stitch&Ship order, so its delivery address is changed to the
 * atelier's (the customer's own address is kept in the order note). The only order whose address this app ever changes by itself.
 */
const moveWholeOrderToAtelier = async (store, payload, ref) => {
  const atelier = await loadShipTo().catch(() => ({}));
  const ship = payload.shipping_address;
  assertAtelierAddress(atelier);
  if (addressMatchesAtelier({ shipping: ship, atelier, ref })) return { payload, ref };
  const useRef = ref || makeRef();
  const countryCode = store.settings?.atelier_country_code || 'PK';
  await updateShippingAddress(store, payload.admin_graphql_api_id, { firstName: ship?.first_name || undefined, lastName: ship?.last_name || undefined, company: atelier.shipToName || 'Stitch&Ship Atelier', address1: atelier.shipToAddress, address2: useRef, city: atelier.shipToCity, countryCode, phone: atelier.shipToPhone || undefined });
  const own = [ship?.address1, ship?.address2, ship?.city, ship?.country].filter(Boolean).join(', ');
  await tagAndNoteOrder(store, payload.admin_graphql_api_id, null, `The customer's own delivery address: ${own}. Every item of this order is for Stitch&Ship, so its delivery address is now the atelier's.`).catch(() => undefined);
  return { payload: { ...payload, shipping_address: { ...ship, company: atelier.shipToName || 'Stitch&Ship Atelier', address1: atelier.shipToAddress, address2: useRef, city: atelier.shipToCity, country: 'Pakistan', phone: atelier.shipToPhone || ship?.phone } }, ref: useRef };
};

/**
 * A mixed order (stitching lines AND normal lines), split in Shopify:
 *   1. the original's shipment is held (so nothing ships while the two orders are being made),
 *   2. a NEW order is made with only the stitching lines, the atelier as the address, and the payment recorded as "paid on the original
 *      order" only when Shopify's own transactions prove it was paid (otherwise Pending); its total is checked before anything else is touched,
 *   3. the stitching lines are taken off the ORIGINAL order, which keeps the customer's own address, the shipping and the normal lines,
 *   4. the original is tagged and noted, and its shipment is released (now only normal items).
 * No new charge is ever made and no payment is moved or invented: the original payment stays on the original order, and the new order says
 * where its payment came from. Every step is saved before the next (so a retry carries on where it stopped, never makes a second order),
 * and the progress lives in the price split record (migration 0046).
 */
export const splitOriginalOrder = async ({ store, row, payload, lines }) => {
  const orderGid = payload.admin_graphql_api_id;
  // one run at a time for this order: a repeated or concurrent delivery finds it taken
  const { data: locked } = await supabaseAdmin.from('shopify_orders').update({ state: 'split_pending', updated_at: new Date().toISOString() }).eq('id', row.id).in('state', ['received', 'split_failed']).select('*').maybeSingle();
  if (!locked) return { status: 'duplicate' };
  Object.assign(row, locked);

  const alloc = allocateOrder(payload, lines.map((l) => String(l.id)), { shipping: 'normal' });
  const prior = (await loadSplit(row.id)).find((r) => r.kind === 'stitchship');
  const atelier = { ...(await loadShipTo().catch(() => ({}))), countryCode: store.settings?.atelier_country_code || 'PK' };
  const ref = stitchingRef(payload) || makeRef();
  try {
    assertAtelierAddress(atelier);
  } catch (err) {
    // before anything is held, made or changed: say so loudly (the order stays as it is) and let "Try again" run once the address is set
    await patchRow(row, { state: 'split_failed', last_error: err.message });
    if (!locked.last_error) await alert(`Shopify: ${payload.name} could not be split`, `${store.shop_domain}: ${err.message}`);
    return { status: 'failed' };
  }
  const fetched = await fetchOrderFinancials(store, orderGid).catch((err) => {
    console.warn('[Shopify] could not read the payment of', payload.name, err.message);
    return null;
  });
  const pay = allocatePayment(alloc, readFinancials(payload, fetched));
  const atelierShip = { name: atelier.shipToName || null, address1: atelier.shipToAddress || null, address2: ref, city: atelier.shipToCity || null, country: 'Pakistan', phone: atelier.shipToPhone || null };
  const customerShip = shipSummary(payload.shipping_address);
  const persist = async (stitch = {}, normal = {}) => {
    const saved = await saveSplit({
      row, store, payload, alloc, pay,
      addresses: { stitchship: { kind: 'atelier', city: atelierShip.city, country: 'Pakistan', matches_atelier: true }, normal: { kind: 'shipping', city: customerShip?.city, country: customerShip?.country, matches_atelier: false } },
      tags: { stitchship: STITCH_TAG, normal: null },
      extra: { stitchship: { original_order_name: payload.name, ship_to: atelierShip, ...stitch }, normal: { reference: payload.name, original_order_name: payload.name, ship_to: customerShip, ...normal } },
    });
    if (!saved.saved) throw new Error(`The split progress could not be saved (is database update 0046 applied?): ${saved.error}`);
  };

  try {
    // saved first: if the progress cannot be stored, nothing in Shopify is touched
    await persist(prior ? { split_error: null } : { split_state: 'pending', split_error: null });
    if (prior?.split_state === 'child_total_mismatch') throw new ConflictError(`The new order ${prior.split_order_name} did not have the expected total, so the original order was not changed. Check ${prior.split_order_name} in Shopify.`);

    // 1. nothing ships from the original while the split is half done
    if (row.hold_state === 'none') {
      const holds = await holdFulfillment(store, orderGid, 'Stitch&Ship is splitting this order: the shipment is held until the stitching items are moved to their own order');
      if (holds.length) await patchRow(row, { hold_state: 'held', hold_ids: holds });
    }

    // 2. the new order (found, not made again, when an earlier run already made it)
    let child = prior?.split_order_id ? { id: prior.split_order_id, name: prior.split_order_name } : await findOrderBySourceIdentifier(store, splitSourceIdentifier(payload));
    if (!child) {
      child = await createShopifyOrder(store, buildChildOrder({ payload, alloc, pay, atelier, ref, transactions: fetched?.transactions || [] }));
      const expected = Math.round(alloc.groups.stitchship.total * 100);
      if (Math.abs((child.total_cents ?? expected) - expected) > 1) {
        await persist({ split_order_id: child.id, split_order_name: child.name, split_state: 'child_total_mismatch', split_error: `The new order totals ${child.total_cents / 100}, expected ${expected / 100}.` });
        throw new ConflictError(`The new order ${child.name} totals ${child.total_cents / 100} but ${expected / 100} was expected, so the original order was NOT changed. Check ${child.name} in Shopify.`);
      }
    }
    await persist({ reference: child.name, split_order_id: child.id, split_order_name: child.name, split_state: prior?.split_state && prior.split_state !== 'pending' ? prior.split_state : 'order_created', split_error: null });

    // 3. the stitching lines come off the original order
    let editWarning = prior?.split_error && /After the edit/.test(prior.split_error) ? prior.split_error : null;
    if (!['original_edited', 'done'].includes(prior?.split_state)) {
      const edited = await removeLinesFromOrder(store, orderGid, lines.map((l) => ({ variant_id: l.variant_id, sku: l.sku, title: l.title, quantity: l.quantity })), `Stitch&Ship lines moved to order ${child.name}`);
      const expectedNormal = Math.round(alloc.groups.normal.total * 100);
      const off = Math.abs(edited.total_cents - expectedNormal) > 1;
      editWarning = off ? `After the edit the original order totals ${edited.total_cents / 100}, expected ${expectedNormal / 100} (an order-level discount?).` : null;
      await persist({ split_state: 'original_edited', original_total_after: edited.total_cents / 100, split_error: editWarning });
      if (off) await alert(`Shopify: ${payload.name} does not add up after the split`, `${store.shop_domain}: the original order now totals ${edited.total_cents / 100}, expected ${expectedNormal / 100}. Look at the discounts on it.`);
    }

    // 4. tag and note the original, release its shipment (only normal items are left on it), done
    try {
      await tagAndNoteOrder(store, orderGid, SPLIT_TAG, `Stitch&Ship lines moved to order ${child.name} (${ref}). Their payment stays recorded on this order: do not refund it.`);
    } catch (err) {
      await patchRow(row, { last_error: `Could not tag the original order: ${err.message}` });
    }
    await releaseHold(store, row);
    await persist({ split_state: 'done', split_error: editWarning, overpaid_on_original: pay.groups.stitchship.amount_paid });
    await patchRow(row, { state: 'split', last_error: row.hold_state === 'failed' ? row.last_error : null, payload: null });
    return { status: 'split', childOrderId: child.id, childOrderName: child.name };
  } catch (err) {
    const first = row.state !== 'split_failed';
    await patchRow(row, { state: 'split_failed', last_error: String(err.message || err).slice(0, 500) });
    await persist({ split_error: String(err.message || err).slice(0, 500) }).catch(() => undefined);
    if (first) await alert(`Shopify: ${payload.name} could not be split`, `${store.shop_domain}: ${err.message}. The shipment of the original order stays on hold. Use "Try again" on the order.`);
    if (err instanceof ConflictError) return { status: 'failed' };
    throw err;
  }
};

/** The new order's own record knows which internal order it became: put that on the split of the original order. Best effort. */
const linkChildToSplit = async (store, payload, order) => {
  try {
    const originalId = attr(payload, 'stitchship_split_from_id');
    if (!originalId) return;
    const { data: original } = await supabaseAdmin.from('shopify_orders').select('id').eq('store_id', store.id).eq('shopify_order_id', String(originalId)).maybeSingle();
    if (!original) return;
    await supabaseAdmin.from('shopify_order_splits').update({ order_id: order.id, internal_reference: order.reference || null, updated_at: new Date().toISOString() }).eq('shopify_order_row_id', original.id).eq('kind', 'stitchship');
  } catch {
    /* the link is a convenience */
  }
};

/** A new Shopify order. Returns what happened; throws only for problems worth retrying. */
export const processOrderCreate = async (store, payload) => {
  const marked = candidateLines(store, payload);
  if (!marked.length) {
    console.info(`[Shopify] ${store.shop_domain} order ${payload?.name}: ignored, ${store.settings?.stitch_mode === 'customer' ? 'no line carries the Stitch&Ship marker' : 'the order has no lines'}`);
    return { status: 'ignored' };
  }
  const shopifyId = String(payload.id);
  const email = normaliseEmail(payload.email || payload.contact_email || payload.customer?.email);
  let ref = stitchingRef(payload);

  let { data: row } = await supabaseAdmin.from('shopify_orders').select('*').eq('store_id', store.id).eq('shopify_order_id', shopifyId).maybeSingle();
  if (row && row.state === 'cancelled') return { status: 'cancelled' };
  if (row && ((row.state === 'draft_created' && row.notified_at) || row.state === 'split')) return { status: 'duplicate' };
  // only products with "Stitch&Ship available" ticked are stitched; asked of Shopify before anything is stored (a failure retries cleanly)
  const lines = await eligibleLines(store, marked);
  if (!lines.length) {
    console.info(`[Shopify] ${store.shop_domain} order ${payload.name}: ignored, none of its ${marked.length} line(s) is on a product with "Stitch&Ship available" ticked (a normal order)`);
    return { status: 'ignored' };
  }
  console.info(`[Shopify] ${store.shop_domain} order ${payload.name}: ${lines.length} of ${(payload.line_items || []).length} line(s) are Stitch&Ship${autoSplitOn(store) ? ' (splitting is on)' : ' (splitting is off for this store)'}`);
  if (!row) {
    const ins = await supabaseAdmin
      .from('shopify_orders')
      .insert({ store_id: store.id, shopify_order_id: shopifyId, shopify_order_name: payload.name || null, customer_email: email, ref_code: ref, state: 'received', address_state: 'unknown', hold_state: 'none', hold_ids: [], payload })
      .select('*')
      .single();
    if (ins.error?.code === '23505') {
      row = (await supabaseAdmin.from('shopify_orders').select('*').eq('store_id', store.id).eq('shopify_order_id', shopifyId).maybeSingle()).data;
      if (row?.state === 'draft_created' && row.notified_at) return { status: 'duplicate' };
    } else if (ins.error) throw ins.error;
    else row = ins.data;
  }
  if (!row) throw new Error('The Shopify order could not be recorded.');

  if (!email) {
    await patchRow(row, { state: 'failed', last_error: 'The order has no customer email, so it cannot be matched to a customer.' });
    await alert(`Shopify order ${payload.name} has no email`, `${store.shop_domain}: the order has no customer email and was not turned into an order.`);
    return { status: 'failed' };
  }

  // Splitting in Shopify (only for stores that switched it on, and never for an order this app made itself)
  if (!isSplitChild(payload) && autoSplitOn(store)) {
    // a marked product that is not enabled counts as a normal line
    if (lines.length < (payload.line_items || []).length) return splitOriginalOrder({ store, row, payload, lines });
    // every line is for stitching: the order itself becomes the Stitch&Ship order, with the atelier's address
    try {
      const moved = await moveWholeOrderToAtelier(store, payload, ref);
      payload = moved.payload;
      ref = moved.ref;
    } catch (err) {
      const hint = /country|region/i.test(err.message || '') ? ' Shopify only accepts an address in a country the store ships to: add the country of the Stitch&Ship address to the shipping zones (Shopify admin > Settings > Shipping and delivery).' : '';
      const message = `Could not set the atelier address: ${err.message}.${hint}`.slice(0, 500);
      // a refusal by Shopify (or a missing address in our settings) will not change by itself: say so, stop, and let "Try again" run once it is fixed
      if (err instanceof ConflictError || err.status === 422) {
        await patchRow(row, { state: 'failed', last_error: message });
        await alert(`Shopify: ${payload.name} could not go to the Stitch&Ship address`, `${store.shop_domain}: ${message}`);
        return { status: 'failed' };
      }
      await patchRow(row, { last_error: message });
      throw err;
    }
  }

  try {
    // 1. hold the shipment until the address is checked
    if (row.hold_state === 'none') {
      try {
        const holds = await holdFulfillment(store, payload.admin_graphql_api_id, 'Stitch&Ship is checking the delivery address of this order');
        if (holds.length) await patchRow(row, { hold_state: 'held', hold_ids: holds });
      } catch (err) {
        await patchRow(row, { hold_state: 'failed', last_error: `Could not hold the shipment: ${err.message}` });
        await alert(`Shopify: could not hold ${payload.name}`, `${store.shop_domain}: the shipment of ${payload.name} could not be held (${err.message}). Check its address in Shopify before the brand ships it.`);
      }
    }

    // 2. is the address our atelier?
    const atelier = await loadShipTo().catch(() => ({}));
    const ok = addressMatchesAtelier({ shipping: payload.shipping_address, atelier, ref });
    const wasKnown = row.address_state !== 'unknown';
    await patchRow(row, { address_state: ok ? 'address_ok' : 'address_mismatch', ...(store.settings?.sms_enabled === true && smsEnabled() && !row.sms_notified_at && !row.customer_phone ? { customer_phone: pickCustomerPhone(payload, atelier) } : {}) });

    // 3. right address: let the brand ship; wrong: keep the hold
    if (ok) await releaseHold(store, row);
    else if (!wasKnown) await alert(`Shopify: ${payload.name} is not going to the atelier`, `${store.shop_domain}: the shipping address of ${payload.name} is not the atelier address. The shipment is on hold until the customer confirms.`);

    // what each group of lines is worth and how much of the one real payment covers it (Shopify's own data, never the page's)
    const alloc = allocateOrder(payload, lines.map((l) => l.id));
    const fetched = await fetchOrderFinancials(store, payload.admin_graphql_api_id).catch((err) => {
      console.warn('[Shopify] could not read the payment of', payload.name, err.message);
      return null;
    });
    const pay = allocatePayment(alloc, readFinancials(payload, fetched));
    const split = { alloc, pay };
    if (alloc.mixed && !row.order_id) {
      await alert(`Shopify: ${payload.name} mixes stitching and normal items`, `${store.shop_domain}: ${lines.length} stitching line(s) and ${alloc.groups.normal.line_ids.length} normal line(s) were bought in one checkout, so they share one shipping address${ok ? ' (the atelier): the normal items must be delivered to the customer separately' : ''}.`);
    }

    // 4. the customer and their draft order
    if (!row.order_id) {
      const { profile } = await findOrCreateCustomerByEmail({ email, name: payload.customer ? `${payload.customer.first_name || ''} ${payload.customer.last_name || ''}`.trim() : payload.shipping_address?.name });
      const order = await createDraft({ store, payload, lines, profile, ref, email, split });
      await patchRow(row, { order_id: order.id, state: 'draft_created', last_error: null });
      row.__order = order;
      if (isSplitChild(payload)) await linkChildToSplit(store, payload, order);
    }
    const order = row.__order || (await supabaseAdmin.from('orders').select('*').eq('id', row.order_id).maybeSingle()).data;

    // 5. tag in Shopify (for the brand's own view), then email the customer
    const tag = alloc.mixed ? STITCH_MIXED_TAG : STITCH_TAG;
    await addOrderTag(store, payload.admin_graphql_api_id, tag).catch((err) => patchRow(row, { last_error: `Could not tag the order: ${err.message}` }));
    // the price split of this order (idempotent: one row per original order and group), with the address each group uses
    const saved = await saveSplit({ row, store, payload, alloc, pay, orderId: row.order_id, addresses: groupAddresses(payload, alloc, ok), tags: { stitchship: STITCH_TAG, normal: null } });
    const splitFailed = !saved.saved && !/does not exist|schema cache|could not find the table/i.test(saved.error || '');
    if (order && !row.notified_at) await sendCustomerEmail({ row, order, email, mismatch: !ok, store });

    if (splitFailed) {
      await patchRow(row, { last_error: `Could not save the price split: ${saved.error}`.slice(0, 500) });
      await alert(`Shopify: the price split of ${payload.name} was not saved`, `${store.shop_domain}: ${saved.error}. Use "Try again" on the order.`);
    }
    // the Shopify copy holds personal data: keep it only while something is still open (an unsaved split is still open)
    if (ok && row.notified_at && row.hold_state !== 'failed' && !splitFailed) await patchRow(row, { payload: null });
    return { status: 'processed', addressOk: ok, orderId: row.order_id };
  } catch (err) {
    if (err instanceof ConflictError) {
      await patchRow(row, { state: 'failed', last_error: err.message });
      await alert(`Shopify order ${payload.name} could not be taken in`, `${store.shop_domain}: ${err.message}`);
      return { status: 'failed' };
    }
    await patchRow(row, { last_error: String(err.message || err).slice(0, 500) });
    throw err;
  }
};

/** Shopify says the order changed. We act on a cancellation, and on an address fixed by the brand or the customer. */
export const processOrderUpdated = async (store, payload) => {
  const { data: row } = await supabaseAdmin.from('shopify_orders').select('*').eq('store_id', store.id).eq('shopify_order_id', String(payload.id)).maybeSingle();
  if (!row) return { status: 'ignored' };
  if (payload.cancelled_at) return cancelRow(store, row);

  if (row.order_id && payload.financial_status) {
    const info = shopifyPaymentInfo(payload);
    await supabaseAdmin.from('orders').update({ brand_payment_status: info.kind === 'paid' ? 'paid' : 'pending' }).eq('id', row.order_id).eq('status', 'draft').not('brand_payment_method', 'is', null);
    await saveShopifyPayment(row.order_id, payload);
    await refreshSplit(store, row, payload).catch((err) => console.warn('[Shopify] could not update the price split:', err.message));
    // Shopify now shows the order fully paid: stop asking for payment (a payment already made here is kept)
    if (info.kind === 'paid') {
      const { data: order } = await supabaseAdmin.from('orders').select('*').eq('id', row.order_id).maybeSingle();
      if (order) await markPaidAtShopify(order).catch((err) => console.warn('[Shopify] could not close the payment:', err.message));
    }
  }
  if (row.address_state === 'address_mismatch' && row.hold_state === 'held') {
    const atelier = await loadShipTo().catch(() => ({}));
    if (addressMatchesAtelier({ shipping: payload.shipping_address, atelier, ref: row.ref_code })) {
      await patchRow(row, { address_state: 'address_ok' });
      await releaseHold(store, row);
      if (row.order_id) await addEvent(row.order_id, 'draft', 'The shipping address is now the atelier: the brand can ship it', null);
    }
  }
  return { status: 'updated' };
};

/**
 * Work the price split out again from Shopify's current order (a payment arrived, a refund was made): the same groups, new payment figures.
 * @param {object|null} payload the Shopify order; without it only the payment is re-read for the saved groups
 */
export const refreshSplit = async (store, row, payload = null) => {
  const rows = await loadSplit(row.id);
  const stitch = rows.find((r) => r.kind === 'stitchship');
  if (!stitch) return { refreshed: false };
  // an order that was split in Shopify has its own payments now: its record is not re-worked from the smaller original
  if (stitch.split_order_id) return { refreshed: false, split: true };
  let alloc;
  let order = payload;
  if (payload) alloc = allocateOrder(payload, stitch.line_ids || []);
  else {
    // the Shopify copy was cleared once the order was settled: the groups are rebuilt from what was saved
    const groups = Object.fromEntries(rows.map((r) => [r.kind, { ...r, total: Number(r.total), _cents: Math.round(Number(r.total) * 100) }]));
    for (const kind of ['stitchship', 'normal']) groups[kind] ||= { kind, line_ids: [], lines: [], total: 0, _cents: 0, subtotal: 0, discounts: 0, taxes: 0, shipping: 0, shipping_tax: 0 };
    alloc = { groups, mixed: rows.length > 1, currency: stitch.currency, taxes_included: stitch.taxes_included, reconciled: stitch.reconciled, unallocated: Number(stitch.unallocated || 0) };
    order = { id: row.shopify_order_id, name: row.shopify_order_name, total_price: String(Number(stitch.total) + Number(rows.find((r) => r.kind === 'normal')?.total || 0)), financial_status: stitch.financial_status, currency: stitch.currency };
  }
  const fetched = await fetchOrderFinancials(store, `gid://shopify/Order/${row.shopify_order_id}`);
  const pay = allocatePayment(alloc, readFinancials(order, fetched));
  const addresses = Object.fromEntries(rows.map((r) => [r.kind, r.address]));
  const tags = Object.fromEntries(rows.map((r) => [r.kind, r.tag]));
  const saved = await saveSplit({ row, store, payload: order, alloc, pay, addresses, tags, orderId: row.order_id });
  if (!saved.saved) throw new Error(saved.error);
  return { refreshed: true };
};

/** The split of an order that was taken in but whose split was not saved: worked out again from the kept Shopify copy. Idempotent. */
export const rebuildSplit = async (store, row) => {
  const payload = row.payload;
  const marked = stitchingLines(payload);
  const lines = await eligibleLines(store, marked);
  if (!lines.length) return { rebuilt: false };
  const alloc = allocateOrder(payload, lines.map((l) => l.id));
  const fetched = await fetchOrderFinancials(store, payload.admin_graphql_api_id).catch(() => null);
  const pay = allocatePayment(alloc, readFinancials(payload, fetched));
  const saved = await saveSplit({ row, store, payload, alloc, pay, orderId: row.order_id, addresses: groupAddresses(payload, alloc, row.address_state === 'address_ok'), tags: { stitchship: STITCH_TAG, normal: null } });
  if (!saved.saved) throw new Error(saved.error);
  await patchRow(row, { last_error: null });
  if (row.address_state === 'address_ok' && row.notified_at && row.hold_state !== 'failed') await patchRow(row, { payload: null });
  return { rebuilt: true };
};

const cancelRow = async (store, row) => {
  if (row.state === 'cancelled') return { status: 'cancelled' };
  await markSplitCancelled(row.id);
  await patchRow(row, { state: 'cancelled', payload: null });
  if (row.order_id) {
    const { data: order } = await supabaseAdmin.from('orders').select('id, reference, status').eq('id', row.order_id).maybeSingle();
    if (order?.status === 'draft') {
      await supabaseAdmin.from('orders').update({ status: 'cancelled', updated_at: new Date().toISOString() }).eq('id', order.id).eq('status', 'draft');
      await addEvent(order.id, 'cancelled', 'The brand order was cancelled in Shopify', null);
    } else if (order) {
      await addEvent(order.id, order.status, 'The brand order was cancelled in Shopify', null);
      await alert(`Shopify: the brand order of ${order.reference} was cancelled`, `${store.shop_domain}: the brand cancelled the order that ${order.reference} came from, but our order is already in progress. Check it.`, order.id);
    }
  }
  return { status: 'cancelled' };
};

export const processOrderCancelled = async (store, payload) => {
  const { data: row } = await supabaseAdmin.from('shopify_orders').select('*').eq('store_id', store.id).eq('shopify_order_id', String(payload.id)).maybeSingle();
  return row ? cancelRow(store, row) : { status: 'ignored' };
};

/**
 * The customer confirms, in the portal, that their order should go to the atelier. Only now is the address on the brand's order
 * changed (it is their decision, not ours), and the shipment is released.
 */
export const confirmAtelierAddress = async ({ order, actorId }) => {
  const { data: row } = await supabaseAdmin.from('shopify_orders').select('*').eq('order_id', order.id).maybeSingle();
  if (!row) throw new ConflictError('This order does not come from a Shopify store.');
  if (row.address_state !== 'address_mismatch') return { changed: false };
  const { data: store } = await supabaseAdmin.from('shopify_stores').select('*').eq('id', row.store_id).maybeSingle();
  if (!store || store.status !== 'active') throw new ConflictError('The brand store is not connected any more. Please contact us.');
  const atelier = await loadShipTo();
  const ship = row.payload?.shipping_address || {};
  await updateShippingAddress(store, row.payload?.admin_graphql_api_id || `gid://shopify/Order/${row.shopify_order_id}`, {
    firstName: ship.first_name || undefined,
    lastName: ship.last_name || undefined,
    company: atelier.shipToName || 'Stitch&Ship Atelier',
    address1: atelier.shipToAddress,
    address2: row.ref_code || undefined,
    city: atelier.shipToCity,
    countryCode: store.settings?.atelier_country_code || 'PK',
    phone: atelier.shipToPhone || undefined,
  });
  await patchRow(row, { address_state: 'address_ok' });
  await releaseHold(store, row);
  await addEvent(order.id, order.status, 'The customer confirmed that the order goes to the atelier', actorId);
  await alert(`Shopify: ${row.shopify_order_name} now goes to the atelier`, `${store.shop_domain}: the customer confirmed the atelier address and the shipment was released.`, order.id);
  return { changed: true };
};

/** Admin: run an order that failed again (from the copy of the order we kept), or send its email again. */
export const retryShopifyOrder = async (rowId) => {
  const { data: row } = await supabaseAdmin.from('shopify_orders').select('*').eq('id', rowId).maybeSingle();
  if (!row) throw new ConflictError('Shopify order not found.');
  const { data: store } = await supabaseAdmin.from('shopify_stores').select('*').eq('id', row.store_id).maybeSingle();
  const active = store?.status === 'active' ? store : null;
  if (!active) throw new ConflictError('The brand store is not connected.');
  // an order that was taken in, whose price split was not saved: worked out again from the kept Shopify copy
  if (row.payload && row.state === 'draft_created' && row.order_id) {
    const existing = await loadSplit(row.id);
    if (!existing.length) {
      try {
        const done = await rebuildSplit(active, row);
        return { status: done.rebuilt ? 'split_saved' : 'ignored' };
      } catch (err) {
        throw new ConflictError(`The price split could not be saved: ${err.message}`);
      }
    }
  }
  // a settled order (its Shopify copy was cleared): only the payment of its saved price split is checked with Shopify again
  if (!row.payload) {
    try {
      const done = await refreshSplit(active, row, null);
      if (!done.refreshed) throw new ConflictError('There is nothing left to retry for this order.');
      return { status: 'payment_rechecked' };
    } catch (err) {
      if (err instanceof ConflictError) throw err;
      throw new ConflictError(`Shopify could not be reached to check the payment: ${err.message}`);
    }
  }
  if (row.state === 'failed') await patchRow(row, { state: 'received', last_error: null });
  // a split that stopped part way carries on from where it stopped (the saved steps are never repeated)
  if (['split_failed', 'split_pending'].includes(row.state)) await patchRow(row, { state: 'split_failed' });
  return processOrderCreate(active, row.payload);
};

export const resendCustomerEmail = async (rowId) => {
  const { data: row } = await supabaseAdmin.from('shopify_orders').select('*').eq('id', rowId).maybeSingle();
  if (!row?.order_id) throw new ConflictError('This Shopify order has no Stitch&Ship order yet.');
  const { data: order } = await supabaseAdmin.from('orders').select('*').eq('id', row.order_id).maybeSingle();
  const result = await sendCustomerEmail({ row, order, email: row.customer_email, mismatch: row.address_state === 'address_mismatch' });
  if (!result.sent) throw new ConflictError(result.detail ? `The email could not be sent: ${result.detail}` : 'The email could not be sent. Check the email settings on the server.');
  return result;
};

/** Everything an admin has to look at: failed orders, held addresses, customers who were not emailed. */
export const shopifyQueue = async () => {
  const { data, error } = await supabaseAdmin
    .from('shopify_orders')
    .select('id, store_id, shopify_order_id, shopify_order_name, order_id, customer_email, ref_code, state, address_state, hold_state, notified_at, last_error, created_at, store:shopify_stores!shopify_orders_store_id_fkey(shop_domain), order:orders!shopify_orders_order_id_fkey(id, reference)')
    .order('created_at', { ascending: false })
    .limit(200);
  if (error) throw error;
  const rowIds = (data || []).map((r) => r.id);
  const splits = await loadSplits(rowIds);
  const splitAttention = (list) => (list || []).some((x) => ['verification_pending', 'paid_unverified'].includes(x.payment_status) || x.reconciled === false || x.address?.needs_separate_delivery);
  const attention = (r) => r.state === 'failed' || r.state === 'split_failed' || r.state === 'split_pending' || (r.address_state === 'address_mismatch' && r.hold_state === 'held') || r.hold_state === 'failed' || (r.state === 'draft_created' && !r.notified_at);
  return (data || []).map((r) => ({ ...r, store: Array.isArray(r.store) ? r.store[0] : r.store, order: Array.isArray(r.order) ? r.order[0] : r.order, split: (splits.get(r.id) || []).sort((a, b) => (a.kind < b.kind ? 1 : -1)), needs_attention: attention(r) || splitAttention(splits.get(r.id)) }));
};

export { getActiveStore };
