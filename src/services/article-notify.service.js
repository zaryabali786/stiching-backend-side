import { supabaseAdmin } from '../config/supabase.js';
import { notifyAdmins, notifyUsers, partnerRecipients } from './notification.service.js';

/** profiles.staff_type of the people who work on the floor (everyone else of a partner is management / office). */
const FLOOR_STAFF = new Set(['master', 'tailor', 'qa', 'pressing', 'packing']);

/**
 * Who is responsible for ONE article, worked out from what really happened to it, not from where it sits now:
 *   - the partner(s) that did the given stages (unit_stage_receipts keeps partner + person of every scan), even when the
 *     article has moved on to another department since; without receipts (older orders, a board drag) the ticket's partner,
 *     then the order's partner
 *   - the people who did those stages, and the master / tailor the ticket is assigned to right now
 * @param {{ orderId: string, unitId: string, stages?: string[] }} input
 * @returns {Promise<{ partnerIds: string[], userIds: string[] }>}
 */
export const articleActors = async ({ orderId, unitId, stages = [] }) => {
  const [receiptsRes, cardRes, orderRes] = await Promise.all([
    supabaseAdmin.from('unit_stage_receipts').select('partner_id, user_id, stage').eq('unit_id', unitId),
    supabaseAdmin.from('job_cards').select('partner_id, master_id, tailor_id').eq('unit_id', unitId).maybeSingle(),
    supabaseAdmin.from('orders').select('partner_id').eq('id', orderId).maybeSingle(),
  ]);
  const card = cardRes.data;
  const wanted = (r) => !stages.length || stages.includes(r.stage);
  const receipts = (receiptsRes.data || []).filter(wanted);

  const partnerIds = new Set(receipts.map((r) => r.partner_id).filter(Boolean));
  if (!partnerIds.size) {
    const fallback = card?.partner_id || orderRes.data?.partner_id;
    if (fallback) partnerIds.add(fallback);
  }

  const userIds = new Set(receipts.map((r) => r.user_id).filter(Boolean));
  // the master / tailor the ticket is assigned to now (they may have a login of their own)
  const memberIds = [];
  if (card?.tailor_id && (!stages.length || stages.includes('stitching'))) memberIds.push(card.tailor_id);
  if (card?.master_id && (!stages.length || stages.includes('cutting'))) memberIds.push(card.master_id);
  if (memberIds.length) {
    const { data } = await supabaseAdmin.from('team_members').select('user_id').in('id', memberIds);
    for (const m of data || []) if (m.user_id) userIds.add(m.user_id);
  }
  return { partnerIds: [...partnerIds], userIds: [...userIds] };
};

/** Of these people, only the active staff of one of these partners (a login is never trusted just because it is on a record). */
const authorisedStaff = async (userIds, partnerIds) => {
  if (!userIds.length || !partnerIds.length) return [];
  const { data } = await supabaseAdmin.from('profiles').select('id, role, partner_id, is_active').in('id', userIds);
  return (data || []).filter((p) => p.role === 'partner_staff' && p.is_active !== false && partnerIds.includes(p.partner_id)).map((p) => p.id);
};

/**
 * Tell everybody responsible for one article about an event, and nobody else:
 *   - the people of the partner(s) that did `stages` who may see `module` (the owner, and members the partner granted it),
 *   - the individuals who did those stages or hold the ticket now (explicitly responsible, so no module needed),
 *   - the admins who may open the page (`admins: false` when the caller tells admins itself).
 * The customer is never included here: private to staff.
 * @param {{ order: { id: string, reference: string }, unitId: string, stages?: string[], module?: string|string[]|null,
 *   notification: object, admins?: boolean, exclude?: string|null }} input
 *   `notification.link` is `{ admin, partner_staff }`.
 */
export const notifyArticleTeam = async ({ order, unitId, stages = [], module = 'production', notification, admins = true, exclude = null }) => {
  const { partnerIds, userIds } = await articleActors({ orderId: order.id, unitId, stages });
  const people = new Set(await authorisedStaff(userIds, partnerIds));
  // the partner's management (owner, supervisors) is told whatever the article; floor workers (master, tailor, QA, pressing,
  // packing) only when they worked on THIS article (they are in `userIds` above): a whole team is never pinged for one piece
  for (const partnerId of partnerIds) {
    for (const p of await partnerRecipients(partnerId, module)) if (!FLOOR_STAFF.has(p.staff_type)) people.add(p.id);
  }
  const link = typeof notification.link === 'object' ? notification.link?.partner_staff : notification.link;
  await notifyUsers([...people], { ...notification, orderId: notification.orderId || order.id, link }, exclude);
  if (admins) await notifyAdmins({ ...notification, orderId: notification.orderId || order.id }, exclude);
};

/** Tell one assigned person (a team member's own login) that an article is theirs now. Only if their login belongs to that partner. */
export const notifyAssignedMember = async ({ memberId, partnerId, notification, exclude = null }) => {
  if (!memberId) return;
  const { data } = await supabaseAdmin.from('team_members').select('user_id').eq('id', memberId).maybeSingle();
  if (!data?.user_id) return;
  const ok = await authorisedStaff([data.user_id], [partnerId]);
  await notifyUsers(ok, notification, exclude);
};
