import { supabaseAdmin } from '../config/supabase.js';
import { emitTo, rooms } from '../realtime/io.js';
import { loadPartner } from './access.service.js';

/**
 * Notifications are stored one row per recipient so each user has their own read state.
 * Failures are logged, never thrown: a missed notification must not break the business action.
 */
const insertMany = async (rows) => {
  if (!rows.length) return;
  const { data, error } = await supabaseAdmin.from('notifications').insert(rows).select('*');
  if (error) {
    console.warn('[Notifications] insert failed:', error.message);
    return;
  }
  rows = rows.map((r, i) => ({ ...r, saved: data?.[i] ?? null }));
  // nudge open apps to refresh their bell right away (they also poll as a fallback)
  // (the rows are pushed too, so open apps can add them to the list immediately)
  for (const row of rows) emitTo(rooms.user(row.user_id), 'notification:new', { notification: row.saved ?? null });
};

/**
 * `dedupe: true` on a notification: a person who already has the same unread one for this order (same title, last 15 minutes)
 * is skipped, so a busy chat does not pile up copies. Decided per person, never for everybody at once.
 */
const skipRecent = async (rows, n) => {
  if (!n.dedupe || !n.orderId || !rows.length) return rows;
  const { data } = await supabaseAdmin
    .from('notifications')
    .select('user_id')
    .eq('order_id', n.orderId)
    .eq('title', n.title)
    .is('read_at', null)
    .gte('created_at', new Date(Date.now() - 15 * 60_000).toISOString())
    .in('user_id', rows.map((r) => r.user_id));
  const already = new Set((data || []).map((d) => d.user_id));
  return rows.filter((r) => !already.has(r.user_id));
};

const toRow = (userId, n) => ({
  user_id: userId,
  type: n.type || 'update',
  title: n.title,
  body: n.body || null,
  link: n.link || null,
  order_id: n.orderId || null,
});

export const notifyUser = async (userId, notification) => {
  if (!userId) return;
  await insertMany([toRow(userId, notification)]);
};

/**
 * Notify every active user with one of the given roles.
 * @param {string[]} roles e.g. ['admin'] or ['partner_staff', 'admin']
 * @param {object} notification
 * @param {string} [excludeUserId] skip the user who triggered the action
 */
export const notifyRoles = async (roles, notification, excludeUserId = null) => {
  const { data, error } = await supabaseAdmin
    .from('profiles')
    .select('id, role')
    .in('role', roles)
    .eq('is_active', true);
  if (error) {
    console.warn('[Notifications] recipient lookup failed:', error.message);
    return;
  }
  const rows = (data || [])
    .filter((p) => p.id !== excludeUserId)
    .map((p) => {
      // Staff links differ per portal
      const link = typeof notification.link === 'object' ? notification.link?.[p.role] : notification.link;
      return toRow(p.id, { ...notification, link });
    });
  await insertMany(await skipRecent(rows, notification));
};

/**
 * The active people of one partner who may see a given module (the owner has every module of the partner,
 * a user only what the partner granted them). `module` is e.g. 'warehouse'; leave it out to include everyone.
 */
export const partnerRecipients = async (partnerId, module = null) => {
  if (!partnerId) return [];
  const partner = await loadPartner(partnerId);
  if (!partner || partner.status !== 'active') return [];
  const { data, error } = await supabaseAdmin
    .from('profiles')
    .select('id, role, partner_role, permissions')
    .eq('role', 'partner_staff')
    .eq('partner_id', partnerId)
    .eq('is_active', true);
  if (error) {
    console.warn('[Notifications] partner recipient lookup failed:', error.message);
    return [];
  }
  const ceiling = new Set(partner.permissions || []);
  return (data || []).filter((u) => {
    if (!module) return true;
    const perms = u.partner_role === 'owner' ? ceiling : new Set((u.permissions || []).filter((p) => ceiling.has(p)));
    return [].concat(module).every((m) => perms.has(`${m}.view`));
  });
};

const orderPartner = async (orderId) => {
  if (!orderId) return null;
  const { data } = await supabaseAdmin.from('orders').select('partner_id').eq('id', orderId).maybeSingle();
  return data?.partner_id || null;
};

/**
 * Tell the partner that owns the order (only the people allowed to see `module`).
 * Needs `notification.orderId`; without it nobody is notified rather than every partner.
 * @param {{ module?: string }} [options]
 */
export const notifyPartner = async (notification, excludeUserId = null, { module = null } = {}) => {
  const partnerId = notification.partnerId || (await orderPartner(notification.orderId));
  const people = await partnerRecipients(partnerId, module);
  const rows = people
    .filter((p) => p.id !== excludeUserId)
    .map((p) => toRow(p.id, { ...notification, link: typeof notification.link === 'object' ? notification.link?.partner_staff : notification.link }));
  await insertMany(await skipRecent(rows, notification));
};

/** The owning partner's people plus every admin. */
export const notifyStaff = async (notification, excludeUserId = null, options = {}) => {
  await Promise.all([notifyPartner(notification, excludeUserId, options), notifyAdmins(notification, excludeUserId)]);
};
export const notifyAdmins = (notification, excludeUserId) => notifyRoles(['admin'], {
  ...notification,
  link: typeof notification.link === 'object' ? notification.link?.admin : notification.link,
}, excludeUserId);
