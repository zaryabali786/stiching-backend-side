import { supabaseAdmin } from '../config/supabase.js';
import { unwrap } from '../utils/db.js';
import { addEvent } from './order.service.js';
import { notifyUser } from './notification.service.js';

/**
 * Follow-up emails (shipped / dispatched / tracking) belong to an order the customer already has. This reads the order
 * number, finds that order, and saves the courier and tracking number on it, instead of making a second order.
 *
 * Safe to repeat: the same courier + tracking never changes the order twice, and an older email never overwrites the
 * details of a newer one. When the order number is missing, matches several orders, or belongs to another brand,
 * nothing is changed and the email is flagged for a person to look at.
 */

const ORDER_NUMBER_MIN = 3;

/** "#SP-482913", "sp 482913" and "SP482913" are the same order number. It needs a digit, else it is not an order number. */
export const normaliseOrderNumber = (value) => {
  const key = String(value ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
  return key.length >= ORDER_NUMBER_MIN && /\d/.test(key) ? key : '';
};

/** "1Z 999-AA1" and "1z999aa1" are the same tracking number. */
export const normaliseTracking = (value) => String(value ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');

const squash = (v) => String(v ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');

/** Do two brand names clearly disagree? ("Sapphire" vs "Sapphire Online" agree; "Khaadi" vs "Sapphire" do not.) Unknown never conflicts. */
export const brandsConflict = (a, b) => {
  const x = squash(a);
  const y = squash(b);
  if (!x || !y) return false;
  return !(x.includes(y) || y.includes(x));
};

/** The catalogue courier a name from an email stands for ("DHL Express Worldwide" -> "DHL"), or null. */
export const pickCourier = (couriers, rawName) => {
  const key = squash(rawName);
  if (key.length < 2) return null;
  const exact = couriers.find((c) => squash(c.name) === key);
  if (exact) return exact;
  const related = couriers
    .filter((c) => squash(c.name).length >= 3 && (key.includes(squash(c.name)) || squash(c.name).includes(key)))
    .sort((a, b) => squash(b.name).length - squash(a.name).length);
  // two equally good candidates would be a guess
  if (related.length > 1 && squash(related[0].name).length === squash(related[1].name).length) return null;
  return related[0] ?? null;
};

const activeCouriers = async () => unwrap(await supabaseAdmin.from('couriers').select('id, name, requires_tracking').eq('status', 'active'), 'Could not load the couriers');

/** The active courier names, for reading plain email text. */
export const loadCourierNames = async () => (await activeCouriers()).map((c) => c.name);

/** Courier / tracking found in plain email text when the AI reader is not switched on. */
export const readShippingFromText = (text, courierNames = []) => {
  const body = String(text ?? '');
  const trackingRe = /\btrack(?:ing)?\s*(?:number|no\.?|id|code|#|ref(?:erence)?)?\s*(?:is|:|-|#)?\s*[:#-]?\s*([A-Z0-9][A-Z0-9-]{6,29})\b/gi;
  let tracking = null;
  for (const m of body.matchAll(trackingRe)) {
    if (/\d/.test(m[1])) {
      tracking = m[1];
      break;
    }
  }
  const lower = body.toLowerCase();
  const named = courierNames
    .filter((n) => n && new RegExp(`(?:^|[^a-z0-9])${n.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:$|[^a-z0-9])`).test(lower))
    .sort((a, b) => b.length - a.length);
  return { tracking_number: tracking, courier_name: named[0] ?? null };
};

const hasShippingDetails = (x) => !!(String(x?.tracking_number ?? '').trim() || String(x?.courier_name ?? '').trim());

/**
 * Which order a read email is about.
 * @returns {Promise<{ kind: 'none' } | { kind: 'review', note: string } | { kind: 'matched', order: object }>}
 *   none = a first order confirmation (or something unrelated): carry on as before
 */
export const resolveEmailTarget = async (userId, extracted) => {
  const shipping = hasShippingDetails(extracted);
  const hasItems = (extracted?.items?.length ?? 0) > 0;
  const key = normaliseOrderNumber(extracted?.order_number);

  if (!key) {
    return shipping ? { kind: 'review', note: "This email has shipping details but we couldn't find an order number in it, so no order was changed. Add the details to the right order by hand." } : { kind: 'none' };
  }

  const rows = unwrap(
    await supabaseAdmin
      .from('orders')
      .select('id, reference, status, brand, brand_order_number, courier_id, courier_name, tracking_number, shipping_updated_at, brand_payment_method, brand_payment_status')
      .eq('customer_id', userId)
      .not('brand_order_number', 'is', null)
      .neq('status', 'cancelled')
      .limit(1000),
    'Could not look up your orders'
  );
  let hits = rows.filter((o) => normaliseOrderNumber(o.brand_order_number) === key);
  if (hits.length > 1 && extracted.brand) {
    const sameBrand = hits.filter((o) => !brandsConflict(o.brand, extracted.brand));
    if (sameBrand.length) hits = sameBrand;
  }

  if (!hits.length) {
    // a shipping update for an order we do not have must not become a brand-new empty order
    return shipping && !hasItems ? { kind: 'review', note: `We couldn't find an order with number ${extracted.order_number} in your orders, so nothing was changed.` } : { kind: 'none' };
  }
  if (hits.length > 1) {
    return { kind: 'review', note: `Order number ${extracted.order_number} matches ${hits.length} of your orders (${hits.map((o) => o.reference).join(', ')}), so nothing was changed.` };
  }
  const order = hits[0];
  if (brandsConflict(order.brand, extracted.brand)) {
    return { kind: 'review', note: `Order number ${extracted.order_number} belongs to ${order.reference} (${order.brand}), but this email is from ${extracted.brand}. Nothing was changed.` };
  }
  return { kind: 'matched', order };
};

/**
 * Save the courier and tracking number from an email on its order.
 * @returns {Promise<{ changed: boolean, stale?: boolean, summary: string }>}
 */
export const applyShippingUpdate = async (order, extracted, { receivedAt }) => {
  const tracking = String(extracted?.tracking_number ?? '').trim().slice(0, 60);
  const courierText = String(extracted?.courier_name ?? '').trim().slice(0, 80);
  if (!tracking && !courierText) return { changed: false, summary: 'No shipping details in this email.' };

  const sentAt = new Date(receivedAt);
  const sent = Number.isNaN(sentAt.getTime()) ? new Date() : sentAt;

  // a newer email already set the shipping details: this older one must not roll them back
  if (order.shipping_updated_at && new Date(order.shipping_updated_at) > sent) {
    return { changed: false, stale: true, summary: 'A newer email already updated the shipping details.' };
  }

  const patch = {};
  if (tracking && normaliseTracking(tracking) !== normaliseTracking(order.tracking_number)) patch.tracking_number = tracking;

  let courierLabel = null;
  if (courierText) {
    const courier = pickCourier(await activeCouriers(), courierText);
    if (courier) {
      courierLabel = courier.name;
      if (courier.id !== order.courier_id) Object.assign(patch, { courier_id: courier.id, courier_name: null });
    } else {
      courierLabel = courierText;
      if (squash(courierText) !== squash(order.courier_name) || order.courier_id) Object.assign(patch, { courier_id: null, courier_name: courierText });
    }
  }
  if (!Object.keys(patch).length) return { changed: false, summary: 'The shipping details were already up to date.' };

  let query = supabaseAdmin
    .from('orders')
    .update({ ...patch, shipping_updated_at: sent.toISOString(), updated_at: new Date().toISOString() })
    .eq('id', order.id);
  // two emails racing: only one write wins, the other re-reads and sees the result
  query = order.shipping_updated_at ? query.eq('shipping_updated_at', order.shipping_updated_at) : query.is('shipping_updated_at', null);
  const { data: updated, error } = await query.select('id, status').maybeSingle();
  if (error) throw error;
  if (!updated) {
    const fresh = unwrap(await supabaseAdmin.from('orders').select('id, reference, status, brand, brand_order_number, courier_id, courier_name, tracking_number, shipping_updated_at, brand_payment_method, brand_payment_status').eq('id', order.id).maybeSingle());
    return fresh ? applyShippingUpdate(fresh, extracted, { receivedAt }) : { changed: false, summary: 'The order is no longer available.' };
  }

  const summary = [courierLabel, tracking || order.tracking_number].filter(Boolean).join(' · ') || 'shipping details';
  await addEvent(order.id, updated.status, `Shipping details updated from an email: ${summary}`, null);
  return { changed: true, summary };
};

/** "Cash on delivery" in any wording. */
export const isCod = (method) => /\b(cod|cash\s*(on|upon)\s*delivery)\b/i.test(String(method || ''));

/**
 * Save how the brand order was paid, as the email states it. A method already saved is kept (the first confirmation wins);
 * a "paid" status is never taken back by a later "pending", and nothing is saved when the email does not say.
 */
export const applyPaymentUpdate = async (order, extracted) => {
  const method = String(extracted?.payment_method ?? '').trim().slice(0, 80);
  const status = ['paid', 'pending'].includes(extracted?.payment_status) ? extracted.payment_status : null;
  const patch = {};
  if (method && !order.brand_payment_method) patch.brand_payment_method = method;
  if (status && order.brand_payment_status !== status && !(order.brand_payment_status === 'paid' && status === 'pending')) patch.brand_payment_status = status;
  if (!Object.keys(patch).length) return { changed: false };
  unwrap(await supabaseAdmin.from('orders').update({ ...patch, updated_at: new Date().toISOString() }).eq('id', order.id));
  await addEvent(order.id, order.status, `Payment details read from an email: ${[patch.brand_payment_method, patch.brand_payment_status].filter(Boolean).join(' · ')}`, null);
  return { changed: true, patch };
};

/** Remember on the inbox email what happened to it. */
const markEmail = async (inboxId, patch) => {
  if (!inboxId) return;
  const { error } = await supabaseAdmin.from('inbox_emails').update(patch).eq('id', inboxId);
  if (error) console.warn('[Mail] could not save the order match:', error.message);
};

/**
 * Link a read email to the order it is about and save its shipping details, or flag it for review.
 * @returns {Promise<{ handled: boolean, kind: 'none'|'matched'|'review', order?: object, changed?: boolean }>}
 *   handled=false: the caller carries on (a first order confirmation)
 */
export const matchEmailToOrder = async ({ userId, inboxId, extracted, receivedAt, target }) => {
  const found = target ?? (await resolveEmailTarget(userId, extracted));
  if (found.kind === 'none') return { handled: false, kind: 'none' };

  if (found.kind === 'review') {
    await markEmail(inboxId, { match_status: 'review', match_note: found.note });
    await notifyUser(userId, { type: 'alert', title: 'Please check an email about your order', body: found.note, link: inboxId ? `/app/inbox/${inboxId}` : '/app/inbox' });
    return { handled: true, kind: 'review' };
  }

  const result = await applyShippingUpdate(found.order, extracted, { receivedAt });
  await applyPaymentUpdate(found.order, extracted).catch((e) => console.warn('[Mail] payment details not saved:', e.message));
  await markEmail(inboxId, { order_id: found.order.id, match_status: 'matched', match_note: result.changed ? `Updated ${found.order.reference}: ${result.summary}` : `${found.order.reference}: ${result.summary}` });
  if (result.changed) {
    await notifyUser(userId, {
      type: 'update',
      title: `Tracking added to ${found.order.reference}`,
      body: `${result.summary}. We found it in your email${extracted.order_number ? ` for order ${extracted.order_number}` : ''}.`,
      link: `/app/orders/${found.order.id}`,
      orderId: found.order.id,
    });
  }
  return { handled: true, kind: 'matched', order: found.order, changed: result.changed };
};
