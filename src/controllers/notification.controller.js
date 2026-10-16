import { supabaseAdmin } from '../config/supabase.js';
import { catchAsync, ApiResponse, BadRequestError } from '../utils/error.helper.js';
import { registerDevice, unregisterDevice } from '../services/push.service.js';
import { parseListQuery, sendPage } from '../utils/pagination.js';
import { unwrap } from '../utils/db.js';

const unreadCount = async (userId) => {
  const { count } = await supabaseAdmin
    .from('notifications')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', userId)
    .is('read_at', null);
  return count || 0;
};

/** Unread notifications about an order (status changes, payments, shipping): the badge on the Orders tab. */
const unreadOrderCount = async (userId) => {
  const { count } = await supabaseAdmin
    .from('notifications')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', userId)
    .is('read_at', null)
    .or('order_id.not.is.null,link.like./app/orders*');
  return count || 0;
};

/**
 * GET /api/notifications?page=1&limit=15&unread=true
 */
export const listNotifications = catchAsync(async (req, res) => {
  const q = parseListQuery(req, { defaultLimit: 15, maxLimit: 50 });
  let query = supabaseAdmin
    .from('notifications')
    .select('*', { count: 'exact' })
    .eq('user_id', req.userId)
    .order('created_at', { ascending: false })
    .range(q.from, q.to);
  if (req.query.unread === 'true') query = query.is('read_at', null);

  const result = await query;
  const rows = unwrap(result, 'Could not load notifications');
  return sendPage(res, rows, q, result.count, { unreadCount: await unreadCount(req.userId), orders: await unreadOrderCount(req.userId) });
});

export const getUnreadCount = catchAsync(async (req, res) =>
  ApiResponse.success(res, { unreadCount: await unreadCount(req.userId), orders: await unreadOrderCount(req.userId) }));

export const markRead = catchAsync(async (req, res) => {
  unwrap(
    await supabaseAdmin
      .from('notifications')
      .update({ read_at: new Date().toISOString() })
      .eq('id', req.params.id)
      .eq('user_id', req.userId)
      .is('read_at', null)
  );
  return ApiResponse.success(res, { unreadCount: await unreadCount(req.userId), orders: await unreadOrderCount(req.userId) }, 'Marked as read.');
});

/** POST /api/notifications/read-orders — the customer opened the Orders tab: its changes are seen */
export const markOrdersRead = catchAsync(async (req, res) => {
  unwrap(
    await supabaseAdmin
      .from('notifications')
      .update({ read_at: new Date().toISOString() })
      .eq('user_id', req.userId)
      .is('read_at', null)
      .or('order_id.not.is.null,link.like./app/orders*')
  );
  return ApiResponse.success(res, { unreadCount: await unreadCount(req.userId), orders: 0 });
});

export const markAllRead = catchAsync(async (req, res) => {
  unwrap(
    await supabaseAdmin
      .from('notifications')
      .update({ read_at: new Date().toISOString() })
      .eq('user_id', req.userId)
      .is('read_at', null)
  );
  return ApiResponse.success(res, { unreadCount: 0 }, 'All notifications marked as read.');
});

export const deleteNotification = catchAsync(async (req, res) => {
  unwrap(await supabaseAdmin.from('notifications').delete().eq('id', req.params.id).eq('user_id', req.userId));
  return ApiResponse.success(res, { unreadCount: await unreadCount(req.userId) }, 'Notification removed.');
});

/** POST /api/notifications/devices  body: { token, platform: 'android'|'ios'|'web', app?: 'client'|'admin' } — this phone/browser now gets MY pushes */
export const registerPushDevice = catchAsync(async (req, res) => {
  const token = String(req.body?.token || '').trim();
  if (token.length < 20 || token.length > 4096) throw new BadRequestError('A valid push token is required.');
  await registerDevice(req.userId, { token, platform: req.body?.platform, app: req.body?.app });
  return ApiResponse.success(res, { registered: true }, 'Push notifications are on for this device.');
});

/** POST /api/notifications/devices/remove  body: { token } — sign-out: this device stops getting my pushes */
export const unregisterPushDevice = catchAsync(async (req, res) => {
  const token = String(req.body?.token || '').trim();
  if (token) await unregisterDevice(req.userId, token);
  return ApiResponse.success(res, { registered: false }, 'Push notifications are off for this device.');
});
