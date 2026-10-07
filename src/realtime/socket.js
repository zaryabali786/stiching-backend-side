import { Server } from 'socket.io';
import { verifyToken, loadProfile } from '../middlewares/auth.middleware.js';
import { assertConversationAccess, createMessage, markConversationRead, senderRole } from '../services/chat.service.js';
import { resolveAccess } from '../services/access.service.js';
import { setIO, rooms } from './io.js';

/**
 * Real-time layer for order conversations.
 *
 *   client -> server                               server -> client
 *   conversation:join   { orderId }  (ack)         message:new   <message>          (room order:<id>)
 *   conversation:leave  { orderId }                message:read  { orderId, readerRole, readAt, count }
 *   message:send        { orderId, kind, body | audio{path,duration,mime,size}, client_msg_id }  (ack)
 *   message:read        { orderId }  (ack)         inbox:update  { orderId }        (user:<id> / staff)
 *   typing              { orderId, typing }        typing        { orderId, userId, name, role, typing }
 *                                                  notification:new                 (user:<id>)
 *
 * The login access token is sent as `auth: { token }` when connecting. Messages are saved by the same
 * service the REST endpoints use, so history is identical however they were sent.
 */

const errorMessage = (err) => (err?.statusCode && err.statusCode < 500 ? err.message : 'Something went wrong. Please try again.');

/** Wrap a socket handler so failures become `{ ok: false, error }` acks instead of crashes. */
const handler = (fn) => async (payload, ack) => {
  const reply = typeof ack === 'function' ? ack : () => {};
  try {
    reply({ ok: true, ...(await fn(payload || {})) });
  } catch (err) {
    if (!err?.statusCode || err.statusCode >= 500) console.warn('[Socket] handler error:', err?.message);
    reply({ ok: false, error: errorMessage(err), status: err?.statusCode || 500 });
  }
};

export const initSocket = (httpServer) => {
  const io = new Server(httpServer, {
    cors: { origin: '*', methods: ['GET', 'POST'] },
    // text + small metadata only: voice clips are uploaded over HTTP and shared by reference
    maxHttpBufferSize: 100_000,
    pingInterval: 25_000,
    pingTimeout: 20_000,
  });
  setIO(io);

  io.use(async (socket, next) => {
    try {
      const raw = socket.handshake.auth?.token || (socket.handshake.headers.authorization || '').replace(/^Bearer\s+/i, '');
      if (!raw) return next(new Error('unauthorized'));
      const identity = await verifyToken(String(raw));
      const profile = await loadProfile(identity.id);
      if (!profile || profile.is_active === false) return next(new Error('unauthorized'));
      // pending staff sign-ups keep role "customer" until approved and must not chat as customers
      if (profile.role === 'customer' && profile.requested_role) return next(new Error('unauthorized'));
      socket.data.userId = profile.id;
      next();
    } catch {
      next(new Error('unauthorized'));
    }
  });

  io.on('connection', async (socket) => {
    const userId = socket.data.userId;
    let profile = await loadProfile(userId).catch(() => null);
    if (!profile) return socket.disconnect(true);

    socket.join(rooms.user(userId));
    // staff inbox updates: admins hear about every order, a partner only about its own (and only with the messages permission)
    const access = await resolveAccess(profile);
    if (access.isAdmin) socket.join(rooms.admins);
    else if (access.partnerId && access.permissions.has('messages.view')) socket.join(rooms.partner(access.partnerId));

    /** Re-read the profile (30s cache) so a deactivated account stops working mid-connection. */
    const current = async () => {
      profile = await loadProfile(userId);
      if (!profile || profile.is_active === false) {
        socket.disconnect(true);
        throw Object.assign(new Error('This account has been deactivated.'), { statusCode: 403 });
      }
      return profile;
    };

    socket.on(
      'conversation:join',
      handler(async ({ orderId }) => {
        const order = await assertConversationAccess(await current(), orderId);
        await socket.join(rooms.order(order.id));
        return { orderId: order.id };
      }),
    );

    socket.on('conversation:leave', ({ orderId } = {}) => {
      if (orderId) socket.leave(rooms.order(orderId));
    });

    socket.on(
      'message:send',
      handler(async ({ orderId, unit_id: unitId, kind = 'text', body, audio, client_msg_id: clientMsgId }) => {
        const me = await current();
        const order = await assertConversationAccess(me, orderId, { write: true });
        await socket.join(rooms.order(order.id));
        const { message, duplicate } = await createMessage({ order, profile: me, kind, body, audio, clientMsgId, unitId });
        return { message, duplicate };
      }),
    );

    socket.on(
      'message:read',
      handler(async ({ orderId, unit_id: unitId }) => {
        const me = await current();
        const order = await assertConversationAccess(me, orderId);
        return { updated: await markConversationRead(order, me, unitId) };
      }),
    );

    // Only relayed to people already in the conversation room; never stored
    socket.on('typing', ({ orderId, typing } = {}) => {
      if (!orderId || !socket.rooms.has(rooms.order(orderId))) return;
      socket.to(rooms.order(orderId)).emit('typing', { orderId, userId, name: profile.full_name, role: senderRole(profile), typing: !!typing });
    });
  });

  return io;
};
