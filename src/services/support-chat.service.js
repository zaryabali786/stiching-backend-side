import { supabaseAdmin } from '../config/supabase.js';
import { BadRequestError, NotFoundError } from '../utils/error.helper.js';
import { unwrap } from '../utils/db.js';
import { notifyAdmins, notifyUser } from './notification.service.js';
import { emitTo, rooms } from '../realtime/io.js';

/**
 * General chat between one customer and the admin team (text only), not about any order.
 * Saved first, then broadcast: `support:new` / `support:read` go to the customer's own room and to every admin.
 */

const SELECT = 'id, customer_id, sender_id, sender_role, body, client_msg_id, read_at, created_at, sender:profiles!support_messages_sender_id_fkey(id, full_name)';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const broadcast = (customerId, event, payload) => {
  emitTo(rooms.user(customerId), event, payload);
  emitTo(rooms.admins, event, payload);
};

/** The newest `limit` messages (oldest first), or the page before `before` (an ISO time). */
export const listThread = async (customerId, { before, limit = 50 } = {}) => {
  let q = supabaseAdmin.from('support_messages').select(SELECT).eq('customer_id', customerId).order('created_at', { ascending: false }).limit(Math.min(limit, 100) + 1);
  if (before) q = q.lt('created_at', before);
  const rows = unwrap(await q);
  const hasMore = rows.length > limit;
  return { messages: rows.slice(0, limit).reverse(), hasMore };
};

export const sendSupportMessage = async ({ customerId, profile, body, clientMsgId }) => {
  const text = String(body || '').trim();
  if (!text) throw new BadRequestError('Write a message first.');
  if (text.length > 4000) throw new BadRequestError('The message is too long (4000 characters at most).');
  const role = profile.role === 'admin' ? 'admin' : 'customer';
  const cid = clientMsgId ? String(clientMsgId).slice(0, 64) : null;

  if (cid) {
    const { data: dup } = await supabaseAdmin.from('support_messages').select(SELECT).eq('customer_id', customerId).eq('sender_id', profile.id).eq('client_msg_id', cid).maybeSingle();
    if (dup) return { message: dup, duplicate: true };
  }
  const message = unwrap(await supabaseAdmin.from('support_messages').insert({
    customer_id: customerId, sender_id: profile.id, sender_role: role, body: text, client_msg_id: cid,
  }).select(SELECT).single());
  broadcast(customerId, 'support:new', message);

  const preview = text.length > 90 ? `${text.slice(0, 90)}…` : text;
  if (role === 'customer') {
    await notifyAdmins({ type: 'update', title: 'New message from a customer', body: `${profile.full_name || 'Customer'}: ${preview}`, link: `/admin/support?customer=${customerId}`, dedupe: true }).catch(() => {});
  } else {
    await notifyUser(customerId, { type: 'update', title: 'New message from our team', body: preview, link: '/app/overview' }).catch(() => {});
  }
  return { message, duplicate: false };
};

/** Mark what the other side wrote as read. `readerRole` is the reader's role. */
export const markSupportRead = async (customerId, readerRole) => {
  const other = readerRole === 'admin' ? 'customer' : 'admin';
  const readAt = new Date().toISOString();
  const { data, error } = await supabaseAdmin.from('support_messages').update({ read_at: readAt })
    .eq('customer_id', customerId).eq('sender_role', other).is('read_at', null).select('id');
  if (error) throw error;
  if (data?.length) broadcast(customerId, 'support:read', { customerId, readerRole, readAt, count: data.length });
  return data?.length || 0;
};

export const customerUnread = async (customerId) => {
  const { count } = await supabaseAdmin.from('support_messages').select('id', { count: 'exact', head: true }).eq('customer_id', customerId).eq('sender_role', 'admin').is('read_at', null);
  return count || 0;
};

/** Admin: one row per customer who has written, newest first, with the last message and unread count. */
export const listConversations = async ({ search = '', limit = 50 } = {}) => {
  const rows = unwrap(await supabaseAdmin.from('support_messages').select('customer_id, sender_role, body, read_at, created_at').order('created_at', { ascending: false }).limit(1000));
  const byCustomer = new Map();
  for (const r of rows) {
    const c = byCustomer.get(r.customer_id) || { customer_id: r.customer_id, last: r, unread: 0 };
    if (r.sender_role === 'customer' && !r.read_at) c.unread += 1;
    byCustomer.set(r.customer_id, c);
  }
  const ids = [...byCustomer.keys()];
  if (!ids.length) return [];
  const people = unwrap(await supabaseAdmin.from('profiles').select('id, full_name, email, customer_code').in('id', ids));
  const out = people.map((p) => {
    const c = byCustomer.get(p.id);
    return { customer_id: p.id, customer_name: p.full_name, email: p.email, customer_code: p.customer_code, unread: c.unread, last_body: c.last.body, last_role: c.last.sender_role, last_at: c.last.created_at };
  });
  const needle = String(search || '').trim().toLowerCase();
  return out
    .filter((c) => !needle || [c.customer_name, c.email, c.customer_code].some((v) => String(v || '').toLowerCase().includes(needle)))
    .sort((a, b) => b.last_at.localeCompare(a.last_at))
    .slice(0, limit);
};

export const assertCustomer = async (customerId) => {
  if (!UUID.test(String(customerId || ''))) throw new NotFoundError('Customer not found');
  const { data } = await supabaseAdmin.from('profiles').select('id, full_name, email, customer_code, role').eq('id', customerId).maybeSingle();
  if (!data || data.role !== 'customer') throw new NotFoundError('Customer not found');
  return data;
};

export const adminUnreadTotal = async () => {
  const { count } = await supabaseAdmin.from('support_messages').select('id', { count: 'exact', head: true }).eq('sender_role', 'customer').is('read_at', null);
  return count || 0;
};
