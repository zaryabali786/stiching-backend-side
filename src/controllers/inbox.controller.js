import { catchAsync, ApiResponse, NotFoundError } from '../utils/error.helper.js';
import { parseListQuery, sendPage } from '../utils/pagination.js';
import { getForwardAddress } from '../services/order-import.service.js';
import { deleteEmail, listInbox, markAllRead, openEmail, unreadCount } from '../services/mailbox.service.js';

const isId = (v) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(v));

/** GET /api/client/inbox?page&limit&unread=1&search= — the customer's emails, newest first (meta.unread = unread total). */
export const getInbox = catchAsync(async (req, res) => {
  const q = parseListQuery(req, { defaultLimit: 20, maxLimit: 50 });
  const { rows, total } = await listInbox(req.userId, { from: q.from, to: q.to, unreadOnly: req.query.unread === '1', search: q.search });
  return sendPage(res, rows, q, total, { unread: await unreadCount(req.userId) });
});

/** GET /api/client/inbox/address — the customer's personal shopping address (created on first use) */
export const getMailbox = catchAsync(async (req, res) => {
  return ApiResponse.success(res, { ...(await getForwardAddress(req.userId)), unread: await unreadCount(req.userId) });
});

/** GET /api/client/inbox/unread-count */
export const getUnreadCount = catchAsync(async (req, res) => {
  return ApiResponse.success(res, { unread: await unreadCount(req.userId) });
});

/** GET /api/client/inbox/:id — full email (marks it read) */
export const getEmail = catchAsync(async (req, res) => {
  const email = isId(req.params.id) ? await openEmail(req.userId, req.params.id) : null;
  if (!email) throw new NotFoundError('Email not found');
  return ApiResponse.success(res, email);
});

/** POST /api/client/inbox/read-all */
export const readAll = catchAsync(async (req, res) => {
  await markAllRead(req.userId);
  return ApiResponse.success(res, { unread: 0 }, 'All emails marked as read.');
});

/** DELETE /api/client/inbox/:id */
export const removeEmail = catchAsync(async (req, res) => {
  if (!isId(req.params.id) || !(await deleteEmail(req.userId, req.params.id))) throw new NotFoundError('Email not found');
  return ApiResponse.success(res, null, 'Email deleted.');
});
