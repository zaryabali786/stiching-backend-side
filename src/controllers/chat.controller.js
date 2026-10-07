import { supabaseAdmin } from '../config/supabase.js';
import { catchAsync, ApiResponse, BadRequestError } from '../utils/error.helper.js';
import { parseListQuery, sendPage, ilikeAny } from '../utils/pagination.js';
import { unwrap } from '../utils/db.js';
import { scoped, scopeOf } from '../services/access.service.js';
import { STATUS_LABELS } from '../services/order.service.js';
import { uploadAudio, signedDocumentUrl } from '../services/storage.service.js';
import { uploadNoteVoice } from '../services/voice-note.service.js';
import {
  MAX_VOICE_SECONDS,
  assertConversationAccess,
  conversationScopes,
  customerConversations,
  createMessage,
  listMessages,
  markConversationRead,
  unreadByOrder,
  unreadConversationCount,
} from '../services/chat.service.js';

/**
 * Order conversation over plain HTTP. Mounted for customers (/client/orders/:id/...) and for
 * staff (/partner/orders/:id/...); the same handlers serve both because access is decided per role.
 * The realtime path (Socket.IO) uses the same service, so both stay in sync.
 */

/** GET /orders/:id/messages?limit=30&before=<nextCursor> — oldest -> newest within the page */
export const getMessages = catchAsync(async (req, res) => {
  const order = await assertConversationAccess(req.profile, req.params.id);
  const { items, hasMore, nextCursor } = await listMessages(order.id, { limit: req.query.limit, before: req.query.before, unitId: req.query.unit_id });
  return ApiResponse.success(res, items, 'Success', 200, { hasMore, nextCursor, limit: items.length });
});

/**
 * POST /orders/:id/messages
 *   text:  { kind: 'text', body, client_msg_id? }
 *   voice: { kind: 'voice', audio: { path, duration, mime, size }, client_msg_id? }   (path from /messages/voice-upload)
 */
export const postMessage = catchAsync(async (req, res) => {
  const order = await assertConversationAccess(req.profile, req.params.id, { write: true });
  const { message, duplicate } = await createMessage({
    order,
    profile: req.profile,
    kind: req.body?.kind || 'text',
    body: req.body?.body,
    audio: req.body?.audio,
    clientMsgId: req.body?.client_msg_id,
    unitId: req.body?.unit_id,
  });
  return ApiResponse.success(res, message, duplicate ? 'Already sent.' : 'Sent.', duplicate ? 200 : 201);
});

/**
 * POST /orders/:id/messages/voice-upload  { audio: { dataUrl, duration } }
 * Stores the clip privately and returns the reference to send as a voice message. Audio never
 * travels over the socket.
 */
export const uploadVoice = catchAsync(async (req, res) => {
  const order = await assertConversationAccess(req.profile, req.params.id, { write: true });
  const audio = req.body?.audio;
  if (!audio?.dataUrl) throw new BadRequestError('Record a voice note first.');
  const duration = Number(audio.duration);
  if (!Number.isFinite(duration) || duration < 0.3) throw new BadRequestError('The recording is too short.');
  if (duration > MAX_VOICE_SECONDS) throw new BadRequestError(`Voice notes can be at most ${MAX_VOICE_SECONDS / 60} minutes.`);
  const stored = await uploadAudio(`voice/${order.id}/${req.profile.id}`, audio.dataUrl);
  return ApiResponse.created(res, { ...stored, duration, url: await signedDocumentUrl(stored.path, 3600) }, 'Voice note uploaded.');
});

/** GET /orders/:id/conversation — the chats of this order: General + one per article, with unread counts */
export const getConversationScopes = catchAsync(async (req, res) => {
  const order = await assertConversationAccess(req.profile, req.params.id);
  const scopes = await conversationScopes(order, req.profile);
  return ApiResponse.success(res, { scopes, unread: scopes.reduce((n, s) => n + s.unread, 0) });
});

/** GET /client/conversations — every order of mine that has chats, each with its General + article chats and unread counts */
export const getMyConversations = catchAsync(async (req, res) => {
  ApiResponse.success(res, await customerConversations(req.profile));
});

/** POST /orders/:id/messages/read — the other side's messages become read */
export const readMessages = catchAsync(async (req, res) => {
  const order = await assertConversationAccess(req.profile, req.params.id);
  return ApiResponse.success(res, { updated: await markConversationRead(order, req.profile, req.body?.unit_id) });
});

// ───────────────────────── staff inbox ─────────────────────────

/**
 * GET /partner/conversations?search&page&limit&filter=all|unread
 * Orders that have messages, newest activity first. `unread` = customer messages nobody on staff has opened.
 */
export const getConversations = catchAsync(async (req, res) => {
  const q = parseListQuery(req, { defaultLimit: 20, sortable: ['last_message_at'], defaultSort: 'last_message_at', defaultDir: 'desc' });
  let query = supabaseAdmin
    .from('orders')
    .select('id, reference, brand, status, customer_name, customer_code, last_message_at, last_message_preview, last_message_role', { count: 'exact' })
    .not('last_message_at', 'is', null)
    .order('last_message_at', { ascending: false })
    .range(q.from, q.to);
  query = scoped(req.access, query); // a partner only sees the conversations of its own orders
  if (q.search) query = query.or(ilikeAny(['reference', 'customer_name', 'customer_code', 'brand'], q.search));

  if (req.query.filter === 'unread') {
    // narrow to conversations with something unread before paging
    let unreadQuery = supabaseAdmin.from('order_messages').select('order_id, order:orders!order_messages_order_id_fkey!inner(partner_id)').eq('sender_role', 'customer').is('read_at', null).limit(2000);
    if (scopeOf(req.access) !== undefined) unreadQuery = unreadQuery.eq('order.partner_id', scopeOf(req.access));
    const { data } = await unreadQuery;
    const ids = [...new Set((data || []).map((r) => r.order_id))];
    query = query.in('id', ids.length ? ids : ['00000000-0000-0000-0000-000000000000']);
  }

  const result = await query;
  const orders = unwrap(result, 'Could not load conversations');
  const unread = await unreadByOrder(orders.map((o) => o.id));

  // the chats of each order that have messages (General and/or single articles), so staff can open exactly one
  const ids = orders.map((o) => o.id);
  const chatsByOrder = {};
  if (ids.length) {
    const msgs = unwrap(await supabaseAdmin.from('order_messages').select('order_id, unit_id, sender_role, read_at, kind, body, created_at').in('order_id', ids).order('created_at', { ascending: false }).limit(4000), 'Could not load conversations');
    const unitIds = [...new Set(msgs.map((m) => m.unit_id).filter(Boolean))];
    const units = unitIds.length ? unwrap(await supabaseAdmin.from('order_units').select('id, unit_title, line_no').in('id', unitIds)) : [];
    const unitMap = new Map(units.map((u) => [u.id, u]));
    for (const m of msgs) {
      const list = (chatsByOrder[m.order_id] ||= new Map());
      const key = m.unit_id ?? 'general';
      if (!list.has(key)) {
        list.set(key, {
          unit_id: m.unit_id ?? null,
          title: m.unit_id ? unitMap.get(m.unit_id)?.unit_title || 'Article' : 'General',
          line_no: m.unit_id ? unitMap.get(m.unit_id)?.line_no ?? 99 : 0,
          unread: 0,
          last_message_at: m.created_at,
          last_message_preview: m.kind === 'voice' ? 'Voice message' : String(m.body || '').slice(0, 80),
        });
      }
      if (m.sender_role === 'customer' && !m.read_at) list.get(key).unread += 1;
    }
  }
  const rows = orders.map((o) => ({
    chats: [...(chatsByOrder[o.id]?.values() ?? [])].sort((a, b) => a.line_no - b.line_no),
    order_id: o.id,
    reference: o.reference,
    brand: o.brand,
    status: o.status,
    status_label: STATUS_LABELS[o.status],
    customer_name: o.customer_name,
    customer_code: o.customer_code,
    last_message_at: o.last_message_at,
    last_message_preview: o.last_message_preview,
    last_message_role: o.last_message_role,
    unread: unread[o.id] || 0,
  }));
  return sendPage(res, rows, q, result.count, { unreadConversations: await unreadConversationCount(scopeOf(req.access)) });
});

/**
 * GET /partner/orders/:id/summary — header for a conversation (works before any message exists)
 */
export const getOrderSummary = catchAsync(async (req, res) => {
  const order = await assertConversationAccess(req.profile, req.params.id);
  return ApiResponse.success(res, {
    id: order.id,
    reference: order.reference,
    customer_name: order.customer_name,
    customer_code: order.customer_code,
    brand: order.brand,
    status: order.status,
    status_label: STATUS_LABELS[order.status],
  });
});

/**
 * POST /client/voice-upload and /partner/voice-upload  { audio: { dataUrl, duration } }
 * Stores a recording privately for the signed-in person; send the returned { path, duration, mime, size }
 * as `notes_audio` (or `audio`) next to a text note.
 */
export const uploadVoiceNote = catchAsync(async (req, res) =>
  ApiResponse.created(res, await uploadNoteVoice(req.userId, req.body?.audio), 'Voice note uploaded.'));

/** GET /partner/conversations/unread-count */
export const getUnreadCount = catchAsync(async (req, res) => ApiResponse.success(res, { unreadConversations: await unreadConversationCount(scopeOf(req.access)) }));
