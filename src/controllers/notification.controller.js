import { supabaseAdmin } from '../config/supabase.js';
import { catchAsync, ApiResponse } from '../utils/error.helper.js';
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
  return sendPage(res, rows, q, result.count, { unreadCount: await unreadCount(req.userId) });
});

export const getUnreadCount = catchAsync(async (req, res) =>
  ApiResponse.success(res, { unreadCount: await unreadCount(req.userId) }));

export const markRead = catchAsync(async (req, res) => {
  unwrap(
    await supabaseAdmin
      .from('notifications')
      .update({ read_at: new Date().toISOString() })
      .eq('id', req.params.id)
      .eq('user_id', req.userId)
      .is('read_at', null)
  );
  return ApiResponse.success(res, { unreadCount: await unreadCount(req.userId) }, 'Marked as read.');
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
