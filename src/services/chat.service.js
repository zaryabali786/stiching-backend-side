import { supabaseAdmin } from '../config/supabase.js';
import { AppError, BadRequestError, ForbiddenError, NotFoundError } from '../utils/error.helper.js';
import { unwrap } from '../utils/db.js';
import { documentExists, signedDocumentUrl } from './storage.service.js';
import { notifyUser, notifyAdmins, notifyPartner, partnerRecipients } from './notification.service.js';
import { resolveAccess } from './access.service.js';
import { loadProfile } from '../middlewares/auth.middleware.js';
import { emitTo, getIO, rooms } from '../realtime/io.js';

/**
 * Customer <-> partner conversation per order (text + voice).
 * Messages are always persisted here first; sockets only broadcast what was saved.
 */

export const MAX_TEXT = 4000;
export const MAX_VOICE_SECONDS = 300;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const isStaffRole = (role) => role === 'partner_staff' || role === 'admin';
export const senderRole = (profile) => (profile.role === 'admin' ? 'admin' : profile.role === 'partner_staff' ? 'partner_staff' : 'customer');

const MESSAGE_SELECT = 'id, order_id, unit_id, sender_id, sender_role, kind, body, audio, client_msg_id, read_at, created_at, sender:profiles!order_messages_sender_id_fkey(id, full_name)';

// ───────────────────────── access ─────────────────────────

/**
 * The order this person may talk about: a customer only their own, an admin any, and a partner user only the orders of
 * their own partner and only with the messages permission (`write: true` needs the permission to send).
 */
export const assertConversationAccess = async (profile, orderId, { write = false } = {}) => {
  if (!UUID.test(String(orderId || ''))) throw new NotFoundError('Order not found');
  const { data: order, error } = await supabaseAdmin
    .from('orders')
    .select('id, reference, customer_id, customer_name, customer_code, brand, status, partner_id')
    .eq('id', orderId)
    .maybeSingle();
  if (error) throw new AppError(`Could not load the order: ${error.message}`, 500);
  if (!order) throw new NotFoundError('Order not found');
  if (profile.role === 'customer') {
    if (order.customer_id !== profile.id) throw new NotFoundError('Order not found');
  } else if (profile.role === 'admin') {
    // admins talk about any order
  } else if (profile.role === 'partner_staff') {
    const access = await resolveAccess(profile);
    if (!access.permissions.has(write ? 'messages.update' : 'messages.view')) throw new ForbiddenError('You do not have permission to use messages.');
    if (!access.partnerId || order.partner_id !== access.partnerId) throw new ForbiddenError('This order belongs to another partner.');
    // chats about the order itself ("General") are for the admin unless the admin enabled them for this partner and user
    order._general = { read: access.permissions.has('general_messages.view'), write: access.permissions.has('general_messages.update') };
  } else {
    throw new ForbiddenError('You cannot use order messages.');
  }
  return order;
};

/** May this person read the General (not article-specific) chat of this order? Customers and admins always can. */
export const canReadGeneral = (order, profile) => profile.role !== 'partner_staff' || order._general?.read === true;
export const canWriteGeneral = (order, profile) => profile.role !== 'partner_staff' || order._general?.write === true;

/** Hide General messages from a query on order_messages (partners without the General permission). */
const withoutGeneral = (query) => query.not('unit_id', 'is', null);

/**
 * Deliver an event to the sockets of an order's conversation room, one by one, re-checking each person NOW:
 * someone who joined earlier but has since lost the messages permission, or whose order moved to another partner,
 * stops receiving. `general` events (not about one article) also need the General permission.
 */
const emitToConversation = async (order, event, payload, { general = false } = {}) => {
  const io = getIO();
  if (!io) return;
  try {
    const sockets = await io.in(rooms.order(order.id)).fetchSockets();
    await Promise.all(
      sockets.map(async (s) => {
        const profile = await loadProfile(s.data.userId).catch(() => null);
        if (!profile || profile.is_active === false) return;
        if (profile.role === 'customer' && profile.id !== order.customer_id) return;
        if (profile.role === 'partner_staff') {
          const access = await resolveAccess(profile);
          if (!access.partnerId || access.partnerId !== order.partner_id || !access.permissions.has('messages.view')) return;
          if (general && !access.permissions.has('general_messages.view')) return;
        }
        s.emit(event, payload);
      }),
    );
  } catch (err) {
    console.warn('[Socket] conversation emit failed:', err.message);
  }
};

/**
 * Tell the admins and the people of the order's own partner who may read it (never another partner) that an inbox changed.
 * Recipients are worked out now, per person, so a permission given or taken away takes effect immediately.
 */
const emitToStaffOf = async (order, event, payload, { general = false } = {}) => {
  emitTo(rooms.admins, event, payload);
  if (!order.partner_id) return;
  const people = await partnerRecipients(order.partner_id, general ? ['messages', 'general_messages'] : 'messages');
  for (const p of people) emitTo(rooms.user(p.id), event, payload);
};

// ───────────────────────── rate limit ─────────────────────────

const WINDOW_MS = 60_000;
const MAX_PER_WINDOW = 30;
const recent = new Map();

const checkRate = (userId) => {
  const now = Date.now();
  const hits = (recent.get(userId) || []).filter((t) => now - t < WINDOW_MS);
  if (hits.length >= MAX_PER_WINDOW) throw new AppError('You are sending messages too quickly. Wait a moment.', 429);
  hits.push(now);
  recent.set(userId, hits);
};

// ───────────────────────── shaping ─────────────────────────

/** Public shape of a message; voice notes get a short-lived link, never the storage path. */
export const shapeMessage = async (row) => {
  const audio = row.audio
    ? { mime: row.audio.mime, duration: row.audio.duration ?? null, size: row.audio.size ?? null, url: await signedDocumentUrl(row.audio.path, 3600) }
    : null;
  const sender = Array.isArray(row.sender) ? row.sender[0] : row.sender;
  return {
    id: row.id,
    order_id: row.order_id,
    unit_id: row.unit_id ?? null,
    sender_id: row.sender_id,
    sender_role: row.sender_role,
    sender_name: sender?.full_name || null,
    kind: row.kind,
    body: row.body,
    audio,
    client_msg_id: row.client_msg_id,
    read_at: row.read_at,
    created_at: row.created_at,
  };
};

// ───────────────────────── history ─────────────────────────

const encodeCursor = (row) => `${row.created_at}|${row.id}`;

/**
 * Newest page first internally, returned oldest -> newest so it can be appended on top of the list.
 * `before` is the `nextCursor` of the previous (newer) page.
 */
/** 'general' = the order itself, a uuid = one article, undefined = everything. */
const scopeFilter = (query, unitId) => {
  if (unitId === undefined || unitId === null || unitId === '' || unitId === 'all') return query;
  if (unitId === 'general') return query.is('unit_id', null);
  if (!UUID.test(String(unitId))) throw new BadRequestError('Invalid article.');
  return query.eq('unit_id', unitId);
};

export const listMessages = async (orderId, { limit = 30, before = null, unitId, general = true } = {}) => {
  const size = Math.min(100, Math.max(1, parseInt(limit, 10) || 30));
  let query = supabaseAdmin
    .from('order_messages')
    .select(MESSAGE_SELECT)
    .eq('order_id', orderId)
    .order('created_at', { ascending: false })
    .order('id', { ascending: false })
    .limit(size + 1);
  if (!general) {
    if (unitId === 'general') throw new ForbiddenError('General messages are only visible to the admin unless the admin enables them for you.');
    query = withoutGeneral(query);
  }
  query = scopeFilter(query, unitId);
  if (before) {
    const [at, id] = String(before).split('|');
    if (!at || Number.isNaN(Date.parse(at)) || !UUID.test(id || '')) throw new BadRequestError('Invalid cursor.');
    query = query.or(`created_at.lt.${at},and(created_at.eq.${at},id.lt.${id})`);
  }
  const rows = unwrap(await query, 'Could not load messages');
  const hasMore = rows.length > size;
  const page = rows.slice(0, size);
  const items = await Promise.all(page.reverse().map(shapeMessage));
  return { items, hasMore, nextCursor: hasMore ? encodeCursor(page[0]) : null };
};

// ───────────────────────── send ─────────────────────────

const validateContent = async ({ order, profile, kind, body, audio }) => {
  if (kind === 'text') {
    const text = String(body ?? '').trim();
    if (!text) throw new BadRequestError('Write a message first.');
    if (text.length > MAX_TEXT) throw new BadRequestError(`Messages can be at most ${MAX_TEXT} characters.`);
    return { body: text, audio: null };
  }
  if (kind === 'voice') {
    const path = String(audio?.path || '');
    // voice files are stored under voice/<order>/<sender>/ by the upload endpoint, so a path can be authorised
    if (!path.startsWith(`voice/${order.id}/${profile.id}/`) || path.includes('..')) throw new BadRequestError('This voice note is not valid for this conversation.');
    const duration = Number(audio?.duration);
    if (!Number.isFinite(duration) || duration < 0.3) throw new BadRequestError('The voice note is too short.');
    if (duration > MAX_VOICE_SECONDS) throw new BadRequestError(`Voice notes can be at most ${MAX_VOICE_SECONDS / 60} minutes.`);
    if (!(await documentExists(path))) throw new BadRequestError('The voice note was not uploaded. Please record it again.');
    return { body: null, audio: { path, mime: String(audio.mime || 'audio/webm').slice(0, 60), duration: Math.round(duration * 10) / 10, size: Number(audio.size) || null } };
  }
  throw new BadRequestError('Message kind must be "text" or "voice".');
};

const previewOf = (message) => (message.kind === 'voice' ? 'Voice message' : message.body.length > 120 ? `${message.body.slice(0, 117)}...` : message.body);

/** One unread "New message" notification per order is enough; further messages just update the thread. */
const recentUnreadNotification = async ({ orderId, title, userId = null }) => {
  let q = supabaseAdmin
    .from('notifications')
    .select('id')
    .eq('order_id', orderId)
    .eq('title', title)
    .is('read_at', null)
    .gte('created_at', new Date(Date.now() - 15 * 60_000).toISOString())
    .limit(1);
  if (userId) q = q.eq('user_id', userId);
  const { data } = await q;
  return !!data?.length;
};

const notifyOtherSide = async (order, profile, message, unit) => {
  const title = `New message on ${order.reference}${unit ? ` · ${unit.unit_title}` : ''}`;
  if (profile.role === 'customer') {
    const q = unit ? `?unit=${unit.id}` : '';
    const note = {
      type: 'update',
      title,
      body: `${order.customer_name}: ${previewOf(message)}`,
      link: { admin: `/admin/messages/${order.id}${q}`, partner_staff: `/partner/messages/${order.id}${q}` },
      orderId: order.id,
      partnerId: order.partner_id,
      dedupe: true, // one unread "New message" per person and order is enough
    };
    // the admins, and only the people of the order's own partner who may read messages
    // General chats also need the General permission
    await Promise.all([notifyAdmins(note), notifyPartner(note, null, { module: unit ? 'messages' : ['messages', 'general_messages'] })]);
  } else if (!(await recentUnreadNotification({ orderId: order.id, title, userId: order.customer_id }))) {
    await notifyUser(order.customer_id, {
      type: 'update',
      title,
      body: previewOf(message),
      link: `/app/orders/${order.id}?chat=1${unit ? `&unit=${unit.id}` : ''}`,
      orderId: order.id,
    });
  }
};

/**
 * Save a message and broadcast it. Safe to retry: the same client_msg_id returns the original message.
 * @param {{ order: object, profile: object, kind: 'text'|'voice', body?: string, audio?: object, clientMsgId?: string, silent?: boolean }} input
 */
export const createMessage = async ({ order, profile, kind, body, audio, clientMsgId = null, unitId = null, silent = false }) => {
  // a message can be about one article of the order
  let unit = null;
  if (unitId) {
    if (!UUID.test(String(unitId))) throw new BadRequestError('Invalid article.');
    const { data } = await supabaseAdmin.from('order_units').select('id, unit_title, line_no').eq('id', unitId).eq('order_id', order.id).maybeSingle();
    if (!data) throw new BadRequestError('That article is not part of this order.');
    unit = data;
  }
  if (!unit && !canWriteGeneral(order, profile)) throw new ForbiddenError('You can only message about an article. General messages are handled by the admin.');
  const clientId = clientMsgId ? String(clientMsgId).slice(0, 80) : null;

  const findExisting = async () => {
    if (!clientId) return null;
    const { data } = await supabaseAdmin.from('order_messages').select(MESSAGE_SELECT).eq('order_id', order.id).eq('sender_id', profile.id).eq('client_msg_id', clientId).maybeSingle();
    return data;
  };
  const existing = await findExisting();
  if (existing) return { message: await shapeMessage(existing), duplicate: true };

  const content = await validateContent({ order, profile, kind, body, audio });
  // only messages that are really saved count towards the flood limit (not rejected ones or safe retries)
  checkRate(profile.id);
  const insert = await supabaseAdmin
    .from('order_messages')
    .insert({ order_id: order.id, unit_id: unit?.id ?? null, sender_id: profile.id, sender_role: senderRole(profile), kind, client_msg_id: clientId, ...content })
    .select(MESSAGE_SELECT)
    .single();
  if (insert.error) {
    if (insert.error.code === '23505') {
      const raced = await findExisting();
      if (raced) return { message: await shapeMessage(raced), duplicate: true };
    }
    unwrap(insert, 'Could not send the message');
  }

  const message = await shapeMessage(insert.data);
  const general = !unit;
  await emitToConversation(order, 'message:new', message, { general });
  emitTo(rooms.user(order.customer_id), 'inbox:update', { orderId: order.id });
  await emitToStaffOf(order, 'inbox:update', { orderId: order.id }, { general });
  if (!silent) await notifyOtherSide(order, profile, message, unit).catch((err) => console.warn('[Chat] notify failed:', err.message));
  return { message, duplicate: false };
};

// ───────────────────────── read receipts ─────────────────────────

/** Mark everything the other side sent as read; tells the sender's open screens. */
export const markConversationRead = async (order, profile, unitId) => {
  const fromRoles = profile.role === 'customer' ? ['partner_staff', 'admin'] : ['customer'];
  const readAt = new Date().toISOString();
  const general = canReadGeneral(order, profile);
  if (!general && unitId === 'general') throw new ForbiddenError('General messages are only visible to the admin unless the admin enables them for you.');
  let update = supabaseAdmin.from('order_messages').update({ read_at: readAt }).eq('order_id', order.id).in('sender_role', fromRoles).is('read_at', null);
  if (!general) update = withoutGeneral(update);
  const { data, error } = await scopeFilter(update, unitId).select('id');
  if (error) throw new AppError(`Could not update messages: ${error.message}`, 500);
  const count = data?.length || 0;
  if (count) {
    const generalScope = unitId === 'general';
    await emitToConversation(order, 'message:read', { orderId: order.id, unitId: unitId && unitId !== 'general' && unitId !== 'all' ? unitId : null, general: generalScope, readerRole: senderRole(profile), readAt, count }, { general: generalScope });
    emitTo(rooms.user(profile.id), 'inbox:update', { orderId: order.id });
    if (isStaffRole(profile.role)) await emitToStaffOf(order, 'inbox:update', { orderId: order.id }, { general: generalScope });
  }
  return count;
};

// ───────────────────────── partner inbox ─────────────────────────

/**
 * Number of conversations that have a customer message nobody on staff has opened yet.
 * A partner only counts the conversations of its own orders (`partnerId`); an admin counts all.
 */
export const unreadConversationCount = async (partnerId, { excludeGeneral = false } = {}) => {
  let query = supabaseAdmin.from('order_messages').select('order_id, order:orders!order_messages_order_id_fkey!inner(partner_id)').eq('sender_role', 'customer').is('read_at', null).limit(2000);
  if (partnerId) query = query.eq('order.partner_id', partnerId);
  if (excludeGeneral) query = withoutGeneral(query);
  const { data } = await query;
  return new Set((data || []).map((r) => r.order_id)).size;
};

export const unreadByOrder = async (orderIds, { excludeGeneral = false } = {}) => {
  if (!orderIds.length) return {};
  let query = supabaseAdmin.from('order_messages').select('order_id').in('order_id', orderIds).eq('sender_role', 'customer').is('read_at', null).limit(5000);
  if (excludeGeneral) query = withoutGeneral(query);
  const { data } = await query;
  const counts = {};
  for (const r of data || []) counts[r.order_id] = (counts[r.order_id] || 0) + 1;
  return counts;
};

// ───────────────────────── per-article conversations ─────────────────────────

/**
 * The chats of one order: "General" plus one per article, each with its unread count and last message,
 * so the app can show tabs / a picker with badges.
 */
const buildScopes = (units, rows, profile, { general = true } = {}) => {
  const fromRoles = profile.role === 'customer' ? ['partner_staff', 'admin'] : ['customer'];
  const scopes = [...(general ? [{ unit_id: null, title: 'General', line_no: 0, image_url: null }] : []), ...units.map((u) => ({ unit_id: u.id, title: u.unit_title, line_no: u.line_no, image_url: u.product_image_url || null }))];
  return scopes.map((s) => {
    const mine = rows.filter((m) => (m.unit_id ?? null) === s.unit_id);
    const last = mine[0];
    return {
      ...s,
      unread: mine.filter((m) => fromRoles.includes(m.sender_role) && !m.read_at).length,
      last_message_at: last?.created_at ?? null,
      last_message_preview: last ? previewOf(last) : null,
      last_message_role: last?.sender_role ?? null,
    };
  });
};

export const conversationScopes = async (order, profile) => {
  const [units, msgs] = await Promise.all([
    supabaseAdmin.from('order_units').select('id, unit_title, line_no, product_image_url').eq('order_id', order.id).order('line_no', { ascending: true }),
    supabaseAdmin.from('order_messages').select('unit_id, sender_role, read_at, kind, body, created_at').eq('order_id', order.id).order('created_at', { ascending: false }).limit(500),
  ]);
  const general = canReadGeneral(order, profile);
  // without the General permission the General chat is not offered and its messages are not even counted
  const rows = unwrap(msgs, 'Could not load the conversations').filter((m) => general || m.unit_id);
  return buildScopes(unwrap(units, 'Could not load the articles'), rows, profile, { general });
};

/** The customer's own orders that have any conversation, each with its chats (one query per table, not per order). */
export const customerConversations = async (profile, { limit = 50 } = {}) => {
  const orders = unwrap(
    await supabaseAdmin.from('orders').select('id, reference, brand, status, last_message_at').eq('customer_id', profile.id).not('last_message_at', 'is', null).order('last_message_at', { ascending: false }).limit(limit),
    'Could not load your conversations',
  );
  if (!orders.length) return [];
  const ids = orders.map((o) => o.id);
  const [units, msgs] = await Promise.all([
    supabaseAdmin.from('order_units').select('id, order_id, unit_title, line_no, product_image_url').in('order_id', ids).order('line_no', { ascending: true }),
    supabaseAdmin.from('order_messages').select('order_id, unit_id, sender_role, read_at, kind, body, created_at').in('order_id', ids).order('created_at', { ascending: false }).limit(5000),
  ]);
  const unitRows = unwrap(units, 'Could not load your conversations');
  const msgRows = unwrap(msgs, 'Could not load your conversations');
  return orders.map((o) => {
    const scopes = buildScopes(unitRows.filter((u) => u.order_id === o.id), msgRows.filter((m) => m.order_id === o.id), profile);
    return { id: o.id, reference: o.reference, brand: o.brand, status: o.status, last_message_at: o.last_message_at, scopes, unread: scopes.reduce((n, x) => n + x.unread, 0) };
  });
};
