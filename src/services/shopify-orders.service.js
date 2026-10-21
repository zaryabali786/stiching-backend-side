import { supabaseAdmin } from '../config/supabase.js';
import { config } from '../config/env.js';
import { ConflictError } from '../utils/error.helper.js';
import { loadShipTo } from './ship-to.service.js';
import { addOrderTag, fetchLineItemDetails, getActiveStore, holdFulfillment, releaseFulfillment, updateShippingAddress } from './shopify.service.js';
import { findOrCreateCustomerByEmail } from './customer-accounts.service.js';
import { issueLoginCode, normaliseEmail } from './login-code.service.js';
import { renderEmail, sendTransactionalEmail } from './transactional-email.service.js';
import { cleanBrandName, defaultPartnerId, ensureBrand, expandItemsToUnits } from './order-import.service.js';
import { addEvent } from './order.service.js';
import { isCod } from './email-order-match.service.js';
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

const paymentFields = (store, payload) => {
  const gateways = (payload.payment_gateway_names || []).map((g) => String(g)).filter(Boolean);
  const extra = (store.settings?.cod_gateway_names || []).map((g) => String(g).toLowerCase());
  const cod = gateways.find((g) => isCod(g) || extra.includes(g.toLowerCase()));
  const method = cod || gateways[0] || null;
  const paid = ['paid', 'partially_paid', 'authorized'].includes(String(payload.financial_status || '').toLowerCase());
  return { brand_payment_method: method ? method.slice(0, 80) : null, brand_payment_status: method ? (paid ? 'paid' : 'pending') : null };
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

/** A new Shopify order. Returns what happened; throws only for problems worth retrying. */
export const processOrderCreate = async (store, payload) => {
  const lines = stitchingLines(payload);
  if (!lines.length) return { status: 'ignored' };
  const shopifyId = String(payload.id);
  const email = normaliseEmail(payload.email || payload.contact_email || payload.customer?.email);
  const ref = stitchingRef(payload);

  let { data: row } = await supabaseAdmin.from('shopify_orders').select('*').eq('store_id', store.id).eq('shopify_order_id', shopifyId).maybeSingle();
  if (row && row.state === 'cancelled') return { status: 'cancelled' };
  if (row && row.state === 'draft_created' && row.notified_at) return { status: 'duplicate' };
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

    // 4. the customer and their draft order
    if (!row.order_id) {
      const { profile } = await findOrCreateCustomerByEmail({ email, name: payload.customer ? `${payload.customer.first_name || ''} ${payload.customer.last_name || ''}`.trim() : payload.shipping_address?.name });
      const order = await createDraft({ store, payload, lines, profile, ref, email });
      await patchRow(row, { order_id: order.id, state: 'draft_created', last_error: null });
      row.__order = order;
    }
    const order = row.__order || (await supabaseAdmin.from('orders').select('*').eq('id', row.order_id).maybeSingle()).data;

    // 5. tag in Shopify (for the brand's own view), then email the customer
    await addOrderTag(store, payload.admin_graphql_api_id, STITCH_TAG).catch((err) => patchRow(row, { last_error: `Could not tag the order: ${err.message}` }));
    if (order && !row.notified_at) await sendCustomerEmail({ row, order, email, mismatch: !ok, store });

    // the Shopify copy holds personal data: keep it only while something is still open
    if (ok && row.notified_at && row.hold_state !== 'failed') await patchRow(row, { payload: null });
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
    const paid = ['paid', 'partially_paid', 'authorized'].includes(String(payload.financial_status).toLowerCase());
    await supabaseAdmin.from('orders').update({ brand_payment_status: paid ? 'paid' : 'pending' }).eq('id', row.order_id).eq('status', 'draft').not('brand_payment_method', 'is', null);
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
  if (!row.payload) throw new ConflictError('There is nothing left to retry for this order.');
  const { data: store } = await supabaseAdmin.from('shopify_stores').select('*').eq('id', row.store_id).maybeSingle();
  const active = store?.status === 'active' ? store : null;
  if (!active) throw new ConflictError('The brand store is not connected.');
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

/** Everything an admin has to look at: failed orders, held addresses, customers who were not emailed. */
export const shopifyQueue = async () => {
  const { data, error } = await supabaseAdmin
    .from('shopify_orders')
    .select('id, store_id, shopify_order_id, shopify_order_name, order_id, customer_email, ref_code, state, address_state, hold_state, notified_at, last_error, created_at, store:shopify_stores!shopify_orders_store_id_fkey(shop_domain), order:orders!shopify_orders_order_id_fkey(id, reference)')
    .order('created_at', { ascending: false })
    .limit(200);
  if (error) throw error;
  const attention = (r) => r.state === 'failed' || (r.address_state === 'address_mismatch' && r.hold_state === 'held') || r.hold_state === 'failed' || (r.state === 'draft_created' && !r.notified_at);
  return (data || []).map((r) => ({ ...r, store: Array.isArray(r.store) ? r.store[0] : r.store, order: Array.isArray(r.order) ? r.order[0] : r.order, needs_attention: attention(r) }));
};

export { getActiveStore };
