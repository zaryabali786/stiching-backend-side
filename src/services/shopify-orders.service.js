import { supabaseAdmin } from '../config/supabase.js';
import { ilikeAny } from '../utils/pagination.js';
import { config } from '../config/env.js';
import { ConflictError, NotFoundError } from '../utils/error.helper.js';
import { atelierCountryName, atelierMailingAddress, loadShipTo } from './ship-to.service.js';
import { addOrderTag, fetchLineItemDetails, fetchRestOrder, getActiveStore, holdFulfillment, productsStitchEnabled, releaseFulfillment, tagAndNoteOrder, updateShippingAddress } from './shopify.service.js';
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

/** Is this shipping address our atelier? The street and the city must match (the reference code travels as an order property, not in the address). */
export const addressMatchesAtelier = ({ shipping, atelier, ref }) => {
  if (!shipping) return false;
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
 * The lines that could make the order a Stitch&Ship order. By default (stitch_mode "customer") the customer must have ticked Stitch&Ship on the
 * product page (the marker on the line); with stitch_mode "enabled" every line is a candidate. In both cases the product's own "Stitch&Ship
 * available" box (checked next) must be ticked. The payment method never matters.
 */
export const candidateLines = (store, payload) => (store.settings?.stitch_mode === 'enabled' ? payload?.line_items || [] : stitchingLines(payload));

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
  if (kept.length < candidates.length) {
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

const paymentFields = (store, payload) => {
  const gateways = (payload.payment_gateway_names || []).map((g) => String(g)).filter(Boolean);
  const extra = (store.settings?.cod_gateway_names || []).map((g) => String(g).toLowerCase());
  const cod = gateways.find((g) => isCod(g) || extra.includes(g.toLowerCase()));
  const method = cod || gateways[0] || null;
  const info = shopifyPaymentInfo(payload);
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
const saveShopifyPayment = async (orderId, payload) => {
  try {
    const info = shopifyPaymentInfo(payload);
    await supabaseAdmin.from('orders').update({ shopify_financial_status: info.financial_status, shopify_amount_paid: info.amount_paid, shopify_outstanding: info.outstanding, shopify_payment_checked_at: new Date().toISOString() }).eq('id', orderId);
  } catch (err) {
    console.warn('[Shopify] could not save the payment status:', err.message);
  }
};

const patchRow = async (row, patch) => {
  const { data } = await supabaseAdmin.from('shopify_orders').update({ ...patch, updated_at: new Date().toISOString() }).eq('id', row.id).select('*').maybeSingle();
  Object.assign(row, data || patch);
  return row;
};

const alert = (title, body, orderId = null) => notifyAdmins({ type: 'alert', title, body, link: '/admin/shopify', ...(orderId ? { orderId } : {}) }).catch(() => undefined);

/** Make the customer's draft order from the stitching lines (same shape as a draft made from a forwarded email). */
const createDraft = async ({ store, payload, lines, profile, ref, email }) => {
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
  const total = Number(payload.total_price);
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
    ...paymentFields(store, payload),
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
  await saveShopifyPayment(order.id, payload);
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

/** The products of the order for the email: one row per product (pieces of the same product and price counted together). Never throws. */
const emailItems = async (orderId) => {
  try {
    const { data } = await supabaseAdmin.from('order_units').select('unit_title, quantity, unit_price, product_image_url, line_no').eq('order_id', orderId).order('line_no', { ascending: true });
    const rows = [];
    for (const u of data || []) {
      const price = Number(u.unit_price) || 0;
      const hit = rows.find((r) => r.title === u.unit_title && r.price === price);
      if (hit) hit.quantity += Number(u.quantity) || 1;
      else rows.push({ title: u.unit_title || 'Item', quantity: Number(u.quantity) || 1, price, image_url: u.product_image_url || null });
    }
    return rows;
  } catch {
    return [];
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
        heading: `Your order ${name} is confirmed`,
        brand: order.brand,
        paragraphs: [
          'We received your order for customised stitching. Here is what you ordered:',
          'Please add your sizes and choices so we can start as soon as your parcel arrives. It takes about 3 minutes.',
        ],
        items: await emailItems(order.id),
        currency: order.brand_order_currency || '',
        total: order.brand_order_total,
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

/** The Stitch&Ship address from the settings must be there before anything is split or moved: a clear error, never a silent skip. */
const assertAtelierAddress = (atelier) => {
  if (!atelier?.shipToAddress || !atelier?.shipToCity) throw new ConflictError('The Stitch&Ship shipping address is not set (Admin > Settings > Stitch&Ship address: street and city), so the order was not split.');
};

const atelierAddressMessage = (err) => {
  const hint = /country|region/i.test(err.message || '') ? ' Shopify only accepts an address in a country the store ships to: add the country of the Stitch&Ship address to the shipping zones (Shopify admin > Settings > Shipping and delivery).' : '';
  return `Could not set the atelier address: ${err.message}.${hint}`.slice(0, 500);
};

/**
 * The order has a Stitch&Ship line, so the WHOLE order goes to the atelier: its delivery address is set to the atelier's (the customer's own
 * address is kept in the order note). One order, never split. The only address this app ever changes by itself.
 */
const moveWholeOrderToAtelier = async (store, payload, ref) => {
  const atelier = await loadShipTo().catch(() => ({}));
  const ship = payload.shipping_address;
  assertAtelierAddress(atelier);
  if (addressMatchesAtelier({ shipping: ship, atelier, ref })) return { payload, ref };
  const useRef = ref || makeRef();
  await updateShippingAddress(store, payload.admin_graphql_api_id, atelierMailingAddress(atelier, store, { firstName: ship?.first_name || undefined, lastName: ship?.last_name || undefined }));
  const own = [ship?.address1, ship?.address2, ship?.city, ship?.country].filter(Boolean).join(', ');
  await tagAndNoteOrder(store, payload.admin_graphql_api_id, null, `The customer's own delivery address: ${own}. Every item of this order is for Stitch&Ship, so its delivery address is now the atelier's.`).catch(() => undefined);
  return { payload: { ...payload, shipping_address: { ...ship, company: atelier.shipToCompany || atelier.shipToName || 'Stitch&Ship Atelier', address1: atelier.shipToAddress, address2: atelier.shipToAddress2 || undefined, city: atelier.shipToCity, province: atelier.shipToState || undefined, province_code: atelier.shipToProvinceCode || undefined, zip: atelier.shipToZip || undefined, country: atelierCountryName(atelier), country_code: atelier.shipToCountryCode || undefined, phone: atelier.shipToPhone || ship?.phone } }, ref: useRef };
};

/** A new Shopify order. Returns what happened; throws only for problems worth retrying. */
export const processOrderCreate = async (store, payload, { force = false } = {}) => {
  // force: an administrator imports an order the customer's tick never reached (the product's own box in Shopify is still checked)
  const candidates = force ? payload?.line_items || [] : candidateLines(store, payload);
  if (!candidates.length) {
    console.info(`[Shopify] ${store.shop_domain} order ${payload?.name}: ignored, ${store.settings?.stitch_mode === 'enabled' ? 'the order has no lines' : 'the customer did not tick Stitch&Ship on any line'}`);
    return { status: 'ignored' };
  }
  const shopifyId = String(payload.id);
  const email = normaliseEmail(payload.email || payload.contact_email || payload.customer?.email);
  let ref = stitchingRef(payload);

  let { data: row } = await supabaseAdmin.from('shopify_orders').select('*').eq('store_id', store.id).eq('shopify_order_id', shopifyId).maybeSingle();
  if (row && row.state === 'cancelled') return { status: 'cancelled' };
  // a delivery seen before, or an order an earlier version of the app split in Shopify: left exactly as it is
  if (row && ((row.state === 'draft_created' && row.notified_at) || ['split', 'split_pending', 'split_failed'].includes(row.state))) return { status: 'duplicate' };
  // the lines that qualify: ticked by the customer AND on a product with "Stitch&Ship available" ticked (asked of Shopify before anything is stored)
  const qualifying = await eligibleLines(store, candidates);
  if (!qualifying.length) {
    console.info(`[Shopify] ${store.shop_domain} order ${payload.name}: ignored, none of its ${candidates.length} candidate line(s) is on a product with "Stitch&Ship available" ticked (a normal order)`);
    return { status: 'ignored' };
  }
  // ONE order: every line of the purchase stays in it, the stitching ones and the others
  const lines = (payload.line_items || []).filter((l) => Number(l.quantity) > 0);
  console.info(`[Shopify] ${store.shop_domain} order ${payload.name}: ${qualifying.length} of ${lines.length} line(s) qualify, so the WHOLE order is one Stitch&Ship order`);
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

  // things that went wrong but must not stop the order from being recognised as Stitch&Ship: they are kept, shown to an administrator, and can be retried
  let addressWarning = null;
  let tagWarning = null;
  // The tag comes FIRST, before the slower steps (address, hold, internal order, email): the order shows its Stitch&Ship tag in the Shopify
  // admin within a second or two. The same for every payment method and for an order that holds other products too.
  try {
    await addOrderTag(store, payload.admin_graphql_api_id, STITCH_TAG);
    console.info(`[Shopify] ${store.shop_domain} order ${payload.name}: tagged "${STITCH_TAG}"`);
  } catch (err) {
    tagWarning = `Could not tag the order: ${err.message}`.slice(0, 300);
    console.warn(`[Shopify] ${store.shop_domain} order ${payload.name}: ${tagWarning}`);
  }
  // the whole order goes to the atelier: its delivery address is set to the atelier's (the customer's own is kept in the order note)
  try {
    const moved = await moveWholeOrderToAtelier(store, payload, ref);
    payload = moved.payload;
    ref = moved.ref;
  } catch (err) {
    const message = atelierAddressMessage(err);
    // a refusal by Shopify (or a missing address in our settings) will not change by itself: keep going (tag, internal order, email: the
    // shipment stays on hold because the address is not the atelier's), remember the warning, and let "Try again" redo the address
    if (err instanceof ConflictError || err.status === 422) {
      addressWarning = message;
      if (!row.order_id) await alert(`Shopify: ${payload.name} could not go to the Stitch&Ship address`, `${store.shop_domain}: ${message}`);
    } else {
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

    // 4. the customer and their order: ONE order with every line of the purchase
    if (!row.order_id) {
      const { profile } = await findOrCreateCustomerByEmail({ email, name: payload.customer ? `${payload.customer.first_name || ''} ${payload.customer.last_name || ''}`.trim() : payload.shipping_address?.name });
      const order = await createDraft({ store, payload, lines, profile, ref, email });
      await patchRow(row, { order_id: order.id, state: 'draft_created', last_error: null });
      row.__order = order;
    }
    const order = row.__order || (await supabaseAdmin.from('orders').select('*').eq('id', row.order_id).maybeSingle()).data;

    // 5. the tag was set at the start; only when that failed is it tried once more here (a tag already there is fine). Then the customer is emailed.
    if (tagWarning) {
      try {
        await addOrderTag(store, payload.admin_graphql_api_id, STITCH_TAG);
        tagWarning = null;
      } catch (err) {
        tagWarning = `Could not tag the order: ${err.message}`.slice(0, 300);
      }
    }
    const warnings = [addressWarning, tagWarning].filter(Boolean);
    if (order && !row.notified_at) await sendCustomerEmail({ row, order, email, mismatch: !ok, store });

    // the warnings are written after the email (which clears the error line) so the administrator sees them
    if (warnings.length) {
      await patchRow(row, { last_error: warnings.join(' | ').slice(0, 500) });
      if (tagWarning) await alert(`Shopify: ${payload.name} could not be tagged`, `${store.shop_domain}: ${tagWarning}. Use "Try again" on the order.`);
    }
    // the Shopify copy holds personal data: keep it only while something is still open (a warning is still open)
    if (ok && row.notified_at && row.hold_state !== 'failed' && !warnings.length) await patchRow(row, { payload: null });
    return { status: 'processed', addressOk: ok, orderId: row.order_id, warnings };
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
 * Finish what an order that was taken in could not finish: tag it again (a tag already there is fine) and set the atelier address again (and let
 * the shipment go once it is the atelier's). Warnings that are gone are cleared, the ones that remain are kept. Idempotent: nothing is made twice.
 */
export const repairStitchOrder = async (store, row) => {
  const gid = `gid://shopify/Order/${row.shopify_order_id}`;
  const warnings = [];
  try {
    await addOrderTag(store, gid, STITCH_TAG);
  } catch (err) {
    warnings.push(`Could not tag the order: ${err.message}`.slice(0, 300));
  }
  if (/atelier address/i.test(row.last_error || '')) {
    if (!row.payload) {
      warnings.push('Could not set the atelier address: the order copy is gone, set the address in Shopify by hand.');
    } else {
      try {
        await moveWholeOrderToAtelier(store, row.payload, row.ref_code);
        await patchRow(row, { address_state: 'address_ok' });
        await releaseHold(store, row);
      } catch (err) {
        warnings.push(atelierAddressMessage(err));
      }
    }
  }
  await patchRow(row, { last_error: warnings.length ? warnings.join(' | ').slice(0, 500) : null });
  if (!warnings.length && row.address_state === 'address_ok' && row.notified_at && row.hold_state !== 'failed') await patchRow(row, { payload: null });
  return { status: warnings.length ? 'repaired_with_warnings' : 'repaired', warnings };
};

const cancelRow = async (store, row) => {
  if (row.state === 'cancelled') return { status: 'cancelled' };
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
  await updateShippingAddress(store, row.payload?.admin_graphql_api_id || `gid://shopify/Order/${row.shopify_order_id}`, atelierMailingAddress(atelier, store, { firstName: ship.first_name || undefined, lastName: ship.last_name || undefined }));
  await patchRow(row, { address_state: 'address_ok' });
  await releaseHold(store, row);
  await addEvent(order.id, order.status, 'The customer confirmed that the order goes to the atelier', actorId);
  await alert(`Shopify: ${row.shopify_order_name} now goes to the atelier`, `${store.shop_domain}: the customer confirmed the atelier address and the shipment was released.`, order.id);
  return { changed: true };
};

/** Admin: run an order that failed again (from the copy of the order we kept), or finish what it could not finish (the tag, the address). */
export const retryShopifyOrder = async (rowId) => {
  const { data: row } = await supabaseAdmin.from('shopify_orders').select('*').eq('id', rowId).maybeSingle();
  if (!row) throw new ConflictError('Shopify order not found.');
  const { data: store } = await supabaseAdmin.from('shopify_stores').select('*').eq('id', row.store_id).maybeSingle();
  const active = store?.status === 'active' ? store : null;
  if (!active) throw new ConflictError('The brand store is not connected.');
  // an order an earlier version of the app split in Shopify: never touched again
  if (['split', 'split_pending', 'split_failed'].includes(row.state)) throw new ConflictError('An earlier version of the app split this order in Shopify. It is left as it is: look at it in Shopify.');
  // taken in with a warning (the tag or the address): finished again
  if (row.state === 'draft_created' && /Could not (tag|set the atelier)/i.test(row.last_error || '')) return repairStitchOrder(active, row);
  if (!row.payload || (row.state === 'draft_created' && row.notified_at)) throw new ConflictError('There is nothing left to retry for this order.');
  if (row.state === 'failed') await patchRow(row, { state: 'received', last_error: null });
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

/** Everything an admin has to look at: failed orders, held addresses, customers who were not emailed, a tag or an address that did not go through. */
const QUEUE_SELECT = 'id, store_id, shopify_order_id, shopify_order_name, order_id, customer_email, ref_code, state, address_state, hold_state, notified_at, last_error, created_at, store:shopify_stores!shopify_orders_store_id_fkey(shop_domain), order:orders!shopify_orders_order_id_fkey(id, reference)';

const needsAttention = (r) =>
  r.state === 'failed' ||
  ['split_failed', 'split_pending'].includes(r.state) ||
  (r.address_state === 'address_mismatch' && r.hold_state === 'held') ||
  r.hold_state === 'failed' ||
  (r.state === 'draft_created' && !r.notified_at) ||
  (r.state === 'draft_created' && /Could not (tag|set the atelier)/i.test(r.last_error || ''));

const decorate = (r) => ({ ...r, store: Array.isArray(r.store) ? r.store[0] : r.store, order: Array.isArray(r.order) ? r.order[0] : r.order, needs_attention: needsAttention(r) });

export const shopifyQueue = async () => {
  const { data, error } = await supabaseAdmin.from('shopify_orders').select(QUEUE_SELECT).order('created_at', { ascending: false }).limit(200);
  if (error) throw error;
  return (data || []).map(decorate);
};

/**
 * One page of the Shopify orders (newest first) for the admin table: searched on the server by Shopify order number, customer email, store or
 * the app order reference (SA-…), and optionally limited to one store. `list` is parseListQuery's result (page, limit, search, from, to).
 * @returns {Promise<{ rows: object[], total: number }>}
 */
export const shopifyOrdersPage = async (list, { storeId = null } = {}) => {
  let query = supabaseAdmin.from('shopify_orders').select(QUEUE_SELECT, { count: 'exact' }).order('created_at', { ascending: false }).range(list.from, list.to);
  if (storeId) query = query.eq('store_id', storeId);
  if (list.search) {
    // the store's address and the app order's reference live in other tables: find their ids first, then match on them as well
    const [stores, orders] = await Promise.all([
      supabaseAdmin.from('shopify_stores').select('id').ilike('shop_domain', `%${list.search}%`).limit(50),
      supabaseAdmin.from('orders').select('id').ilike('reference', `%${list.search}%`).limit(50),
    ]);
    const parts = [ilikeAny(['shopify_order_name', 'shopify_order_id', 'customer_email', 'ref_code'], list.search)];
    const storeIds = (stores.data || []).map((r) => r.id);
    const orderIds = (orders.data || []).map((r) => r.id);
    if (storeIds.length) parts.push(`store_id.in.(${storeIds.join(',')})`);
    if (orderIds.length) parts.push(`order_id.in.(${orderIds.join(',')})`);
    query = query.or(parts.join(','));
  }
  const { data, error, count } = await query;
  if (error) throw error;
  return { rows: (data || []).map(decorate), total: count || 0 };
};

export { getActiveStore };

/**
 * An administrator imports an order that already exists in Shopify and never became an app order (its webhook was ignored or lost). Nothing is
 * created in Shopify; the same idempotent path as the webhook runs, so repeating it never duplicates anything. With `force` the customer's tick
 * is not required (the product must still have "Stitch&Ship available" ticked in Shopify).
 */
export const importShopifyOrder = async (storeId, orderName, { force = false } = {}) => {
  const { data: store } = await supabaseAdmin.from('shopify_stores').select('*').eq('id', storeId).maybeSingle();
  if (!store || store.status === 'uninstalled') throw new NotFoundError('Store not found.');
  const payload = await fetchRestOrder(store, orderName);
  if (!payload) throw new NotFoundError(`Shopify has no order ${orderName} in ${store.shop_domain}.`);
  return { order: payload.name, ...(await processOrderCreate(store, payload, { force })) };
};
