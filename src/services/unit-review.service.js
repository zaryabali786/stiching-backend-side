import { supabaseAdmin } from '../config/supabase.js';
import { BadRequestError, ForbiddenError } from '../utils/error.helper.js';
import { unwrap } from '../utils/db.js';
import { uploadDataUrls } from './storage.service.js';
import { notifyAdmins, notifyPartner, notifyUser } from './notification.service.js';
import { logUnitEvent, addEvent, STATUS_LABELS } from './order.service.js';
import { emitTo, rooms } from '../realtime/io.js';
import { hasOpenIssue, orderReviewFlag, articleState, ARTICLE_STATE_LABELS, STAGE_LABELS, sourceOf, needsDetails, resolveReturnTarget, RETURN_LABELS } from './unit-flow.service.js';

/**
 * The customer's decision on each received article, the return / correction loop for a rejected one, and the moment an
 * approved article is released into production. Every function reads the current rows first and only then writes,
 * so a repeated tap or a stale screen cannot apply the same step twice.
 */

const loadUnits = async (orderId) =>
  unwrap(await supabaseAdmin.from('order_units').select('id, unit_title, code, line_no, status, review_status, return_status, resubmit_count').eq('order_id', orderId).order('line_no'));

/** Tell every screen that watches this article (the customer, the admins, the partner's production team). */
export const emitUnitUpdate = (order, unit, extra = {}) => {
  const payload = {
    orderId: order.id,
    reference: order.reference,
    unitId: unit.id,
    code: unit.code ?? null,
    title: unit.unit_title ?? null,
    orderStatus: order.status,
    ...extra,
    at: new Date().toISOString(),
  };
  emitTo(rooms.user(order.customer_id), 'unit:update', payload);
  emitTo(rooms.admins, 'unit:update', payload);
  if (order.partner_id) emitTo(rooms.production(order.partner_id), 'unit:update', payload);
};

/** Notify the staff who handle receiving for this order: the admins, and the partner's people when it has one. */
const notifyStaffAboutReview = async (order, title, body) => {
  const note = { type: 'alert', title, body, link: { admin: `/admin/orders?ref=${order.reference}`, partner_staff: `/partner/receiving?search=${order.reference}` }, orderId: order.id };
  await Promise.all([
    notifyAdmins(note).catch(() => {}),
    order.partner_id ? notifyPartner(note, null, { module: 'receiving' }).catch(() => {}) : null,
  ]);
};

/** The order-level flag + "needs attention" follow the articles. */
export const syncReviewFlag = async (orderId) => {
  const units = await loadUnits(orderId);
  const flag = orderReviewFlag(units);
  const stuck = units.some((u) => u.review_status === 'rejected' || (u.return_status && u.return_status !== 'none' && u.return_status !== 'resubmitted'));
  const { data: order } = await supabaseAdmin.from('orders').select('id, parcel_review, has_issue').eq('id', orderId).maybeSingle();
  if (!order) return flag;
  const patch = {};
  if (flag !== 'none' && order.parcel_review !== flag) {
    patch.parcel_review = flag;
    if (flag === 'approved') patch.parcel_review_at = new Date().toISOString();
  }
  // a rejected / returned article is something the team must act on
  if (stuck && !order.has_issue) patch.has_issue = true;
  if (Object.keys(patch).length) await supabaseAdmin.from('orders').update({ ...patch, updated_at: new Date().toISOString() }).eq('id', orderId);
  return flag;
};

/**
 * The parcel of a draft arrived and every article was received: each one now waits for the customer's decision.
 * @returns {Promise<number>} how many articles are waiting
 */
export const startReview = async (orderId, actorId = null) => {
  const units = await loadUnits(orderId);
  const waiting = units.filter((u) => u.status === 'received' && u.review_status === 'none');
  if (!waiting.length) return 0;
  const { error } = await supabaseAdmin.from('order_units').update({ review_status: 'pending', updated_at: new Date().toISOString() }).in('id', waiting.map((u) => u.id));
  if (error) throw error;
  for (const u of waiting) await logUnitEvent(u.id, orderId, 'review_requested', { actorId });
  await syncReviewFlag(orderId);
  return waiting.length;
};

/**
 * Give every released article of a submitted order its production ticket (job card): received, and approved when the
 * customer had to review it. Drafts and cancelled orders release nothing. Safe to call as often as needed.
 */
export const releaseArticles = async (orderId) => {
  const { data: order } = await supabaseAdmin.from('orders').select('id, reference, status, partner_id, priority, due_date, customer_code, order_source, import_source, details_completed_at').eq('id', orderId).maybeSingle();
  if (!order || ['draft', 'cancelled'].includes(order.status)) return 0;
  // a website / email order enters production once the customer has finished its articles, sizes and notes
  if (needsDetails(order) && !order.details_completed_at) return 0;
  const [units, cards] = await Promise.all([
    unwrap(await supabaseAdmin.from('order_units').select('id, unit_title, status, review_status').eq('order_id', orderId).order('line_no')),
    unwrap(await supabaseAdmin.from('job_cards').select('unit_id').eq('order_id', orderId)),
  ]);
  const have = new Set(cards.map((c) => c.unit_id));
  const ready = units.filter((u) => u.status === 'received' && ['none', 'approved'].includes(u.review_status) && !have.has(u.id));
  if (!ready.length) return 0;

  let q = supabaseAdmin.from('job_cards').select('position').eq('stage', 'to_assign').order('position', { ascending: false }).limit(1);
  q = order.partner_id ? q.eq('partner_id', order.partner_id) : q.is('partner_id', null);
  const last = unwrap(await q);
  let position = (last[0]?.position ?? 0) + 1024;
  let made = 0;
  for (const u of ready) {
    const { error } = await supabaseAdmin.from('job_cards').insert({
      order_id: order.id, unit_id: u.id, stage: 'to_assign', position, priority: order.priority, due_date: order.due_date,
      order_reference: order.reference, customer_code: order.customer_code, unit_title: u.unit_title, partner_id: order.partner_id,
    });
    if (error && error.code !== '23505') throw error; // 23505: the database trigger made it first
    if (!error) made += 1;
    position += 1024;
  }
  return made;
};

const mediaFor = async (orderId, media) => (Array.isArray(media) && media.length ? uploadDataUrls(`review/${orderId}`, media.slice(0, 4)) : []);

/**
 * The customer approves or rejects ONE article.
 * @param {{ order: object, unit: object, decision: 'approve'|'reject', note?: string, media?: object[], profile: object }} input
 */
/** The return shipping details the customer typed: only known fields, trimmed, or null when nothing useful was given. */
export const cleanReturnShipping = (input) => {
  if (!input || typeof input !== 'object') return null;
  const clip = (v, n) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
  const out = { name: clip(input.name, 120), phone: clip(input.phone, 40), address: clip(input.address, 300), city: clip(input.city, 80), country: clip(input.country, 80) };
  return out.address || out.phone ? out : null;
};

export const decideArticle = async ({ order, unit, decision, note, media, returnTo, action, shipping, profile }) => {
  const issue = hasOpenIssue(unit);
  // the customer decides after the whole parcel was received and checked, except for an article with a reported problem
  if (!issue && !order.parcel_received_at && ['draft', 'submitted'].includes(order.status)) throw new BadRequestError('We are still receiving your parcel. You can review it as soon as it is checked.');
  if (unit.review_status !== 'pending') throw new BadRequestError(unit.review_status === 'approved' ? 'You already approved this article.' : 'This article is not waiting for your decision.');
  const now = new Date().toISOString();

  if (decision === 'approve') {
    // a reported problem cannot be waved through: the customer holds it or returns it
    if (issue) throw new BadRequestError('Our team found a problem with this article. Choose Hold or Return.');
    const { data, error } = await supabaseAdmin.from('order_units')
      .update({
        review_status: 'approved', reviewed_at: now, reviewed_by: profile.id, review_note: null, review_media: [], updated_at: now,
        // approving a corrected hold article resolves the hold (the partner already confirmed receiving it)
        ...(unit.return_status === 'held' && unit.hold_received_at ? { return_status: 'none', hold_resolved_at: now } : {}),
      })
      .eq('id', unit.id).eq('review_status', 'pending').select('id').maybeSingle();
    if (error) throw error;
    if (!data) throw new BadRequestError('This article was already decided.');
    const resolvesHold = unit.return_status === 'held' && !!unit.hold_received_at;
    if (resolvesHold) await logUnitEvent(unit.id, order.id, 'hold_resolved', { actorId: profile.id });
    await logUnitEvent(unit.id, order.id, 'review_approved', { actorId: profile.id });
    await addEvent(order.id, order.status, `${unit.unit_title} approved by the customer`, profile.id);
    await syncReviewFlag(order.id);
    const released = await releaseArticles(order.id);
    // approved articles that just got their production ticket: tell the order's own partner (only the people who see Production).
    // An order that still waits for the customer's details is not released yet, so nobody is told too early.
    // dedupe: "Approve all" releases article after article, the partner needs one alert for the order, not one per article
    if (released > 0 && order.partner_id) {
      await notifyPartner({
        type: 'order',
        title: `Approved by the customer: ${order.reference}`,
        body: `${unit.unit_title}${released > 1 ? ` and ${released - 1} more` : ''} approved · ready for production.`,
        link: `/partner/production?search=${order.reference}`,
        orderId: order.id,
        dedupe: true,
      }, null, { module: 'production' }).catch(() => {});
    }
    if (resolvesHold) await notifyStaffAboutReview(order, `Hold resolved: ${order.reference}`, `${unit.unit_title} was approved by the customer · ${order.reference}-RESOLVED`);
    emitUnitUpdate(order, unit, { state: 'approved', stateLabel: ARTICLE_STATE_LABELS.approved, ...(resolvesHold ? { group: 'resolved' } : {}) });
    return { state: 'approved', resolved: resolvesHold };
  }

  if (decision !== 'reject') throw new BadRequestError("Decision must be 'approve' or 'reject'.");
  const reason = String(note || '').trim();
  if (reason.length < 3) throw new BadRequestError('Tell us why you are rejecting it, so we can fix it.');
  if (action === 'hold') {
    // on hold: only a text, no photos and no return yet
    const { data: held, error: holdErr } = await supabaseAdmin.from('order_units')
      .update({
        review_status: 'rejected', review_note: reason.slice(0, 1000), review_media: [], reviewed_at: now, reviewed_by: profile.id,
        return_status: 'held', return_to: null, return_note: reason.slice(0, 500), return_updated_at: now, updated_at: now,
        held_at: now, hold_received_at: null, hold_received_by: null, hold_resolved_at: null,
      })
      .eq('id', unit.id).eq('review_status', 'pending').select('id').maybeSingle();
    if (holdErr) throw holdErr;
    if (!held) throw new BadRequestError('This article was already decided.');
    await logUnitEvent(unit.id, order.id, 'review_held', { note: reason, actorId: profile.id });
    await addEvent(order.id, order.status, `${unit.unit_title} put on hold by the customer: ${reason}`, profile.id);
    await syncReviewFlag(order.id);
    await notifyStaffAboutReview(order, `Article on hold: ${order.reference}`, `${unit.unit_title} · ${reason} · keep it until the customer decides`);
    emitUnitUpdate(order, unit, { state: 'on_hold', stateLabel: ARTICLE_STATE_LABELS.on_hold });
    return { state: 'held' };
  }
  const where = resolveReturnTarget(sourceOf(order), returnTo);
  if (!where.ok) throw new BadRequestError(where.message);
  const evidence = await mediaFor(order.id, media);
  const returnShipping = cleanReturnShipping(shipping);
  // a rejection also asks for the parcel to go back, to the place the customer chose (a customer's own parcel: to them)
  const { data, error } = await supabaseAdmin.from('order_units')
    .update({
      review_status: 'rejected', review_note: reason.slice(0, 1000), review_media: evidence, reviewed_at: now, reviewed_by: profile.id,
      return_status: 'requested', return_to: where.target, return_note: reason.slice(0, 500), return_updated_at: now, updated_at: now,
      ...(where.target === 'customer' && returnShipping ? { return_shipping: returnShipping } : {}),
    })
    .eq('id', unit.id).eq('review_status', 'pending').select('id').maybeSingle();
  if (error) throw error;
  if (!data) throw new BadRequestError('This article was already decided.');
  await logUnitEvent(unit.id, order.id, 'review_rejected', { note: reason, actorId: profile.id });
  await logUnitEvent(unit.id, order.id, 'return_requested', { note: `To ${RETURN_LABELS[where.target]}`, actorId: profile.id });
  await addEvent(order.id, order.status, `${unit.unit_title} rejected by the customer: ${reason} · return to ${RETURN_LABELS[where.target]}`, profile.id);
  await syncReviewFlag(order.id);
  await notifyStaffAboutReview(order, `Article rejected: ${order.reference}`, `${unit.unit_title} · ${reason} · send it back to ${RETURN_LABELS[where.target]}`);
  emitUnitUpdate(order, unit, { state: 'return_requested', stateLabel: ARTICLE_STATE_LABELS.return_requested, returnTo: where.target });
  return { state: 'rejected', returnTo: where.target };
};

/**
 * Staff: the corrected article of a HOLD arrived. It goes back in front of the customer; the hold is resolved only once
 * the customer approves it. Only an article that is on hold can be received this way (a returned one cannot).
 */
export const receiveCorrectedHold = async ({ order, unit, note, media, profile }) => {
  if (unit.return_status !== 'held') throw new BadRequestError(unit.return_status && unit.return_status !== 'none' ? 'Only an article on hold can be received as a corrected article.' : 'This article is not on hold.');
  if (unit.hold_received_at) throw new BadRequestError('The corrected article was already received. It is waiting for the customer.');
  if (['cancelled'].includes(order.status)) throw new BadRequestError('This order was cancelled.');
  const now = new Date().toISOString();
  const evidence = Array.isArray(media) && media.length ? await uploadDataUrls(`received/${order.id}`, media.slice(0, 8)) : [];
  const { data, error } = await supabaseAdmin.from('order_units')
    .update({
      review_status: 'pending', review_note: null, review_media: [], reviewed_at: null,
      // the corrected article is in our hands: a problem the partner had reported is over, so it can be released once approved
      status: 'received', received_at: now,
      hold_received_at: now, hold_received_by: profile.id, resubmit_count: (unit.resubmit_count || 0) + 1, updated_at: now,
      ...(evidence.length ? { receive_media: [...(unit.receive_media || []), ...evidence] } : {}),
    })
    .eq('id', unit.id).eq('return_status', 'held').is('hold_received_at', null).select('id').maybeSingle();
  if (error) throw error;
  if (!data) throw new BadRequestError('The corrected article was already received.');
  const text = String(note || '').trim().slice(0, 300);
  await logUnitEvent(unit.id, order.id, 'hold_received', { note: text || null, actorId: profile.id });
  await addEvent(order.id, order.status, `Corrected ${unit.unit_title} received${text ? `: ${text}` : ''} · waiting for the customer`, profile.id);
  await syncReviewFlag(order.id);
  await notifyUser(order.customer_id, { type: 'alert', title: `Please review again: ${order.reference}`, body: `The corrected ${unit.unit_title} is back. Check it and approve it to resolve the hold.`, link: `/app/orders/${order.id}`, orderId: order.id }).catch(() => {});
  emitUnitUpdate(order, unit, { state: 'pending_approval', stateLabel: ARTICLE_STATE_LABELS.pending_approval, group: 'hold' });
  return { state: 'pending_approval' };
};

/** Approve every article that is waiting (the "Approve all" button). */
export const approveAllArticles = async ({ order, profile }) => {
  const units = await loadUnits(order.id);
  // articles with a reported problem are not approved in bulk: they are held or returned
  const pending = units.filter((u) => u.review_status === 'pending' && u.status !== 'issue');
  if (!pending.length) throw new BadRequestError('No article is waiting for your approval.');
  for (const u of pending) await decideArticle({ order, unit: { ...u, order_id: order.id }, decision: 'approve', profile });
  return { approved: pending.length };
};

/** Reject every article that is waiting (the "Reject parcel" button): one reason, one return destination for all. */
export const rejectParcel = async ({ order, note, media, returnTo, action, shipping, profile }) => {
  const units = await loadUnits(order.id);
  const pending = units.filter((u) => u.review_status === 'pending');
  if (!pending.length) throw new BadRequestError('No article is waiting for your decision.');
  // check the destination and the reason before touching anything
  if (String(note || '').trim().length < 3) throw new BadRequestError('Tell us why you are rejecting the parcel, so we can fix it.');
  if (action === 'hold') {
    for (const u of pending) await decideArticle({ order, unit: { ...u, order_id: order.id }, decision: 'reject', note, action: 'hold', profile });
    return { rejected: pending.length, returnTo: null, held: true };
  }
  const where = resolveReturnTarget(sourceOf(order), returnTo);
  if (!where.ok) throw new BadRequestError(where.message);
  for (const u of pending) await decideArticle({ order, unit: { ...u, order_id: order.id }, decision: 'reject', note, media, returnTo: where.target, shipping, profile });
  return { rejected: pending.length, returnTo: where.target };
};

/** The customer asks to send a rejected article back (for correction or replacement). */
export const requestReturn = async ({ order, unit, note, profile }) => {
  if (unit.review_status !== 'rejected') throw new BadRequestError('Only a rejected article can be sent back.');
  if (!['none', 'held'].includes(unit.return_status)) throw new BadRequestError('A return was already requested for this article.');
  const now = new Date().toISOString();
  const { data, error } = await supabaseAdmin.from('order_units')
    .update({ return_status: 'requested', return_note: String(note || '').trim().slice(0, 500) || null, return_updated_at: now, updated_at: now })
    .eq('id', unit.id).in('return_status', ['none', 'held']).select('id').maybeSingle();
  if (error) throw error;
  if (!data) throw new BadRequestError('A return was already requested for this article.');
  await logUnitEvent(unit.id, order.id, 'return_requested', { note: note ? String(note).slice(0, 200) : null, actorId: profile.id });
  await addEvent(order.id, order.status, `Return requested for ${unit.unit_title}`, profile.id);
  await notifyStaffAboutReview(order, `Return requested: ${order.reference}`, `${unit.unit_title} must be sent back to the customer.`);
  emitUnitUpdate(order, unit, { state: 'return_requested', stateLabel: ARTICLE_STATE_LABELS.return_requested });
  return { state: 'return_requested' };
};

/**
 * Staff: the article was sent back. It becomes "to receive" again, so when the corrected / replacement article arrives
 * the normal Receive parcel step picks it up and puts it back in front of the customer.
 */
export const markSentBack = async ({ order, unit, courier, tracking, profile }) => {
  if (unit.return_status !== 'requested') throw new BadRequestError('Nobody asked to send this article back.');
  const now = new Date().toISOString();
  const { data, error } = await supabaseAdmin.from('order_units')
    .update({
      return_status: 'sent_back', status: 'pending', received_at: null, return_courier: String(courier || '').trim().slice(0, 80) || null,
      return_tracking: String(tracking || '').trim().slice(0, 80) || null, return_updated_at: now, updated_at: now,
    })
    .eq('id', unit.id).eq('return_status', 'requested').select('id').maybeSingle();
  if (error) throw error;
  if (!data) throw new BadRequestError('This article was already marked as sent back.');
  const tracked = [courier, tracking].map((x) => String(x || '').trim()).filter(Boolean).join(' · ');
  const to = RETURN_LABELS[unit.return_to] || 'the customer';
  await logUnitEvent(unit.id, order.id, 'returned', { note: [`To ${to}`, tracked].filter(Boolean).join(' · '), actorId: profile.id });
  await addEvent(order.id, order.status, `${unit.unit_title} sent back to ${to}${tracked ? ` (${tracked})` : ''}`, profile.id);
  await notifyUser(order.customer_id, { type: 'update', title: `Parcel sent back: ${order.reference}`, body: `${unit.unit_title} was sent back to ${unit.return_to === 'brand' ? 'the brand' : 'you'}${tracked ? ` · ${tracked}` : ''}.`, link: `/app/orders/${order.id}`, orderId: order.id }).catch(() => {});
  emitUnitUpdate(order, unit, { state: 'returned', stateLabel: ARTICLE_STATE_LABELS.returned, returnTo: unit.return_to });
  return { state: 'returned' };
};

/** A sent-back article was received again (corrected or replaced): the customer reviews it again. */
export const resubmitCorrected = async ({ order, unit, actorId }) => {
  const now = new Date().toISOString();
  const { error } = await supabaseAdmin.from('order_units')
    .update({ review_status: 'pending', return_status: 'resubmitted', resubmit_count: (unit.resubmit_count || 0) + 1, review_note: null, review_media: [], updated_at: now })
    .eq('id', unit.id);
  if (error) throw error;
  await logUnitEvent(unit.id, order.id, 'resubmitted', { actorId });
  await addEvent(order.id, order.status, `Corrected ${unit.unit_title} received · waiting for the customer`, actorId);
  await syncReviewFlag(order.id);
  await notifyUser(order.customer_id, { type: 'alert', title: `Please review again: ${order.reference}`, body: `The corrected ${unit.unit_title} is back. Check the photos and approve it.`, link: `/app/orders/${order.id}`, orderId: order.id }).catch(() => {});
  emitUnitUpdate(order, unit, { state: 'pending_approval', stateLabel: ARTICLE_STATE_LABELS.pending_approval });
};

/** What an article looks like to the apps: its one-word state plus the label. */
export const describeArticle = ({ unit, card, order }) => {
  const state = articleState({ unit, card, order });
  return { state, state_label: ARTICLE_STATE_LABELS[state], stage_label: card ? STAGE_LABELS[card.stage] ?? card.stage : null };
};

export { STATUS_LABELS };

/** Guard used by routes that only the order's customer may call. */
export const assertOwnUnit = async (order, unitId) => {
  const { data } = await supabaseAdmin.from('order_units').select('*').eq('id', unitId).eq('order_id', order.id).maybeSingle();
  if (!data) throw new ForbiddenError('That article is not part of this order.');
  return data;
};

/**
 * The partner reported a problem with an article at receiving: the customer now decides (Hold or Return). Safe to call again.
 * The article is not released to production meanwhile (its status is "issue").
 */
export const requestIssueDecision = async ({ order, unit, actorId }) => {
  if (unit.review_status === 'pending') return { already: true };
  const now = new Date().toISOString();
  const { data } = await supabaseAdmin.from('order_units')
    .update({ review_status: 'pending', review_note: null, review_media: [], reviewed_at: null, updated_at: now })
    .eq('id', unit.id).in('review_status', ['none', 'approved']).select('id').maybeSingle();
  if (!data) return { already: true };
  await logUnitEvent(unit.id, order.id, 'review_requested', { note: 'Problem found at receiving', actorId });
  await syncReviewFlag(order.id);
  await notifyUser(order.customer_id, { type: 'alert', title: `Problem with your parcel: ${order.reference}`, body: `We found a problem with ${unit.unit_title}. Open it and choose Hold or Return.`, link: `/app/orders/${order.id}`, orderId: order.id }).catch(() => {});
  emitUnitUpdate(order, unit, { state: 'issue', stateLabel: ARTICLE_STATE_LABELS.issue });
  return { already: false };
};
