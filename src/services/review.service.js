import crypto from 'node:crypto';
import { supabaseAdmin } from '../config/supabase.js';
import { config } from '../config/env.js';
import { AppError, BadRequestError, ConflictError, ForbiddenError, NotFoundError } from '../utils/error.helper.js';
import { onOrderStatusChange } from './order.service.js';
import { sendTransactionalEmail } from './transactional-email.service.js';
import { notifyUser } from './notification.service.js';
import { sanitizeSearch } from '../utils/pagination.js';

/**
 * Customer reviews.
 *
 *   Order Delivered -> (hook below) one review_invitations row, due `delivered_at + N days` (N from Settings, separately for Pakistan
 *   "national" and abroad "international") -> a timer sends the email when it is due -> the customer opens the link, rates the order
 *   1-5 stars with an optional comment -> the review shows in Admin > Customer reviews.
 *
 * Policy (also shown to the admin in Settings):
 *   - The due moment is always counted from the real Delivered time, in UTC (N x 24 h), whatever the customer's or the admin's timezone.
 *   - One invitation and one review per order (database unique keys), so a status written twice cannot send two emails.
 *   - Changing the days in Settings re-dates every invitation that is still waiting. One already sent is never sent again.
 *   - Turning a group off pauses it: its waiting invitations are not sent. Turning it on again sends the ones still due, except those
 *     that have been due for more than STALE_DAYS (an email weeks late is worse than none).
 *   - Nothing is sent for a return order, an order that is no longer delivered, a customer without an email, or an order already reviewed.
 *   - The email is followed by a bell notification and a push (once, only after the email went out).
 *   - A failed send is tried again after 15 min, 1 h and 4 h, then marked failed.
 */

const SETTINGS_KEY = 'review_settings';
export const DEFAULT_REVIEW_SETTINGS = { nationalEnabled: true, nationalReviewDays: 3, internationalEnabled: true, internationalReviewDays: 7 };
export const MAX_REVIEW_DAYS = 365;
export const STALE_DAYS = 14;
const MAX_RETRIES = 3;
const RETRY_DELAYS_MIN = [15, 60, 240];
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_COMMENT = 2000;

const isPakistan = (country) => /^(pk|pakistan)$/i.test(String(country || '').trim());

/** Pakistan = national; any other (or unknown) destination = international, the same rule the admin reports use. */
export const customerTypeOf = (country) => (isPakistan(country) ? 'national' : 'international');

// ─────────────────────────────── settings ───────────────────────────────

const normalize = (v = {}) => {
  const days = (x, d) => (Number.isInteger(x) && x >= 0 && x <= MAX_REVIEW_DAYS ? x : d);
  return {
    nationalEnabled: v.nationalEnabled !== false,
    nationalReviewDays: days(v.nationalReviewDays, DEFAULT_REVIEW_SETTINGS.nationalReviewDays),
    internationalEnabled: v.internationalEnabled !== false,
    internationalReviewDays: days(v.internationalReviewDays, DEFAULT_REVIEW_SETTINGS.internationalReviewDays),
  };
};

export const loadReviewSettings = async () => {
  const { data, error } = await supabaseAdmin.from('platform_settings').select('value').eq('key', SETTINGS_KEY).maybeSingle();
  if (error) return { ...DEFAULT_REVIEW_SETTINGS };
  return normalize(data?.value || {});
};

const settingFor = (settings, type) => ({
  enabled: type === 'national' ? settings.nationalEnabled : settings.internationalEnabled,
  days: type === 'national' ? settings.nationalReviewDays : settings.internationalReviewDays,
});

export const dueDateFor = (deliveredAt, days) => new Date(new Date(deliveredAt).getTime() + days * DAY_MS).toISOString();

export const saveReviewSettings = async (input, userId) => {
  const body = input || {};
  for (const key of ['nationalReviewDays', 'internationalReviewDays']) {
    const n = body[key];
    if (!Number.isInteger(n) || n < 0 || n > MAX_REVIEW_DAYS) throw new BadRequestError(`${key === 'nationalReviewDays' ? 'National' : 'International'} review days must be a whole number from 0 to ${MAX_REVIEW_DAYS}.`);
  }
  for (const key of ['nationalEnabled', 'internationalEnabled']) {
    if (typeof body[key] !== 'boolean') throw new BadRequestError(`${key} must be true or false.`);
  }
  const value = normalize(body);
  const { error } = await supabaseAdmin.from('platform_settings').upsert({ key: SETTINGS_KEY, value, updated_by: userId, updated_at: new Date().toISOString() });
  if (error) throw new AppError(`Could not save the review settings: ${error.message}`, 500);
  const redated = await redatePending(value);
  console.info(`[Review] settings saved by ${userId}: ${JSON.stringify(value)}; ${redated} waiting invitation(s) re-dated`);
  return { settings: value, redated };
};

/** New days apply to every invitation still waiting. */
const redatePending = async (settings) => {
  let n = 0;
  for (const type of ['national', 'international']) {
    const { days } = settingFor(settings, type);
    const { data } = await supabaseAdmin.from('review_invitations').select('id, delivered_at, scheduled_at').eq('status', 'pending').eq('customer_type', type);
    for (const row of data || []) {
      const scheduled_at = dueDateFor(row.delivered_at, days);
      if (scheduled_at === new Date(row.scheduled_at).toISOString()) continue;
      const { error } = await supabaseAdmin.from('review_invitations').update({ scheduled_at, next_attempt_at: null, updated_at: new Date().toISOString() }).eq('id', row.id).eq('status', 'pending');
      if (!error) n += 1;
    }
  }
  return n;
};

// ─────────────────────────────── the review link ───────────────────────────────

const linkSecret = () => process.env.REVIEW_LINK_SECRET || config.supabase.secretKey || 'dev-review-secret';
const sign = (id) => crypto.createHmac('sha256', linkSecret()).update(`review:${id}`).digest('base64url').slice(0, 32);

/** `<invitation id>.<signature>`: it names exactly one invitation, cannot be guessed or forged, and carries no personal data. */
export const signReviewToken = (invitationId) => `${invitationId}.${sign(invitationId)}`;

export const readReviewToken = (token) => {
  const [id, sig] = String(token || '').split('.');
  if (!id || !sig || !/^[0-9a-f-]{36}$/i.test(id)) return null;
  const expected = Buffer.from(sign(id));
  const given = Buffer.from(sig);
  return given.length === expected.length && crypto.timingSafeEqual(given, expected) ? id : null;
};

export const reviewUrl = (token) => `${config.urls.clientApp}/review/${encodeURIComponent(token)}`;

// ─────────────────────────────── scheduling (the Delivered hook) ───────────────────────────────

const loadCustomer = async (customerId) =>
  (await supabaseAdmin.from('profiles').select('id, full_name, email, country').eq('id', customerId).maybeSingle()).data || null;

/**
 * Called when an order becomes Delivered. Creates the single invitation of the order (a repeated call changes nothing).
 * @returns {Promise<object|null>} the invitation, or null when the order is not eligible
 */
export const scheduleReviewInvitation = async (order) => {
  if (!order || order.status !== 'delivered' || order.order_kind === 'return' || !order.customer_id) return null;
  const { data: existing } = await supabaseAdmin.from('review_invitations').select('*').eq('order_id', order.id).maybeSingle();
  if (existing) return existing;
  const { data: reviewed } = await supabaseAdmin.from('order_reviews').select('id').eq('order_id', order.id).maybeSingle();
  if (reviewed) return null;
  const customer = await loadCustomer(order.customer_id);
  if (!customer?.email) return null;
  const type = customerTypeOf(order.destination_country || customer.country);
  const { days } = settingFor(await loadReviewSettings(), type);
  const delivered_at = new Date(order.delivered_at || Date.now()).toISOString();
  const { data, error } = await supabaseAdmin
    .from('review_invitations')
    .insert({ order_id: order.id, customer_id: order.customer_id, customer_type: type, delivered_at, scheduled_at: dueDateFor(delivered_at, days), status: 'pending', retry_count: 0 })
    .select('*')
    .maybeSingle();
  if (error) {
    if (error.code === '23505') return (await supabaseAdmin.from('review_invitations').select('*').eq('order_id', order.id).maybeSingle()).data;
    console.warn('[Review] could not schedule the invitation of', order.reference, error.message);
    return null;
  }
  console.info(`[Review] ${order.reference}: ${type} order delivered ${delivered_at}, invitation due ${data?.scheduled_at}`);
  return data;
};

onOrderStatusChange(async (order, status) => {
  if (status === 'delivered') await scheduleReviewInvitation(order);
});

// ─────────────────────────────── the email ───────────────────────────────

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export const REVIEW_SUBJECT = "We'd Love to Hear About Your Stitching Experience!";

/** Responsive, table-based HTML (works in Gmail, Outlook and phone mail apps) plus a plain-text twin. */
export const renderReviewEmail = ({ name, reference, url }) => {
  const first = String(name || '').trim().split(/\s+/)[0] || 'there';
  const logo = `${config.urls.clientApp}/assets/logo.png`;
  const text = [
    `Hi ${first},`,
    '',
    `Thank you for choosing Stitch&Ship. Your order ${reference} has been delivered, and we would love to know how it went.`,
    'Your feedback helps us improve our stitching and our service for every customer.',
    '',
    `Write a review: ${url}`,
    '',
    'Stitch&Ship',
  ].join('\n');
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(REVIEW_SUBJECT)}</title></head>
<body style="margin:0;padding:0;background:#f4f0ea">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f0ea"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:16px;overflow:hidden;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#222">
<tr><td align="center" style="background:#62003e;padding:26px 20px"><img src="${esc(logo)}" width="64" height="64" alt="Stitch&amp;Ship" style="display:block;border-radius:16px;background:#fff;padding:6px"><div style="color:#fff;font-size:18px;font-weight:700;margin-top:10px;letter-spacing:.3px">Stitch&amp;Ship</div></td></tr>
<tr><td style="padding:28px 26px 8px">
<h1 style="margin:0 0 12px;font-size:22px;line-height:1.3;color:#111">Hi ${esc(first)}, how did we do?</h1>
<p style="margin:0 0 12px;font-size:15px;line-height:1.6">Thank you for choosing Stitch&amp;Ship. Your order <strong>${esc(reference)}</strong> has been delivered, and we would love to hear about your stitching experience.</p>
<p style="margin:0 0 20px;font-size:15px;line-height:1.6;color:#555">Your feedback helps us improve our work and our service for every customer. It takes less than a minute.</p>
<table role="presentation" cellpadding="0" cellspacing="0" align="center" style="margin:6px auto 8px"><tr><td align="center" style="background:#62003e;border-radius:12px"><a href="${esc(url)}" style="display:inline-block;padding:14px 30px;color:#ffffff;text-decoration:none;font-size:16px;font-weight:700">&#9733; Write a Review</a></td></tr></table>
<p style="margin:14px 0 0;font-size:12px;line-height:1.5;color:#888;text-align:center">Button not working? Copy this link into your browser:<br><a href="${esc(url)}" style="color:#62003e;word-break:break-all">${esc(url)}</a></p>
</td></tr>
<tr><td style="padding:22px 26px 26px"><p style="margin:0;font-size:12px;color:#999;border-top:1px solid #eee;padding-top:14px">You are receiving this because you placed order ${esc(reference)} with Stitch&amp;Ship. The link is personal to you; please do not forward it.</p></td></tr>
</table></td></tr></table></body></html>`;
  return { subject: REVIEW_SUBJECT, text, html };
};

// ─────────────────────────────── sending (the timer) ───────────────────────────────

const touch = (id, patch) => supabaseAdmin.from('review_invitations').update({ ...patch, updated_at: new Date().toISOString() }).eq('id', id);
const cancel = (id, reason) => touch(id, { status: 'cancelled', cancel_reason: reason, locked_until: null });

/** Take the row for this worker only (a lock that expired after a crash can be taken again). */
const claim = async (inv, now) => {
  const lockedUntil = new Date(now.getTime() + 5 * 60 * 1000).toISOString();
  const { data } = await supabaseAdmin
    .from('review_invitations')
    .update({ locked_until: lockedUntil, updated_at: now.toISOString() })
    .eq('id', inv.id)
    .eq('status', 'pending')
    .or(`locked_until.is.null,locked_until.lt.${now.toISOString()}`)
    .select('*');
  return data?.[0] || null;
};

/** Send one invitation if it is still right to send it. @returns {'sent'|'cancelled'|'retry'|'failed'|'paused'|'skipped'} */
export const sendInvitation = async (inv, { now = new Date(), settings } = {}) => {
  const s = settings || (await loadReviewSettings());
  if (!settingFor(s, inv.customer_type).enabled) return 'paused';
  if (now.getTime() - new Date(inv.scheduled_at).getTime() > STALE_DAYS * DAY_MS) {
    await cancel(inv.id, 'expired');
    return 'cancelled';
  }
  const claimed = await claim(inv, now);
  if (!claimed) return 'skipped';

  const { data: order } = await supabaseAdmin.from('orders').select('id, reference, status, order_kind, customer_id').eq('id', inv.order_id).maybeSingle();
  if (!order || order.status !== 'delivered' || order.order_kind === 'return') {
    await cancel(inv.id, 'order_not_eligible');
    return 'cancelled';
  }
  const { data: reviewed } = await supabaseAdmin.from('order_reviews').select('id').eq('order_id', inv.order_id).maybeSingle();
  if (reviewed) {
    await cancel(inv.id, 'already_reviewed');
    return 'cancelled';
  }
  const customer = await loadCustomer(order.customer_id);
  if (!customer?.email) {
    await cancel(inv.id, 'no_email');
    return 'cancelled';
  }

  const mail = renderReviewEmail({ name: customer.full_name, reference: order.reference, url: reviewUrl(signReviewToken(inv.id)) });
  const result = await sendTransactionalEmail({ to: customer.email, ...mail });
  if (result.sent) {
    await touch(inv.id, { status: 'sent', sent_at: now.toISOString(), locked_until: null, last_error: null });
    console.info(`[Review] invitation for ${order.reference} sent to ${customer.email}`);
    // the same invitation as an in-app notification (the bell) and a push to the customer's phones; it opens the review page of the order
    try {
      await notifyUser(order.customer_id, {
        type: 'review',
        title: 'How was your order?',
        body: `Order ${order.reference} has been delivered. Tap to rate your stitching experience.`,
        link: `/app/orders/${order.id}/review`,
        orderId: order.id,
      });
    } catch (err) {
      console.warn('[Review] notification not created:', err.message);
    }
    return 'sent';
  }
  if (result.reason === 'not_configured') {
    // not a failure of this email: nothing can be sent until the email settings exist, so wait and look again later
    await touch(inv.id, { locked_until: null, next_attempt_at: new Date(now.getTime() + 60 * 60 * 1000).toISOString(), last_error: 'Email is not configured on the server.' });
    return 'retry';
  }
  const retry_count = (inv.retry_count || 0) + 1;
  const last_error = String(result.detail || result.reason || 'send failed').slice(0, 500);
  if (retry_count > MAX_RETRIES) {
    await touch(inv.id, { status: 'failed', retry_count, last_error, locked_until: null });
    console.warn(`[Review] invitation for ${order.reference} failed for good: ${last_error}`);
    return 'failed';
  }
  const next = new Date(now.getTime() + RETRY_DELAYS_MIN[retry_count - 1] * 60 * 1000).toISOString();
  await touch(inv.id, { retry_count, last_error, next_attempt_at: next, locked_until: null });
  console.warn(`[Review] invitation for ${order.reference} not sent (try ${retry_count}), next at ${next}: ${last_error}`);
  return 'retry';
};

/** Send every invitation that is due. Safe to call at any time and from several servers. */
export const processDueInvitations = async (now = new Date()) => {
  const settings = await loadReviewSettings();
  const { data, error } = await supabaseAdmin
    .from('review_invitations')
    .select('*')
    .eq('status', 'pending')
    .lte('scheduled_at', now.toISOString())
    .order('scheduled_at', { ascending: true })
    .limit(50);
  if (error) {
    console.warn('[Review] could not look for due invitations:', error.message);
    return { sent: 0 };
  }
  let sent = 0;
  for (const inv of data || []) {
    if (inv.next_attempt_at && new Date(inv.next_attempt_at) > now) continue;
    try {
      if ((await sendInvitation(inv, { now, settings })) === 'sent') sent += 1;
    } catch (err) {
      console.warn('[Review] invitation', inv.id, 'crashed:', err.message);
    }
  }
  return { sent };
};

let timer = null;
/** Look for due invitations every few minutes. Started once by the server. */
export const startReviewScheduler = (everyMs = 5 * 60 * 1000) => {
  if (timer) return;
  timer = setInterval(() => processDueInvitations().catch((err) => console.warn('[Review] scheduler:', err.message)), everyMs);
  timer.unref?.();
  setTimeout(() => processDueInvitations().catch(() => undefined), 20_000).unref?.();
};

// ─────────────────────────────── submitting a review ───────────────────────────────

export const cleanRating = (value) => {
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  if (!Number.isInteger(n) || n < 1 || n > 5) throw new BadRequestError('Choose a rating from 1 to 5 stars.');
  return n;
};

export const cleanComment = (value) => {
  if (value == null) return null;
  if (typeof value !== 'string') throw new BadRequestError('The comment must be text.');
  const text = value.trim();
  if (text.length > MAX_COMMENT) throw new BadRequestError(`The comment can be at most ${MAX_COMMENT} characters.`);
  return text || null;
};

const reviewView = (r) => (r ? { id: r.id, rating: r.rating, comment: r.comment, created_at: r.created_at } : null);

const orderSummary = (order) => ({ id: order.id, reference: order.reference, brand: order.brand || null, delivered_at: order.delivered_at || null });

/**
 * Save the review of a delivered order. The caller has already proved who the customer is (a signed link, or their login);
 * `customerId` must be the order's own customer.
 */
export const submitReview = async ({ orderId, customerId, rating, comment, source }) => {
  const stars = cleanRating(rating);
  const text = cleanComment(comment);
  const { data: order } = await supabaseAdmin.from('orders').select('id, reference, brand, status, order_kind, customer_id, destination_country, delivered_at').eq('id', orderId).maybeSingle();
  if (!order || order.customer_id !== customerId) throw new NotFoundError('Order not found.');
  if (order.status !== 'delivered' || order.order_kind === 'return') throw new ForbiddenError('You can review an order after it has been delivered.');
  const customer = await loadCustomer(customerId);
  const row = {
    order_id: order.id,
    customer_id: customerId,
    rating: stars,
    comment: text,
    customer_type: customerTypeOf(order.destination_country || customer?.country),
    delivered_at: order.delivered_at || null,
    source: source === 'app' ? 'app' : 'email',
  };
  const { data, error } = await supabaseAdmin.from('order_reviews').insert(row).select('*').maybeSingle();
  if (error) {
    if (error.code === '23505') throw new ConflictError('You have already reviewed this order.');
    throw new AppError(`Could not save the review: ${error.message}`, 500);
  }
  // the invitation, if it has not gone out yet, is no longer needed
  await supabaseAdmin.from('review_invitations').update({ status: 'cancelled', cancel_reason: 'already_reviewed', locked_until: null, updated_at: new Date().toISOString() }).eq('order_id', order.id).eq('status', 'pending');
  console.info(`[Review] ${order.reference}: ${stars} star(s) by ${customerId} (${row.source})`);
  return { order: orderSummary(order), review: reviewView(data) };
};

/** What the review page shows: the order and the existing review, if any. */
export const reviewStateForOrder = async (orderId, customerId) => {
  const { data: order } = await supabaseAdmin.from('orders').select('id, reference, brand, status, order_kind, customer_id, delivered_at').eq('id', orderId).maybeSingle();
  if (!order || order.customer_id !== customerId) throw new NotFoundError('Order not found.');
  const { data: review } = await supabaseAdmin.from('order_reviews').select('*').eq('order_id', orderId).maybeSingle();
  const customer = await loadCustomer(customerId);
  return {
    order: orderSummary(order),
    customer_name: String(customer?.full_name || '').trim().split(/\s+/)[0] || null,
    reviewable: order.status === 'delivered' && order.order_kind !== 'return',
    review: reviewView(review),
  };
};

const invitationOf = async (token) => {
  const id = readReviewToken(token);
  if (!id) throw new NotFoundError('This review link is not valid.');
  const { data } = await supabaseAdmin.from('review_invitations').select('id, order_id, customer_id').eq('id', id).maybeSingle();
  if (!data) throw new NotFoundError('This review link is not valid.');
  return data;
};

export const reviewStateByToken = async (token) => {
  const inv = await invitationOf(token);
  return reviewStateForOrder(inv.order_id, inv.customer_id);
};

export const submitReviewByToken = async (token, { rating, comment }) => {
  const inv = await invitationOf(token);
  return submitReview({ orderId: inv.order_id, customerId: inv.customer_id, rating, comment, source: 'email' });
};

// ─────────────────────────────── admin: reading the reviews ───────────────────────────────

const iso = (v, endOfDay = false) => {
  if (!v) return null;
  const s = String(v);
  const d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(s) ? `${s}T${endOfDay ? '23:59:59.999' : '00:00:00.000'}Z` : s);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};

const applyFilters = (q, f) => {
  if (f.type === 'national' || f.type === 'international') q = q.eq('customer_type', f.type);
  if (f.rating >= 1 && f.rating <= 5) q = q.eq('rating', f.rating);
  const from = iso(f.from);
  const to = iso(f.to, true);
  if (from) q = q.gte('created_at', from);
  if (to) q = q.lte('created_at', to);
  if (f.ids) q = q.or(f.ids);
  return q;
};

/** `search` matches the customer's name or email and the order number: turned into id lists first, then one filter. */
const searchFilter = async (search) => {
  const s = sanitizeSearch(search);
  if (!s) return { ids: null, none: false };
  const [people, orders] = await Promise.all([
    supabaseAdmin.from('profiles').select('id').or(`full_name.ilike.%${s}%,email.ilike.%${s}%`).limit(300),
    supabaseAdmin.from('orders').select('id').ilike('reference', `%${s}%`).limit(300),
  ]);
  const customerIds = (people.data || []).map((r) => r.id);
  const orderIds = (orders.data || []).map((r) => r.id);
  if (!customerIds.length && !orderIds.length) return { ids: null, none: true };
  const parts = [];
  if (customerIds.length) parts.push(`customer_id.in.(${customerIds.join(',')})`);
  if (orderIds.length) parts.push(`order_id.in.(${orderIds.join(',')})`);
  return { ids: parts.join(','), none: false };
};

const withDetails = async (rows) => {
  if (!rows.length) return [];
  const [orders, people] = await Promise.all([
    supabaseAdmin.from('orders').select('id, reference, brand, status, destination_country, destination_city, delivered_at, created_at').in('id', [...new Set(rows.map((r) => r.order_id))]),
    supabaseAdmin.from('profiles').select('id, full_name, email, customer_code').in('id', [...new Set(rows.map((r) => r.customer_id))]),
  ]);
  const o = new Map((orders.data || []).map((x) => [x.id, x]));
  const p = new Map((people.data || []).map((x) => [x.id, x]));
  return rows.map((r) => ({
    ...r,
    order: o.get(r.order_id) || null,
    customer: p.get(r.customer_id) || null,
    delivered_at: r.delivered_at || o.get(r.order_id)?.delivered_at || null,
  }));
};

export const listReviews = async ({ type, rating, search, from, to, dir = 'desc', page = 1, limit = 15 }) => {
  const filters = { type, rating: Number(rating) || 0, from, to };
  const found = await searchFilter(search);
  if (found.none) return { rows: [], total: 0 };
  filters.ids = found.ids;
  const lo = (page - 1) * limit;
  const { data, error, count } = await applyFilters(supabaseAdmin.from('order_reviews').select('*', { count: 'exact' }), filters)
    .order('created_at', { ascending: String(dir).toLowerCase() === 'asc' })
    .range(lo, lo + limit - 1);
  if (error) throw new AppError(`Could not read the reviews: ${error.message}`, 500);
  return { rows: await withDetails(data || []), total: count ?? (data || []).length };
};

export const getReview = async (id) => {
  if (!/^[0-9a-f-]{36}$/i.test(String(id))) throw new NotFoundError('Review not found.');
  const { data } = await supabaseAdmin.from('order_reviews').select('*').eq('id', id).maybeSingle();
  if (!data) throw new NotFoundError('Review not found.');
  return (await withDetails([data]))[0];
};

/** Totals for the dashboard cards, over the reviews that match the type and date filters. */
export const reviewSummary = async ({ type, from, to } = {}) => {
  const { data, error } = await applyFilters(supabaseAdmin.from('order_reviews').select('rating'), { type, from, to }).limit(20000);
  if (error) throw new AppError(`Could not read the reviews: ${error.message}`, 500);
  const distribution = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  let sum = 0;
  for (const r of data || []) {
    distribution[r.rating] += 1;
    sum += r.rating;
  }
  const total = (data || []).length;
  return { total, average: total ? Math.round((sum / total) * 100) / 100 : 0, five_star: distribution[5], one_star: distribution[1], distribution };
};
