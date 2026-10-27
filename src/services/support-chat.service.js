import { supabaseAdmin } from '../config/supabase.js';
import { BadRequestError, NotFoundError } from '../utils/error.helper.js';
import { unwrap } from '../utils/db.js';
import { notifyAdmins, notifyUser } from './notification.service.js';
import { emitTo, rooms } from '../realtime/io.js';
import { documentExists, signedDocumentUrl, uploadAudio } from './storage.service.js';

/**
 * General chat between one customer and the admin team (text and voice), not about any order.
 * Saved first, then broadcast: `support:new` / `support:read` go to the customer's own room and to every admin.
 */

const SELECT = 'id, customer_id, sender_id, sender_role, kind, body, audio, client_msg_id, read_at, created_at, sender:profiles!support_messages_sender_id_fkey(id, full_name)';
export const MAX_VOICE_SECONDS = 300;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Public shape of a message; a voice note gets a short-lived link, never the storage path. */
const publicMessage = async (row) => {
  if (!row) return row;
  const audio = row.audio
    ? { mime: row.audio.mime, duration: row.audio.duration ?? null, size: row.audio.size ?? null, url: await signedDocumentUrl(row.audio.path, 3600) }
    : null;
  return { ...row, kind: row.kind || 'text', audio };
};

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
  const messages = await Promise.all(rows.slice(0, limit).reverse().map(publicMessage));
  return { messages, hasMore };
};

/** A recording was uploaded under voice/support/<customer>/<sender>/: only that path is accepted, so nobody can attach another person's file. */
const validateVoice = async ({ customerId, profile, audio }) => {
  const path = String(audio?.path || '');
  if (!path.startsWith(`voice/support/${customerId}/${profile.id}/`) || path.includes('..')) throw new BadRequestError('This voice message is not valid for this chat.');
  const duration = Number(audio?.duration);
  if (!Number.isFinite(duration) || duration < 0.3) throw new BadRequestError('The voice message is too short.');
  if (duration > MAX_VOICE_SECONDS) throw new BadRequestError(`Voice messages can be at most ${MAX_VOICE_SECONDS / 60} minutes.`);
  if (!(await documentExists(path))) throw new BadRequestError('The voice message was not uploaded. Please record it again.');
  return { path, mime: String(audio.mime || 'audio/webm').slice(0, 60), duration: Math.round(duration * 10) / 10, size: Number(audio.size) || null };
};

/** Store a recording for this chat (private bucket) and give back what the message needs plus a link to play it. */
export const uploadSupportVoice = async ({ customerId, profile, audio }) => {
  if (!audio?.dataUrl) throw new BadRequestError('Record a voice message first.');
  const duration = Number(audio.duration);
  if (!Number.isFinite(duration) || duration < 0.3) throw new BadRequestError('The recording is too short.');
  if (duration > MAX_VOICE_SECONDS) throw new BadRequestError(`Voice messages can be at most ${MAX_VOICE_SECONDS / 60} minutes.`);
  const stored = await uploadAudio(`voice/support/${customerId}/${profile.id}`, audio.dataUrl);
  return { ...stored, duration, url: await signedDocumentUrl(stored.path, 3600) };
};

export const sendSupportMessage = async ({ customerId, profile, kind = 'text', body, audio, clientMsgId }) => {
  const isVoice = kind === 'voice';
  if (!isVoice && kind !== 'text') throw new BadRequestError('Message kind must be "text" or "voice".');
  let text = null;
  let voice = null;
  if (isVoice) {
    voice = await validateVoice({ customerId, profile, audio });
  } else {
    text = String(body || '').trim();
    if (!text) throw new BadRequestError('Write a message first.');
    if (text.length > 4000) throw new BadRequestError('The message is too long (4000 characters at most).');
  }
  const role = profile.role === 'admin' ? 'admin' : 'customer';
  const cid = clientMsgId ? String(clientMsgId).slice(0, 64) : null;

  if (cid) {
    const { data: dup } = await supabaseAdmin.from('support_messages').select(SELECT).eq('customer_id', customerId).eq('sender_id', profile.id).eq('client_msg_id', cid).maybeSingle();
    if (dup) return { message: await publicMessage(dup), duplicate: true };
  }
  const row = unwrap(await supabaseAdmin.from('support_messages').insert({
    customer_id: customerId, sender_id: profile.id, sender_role: role, kind: isVoice ? 'voice' : 'text', body: text, audio: voice, client_msg_id: cid,
  }).select(SELECT).single());
  const message = await publicMessage(row);
  broadcast(customerId, 'support:new', message);

  const preview = isVoice ? 'Voice message' : text.length > 90 ? `${text.slice(0, 90)}…` : text;
  if (role === 'customer') {
    await notifyAdmins({ type: 'update', title: 'New message from a customer', body: `${profile.full_name || 'Customer'}: ${preview}`, link: `/admin/support?customer=${customerId}`, dedupe: true }).catch(() => {});
  } else {
    await notifyUser(customerId, { type: 'update', title: 'New message from our team', body: preview, link: '/app/overview?support=1' }).catch(() => {});
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
  const rows = unwrap(await supabaseAdmin.from('support_messages').select('customer_id, sender_role, kind, body, read_at, created_at').order('created_at', { ascending: false }).limit(1000));
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
    return { customer_id: p.id, customer_name: p.full_name, email: p.email, customer_code: p.customer_code, unread: c.unread, last_body: c.last.kind === 'voice' ? 'Voice message' : c.last.body, last_role: c.last.sender_role, last_at: c.last.created_at };
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
