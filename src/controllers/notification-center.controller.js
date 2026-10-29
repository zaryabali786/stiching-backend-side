import { catchAsync, ApiResponse, ForbiddenError } from '../utils/error.helper.js';
import { adminActionsOf } from '../config/admin-modules.js';
import {
  createBroadcast, sendNow, listBroadcasts, getBroadcast, updateBroadcast, cancelBroadcast, retryBroadcast, dispatchBroadcast,
  searchRecipients, formOptions,
} from '../services/broadcast.service.js';
import { searchProducts, searchProductBrands, searchClientOrders } from '../services/notification-destination.service.js';

/**
 * The Notification Center API, mounted twice: /api/admin/notification-center (clients, staff, partners) and
 * /api/partner/notification-center (a partner's own staff only). Who is calling, and what they may do, always comes from the
 * server-side profile and permissions: nothing in the request body can widen it.
 */

/** An admin: a full admin may do everything; a restricted admin only the Notification Center actions their role holds. */
export const adminActor = (req) => {
  const actions = adminActionsOf(req.profile);
  const mine = actions ? actions.get('notification_center') : null;
  return {
    kind: 'admin',
    userId: req.userId,
    partnerId: null,
    can: (action) => (actions === null ? true : !!mine && mine.has(action)),
  };
};

/** A partner user: only their own partner's staff, and only the actions the partner granted them. */
export const partnerActor = (req) => {
  if (req.profile?.role !== 'partner_staff' || !req.access?.partnerId) throw new ForbiddenError('This area is for partner accounts. Admins use the admin portal.');
  const permissions = req.access.permissions;
  // opening the module needs View
  if (!permissions.has('notifications.view')) throw new ForbiddenError('You do not have access to the Notification Center.');
  return {
    kind: 'partner',
    userId: req.userId,
    partnerId: req.access.partnerId,
    can: (action) => permissions.has(`notifications.${action}`),
  };
};

const make = (actor) => ({
  options: catchAsync(async (req, res) => ApiResponse.success(res, await formOptions(actor(req)))),

  recipients: catchAsync(async (req, res) => {
    const { items, meta } = await searchRecipients(actor(req), req.query);
    return ApiResponse.success(res, items, 'Success', 200, meta);
  }),

  // pickers for the destination of a notification (admin only: a partner reaches its own staff, who have no product or client-order links)
  products: catchAsync(async (req, res) => {
    const a = actor(req);
    if (a.kind !== 'admin' || !a.can('create')) throw new ForbiddenError('You do not have permission to do this.');
    const { items, meta } = await searchProducts(req.query);
    return ApiResponse.success(res, items, 'Success', 200, meta);
  }),

  productBrands: catchAsync(async (req, res) => {
    const a = actor(req);
    if (a.kind !== 'admin' || !a.can('create')) throw new ForbiddenError('You do not have permission to do this.');
    return ApiResponse.success(res, await searchProductBrands());
  }),

  orders: catchAsync(async (req, res) => {
    const a = actor(req);
    if (a.kind !== 'admin' || !a.can('create')) throw new ForbiddenError('You do not have permission to do this.');
    return ApiResponse.success(res, await searchClientOrders(req.query));
  }),

  list: catchAsync(async (req, res) => {
    const { items, meta } = await listBroadcasts(actor(req), req.query);
    return ApiResponse.success(res, items, 'Success', 200, meta);
  }),

  get: catchAsync(async (req, res) => ApiResponse.success(res, await getBroadcast(actor(req), req.params.id, req.query))),

  create: catchAsync(async (req, res) => {
    const { broadcast, dispatchNow } = await createBroadcast(actor(req), req.body || {});
    if (dispatchNow) {
      // delivery runs in the background: a large audience must not hold the request. The result shows in the history.
      void sendNow(broadcast).catch((err) => console.warn('[Broadcast] send failed:', err.message));
      return ApiResponse.created(res, { id: broadcast.id, status: 'processing' }, 'Sending your notification now.');
    }
    return ApiResponse.created(res, { id: broadcast.id, status: 'scheduled', send_at: broadcast.send_at }, 'Notification scheduled.');
  }),

  update: catchAsync(async (req, res) => ApiResponse.success(res, await updateBroadcast(actor(req), req.params.id, req.body || {}), 'Scheduled notification updated.')),

  cancel: catchAsync(async (req, res) => ApiResponse.success(res, await cancelBroadcast(actor(req), req.params.id), 'Scheduled notification cancelled.')),

  retry: catchAsync(async (req, res) => {
    const { broadcast, resolve } = await retryBroadcast(actor(req), req.params.id);
    void dispatchBroadcast(broadcast, { resolve }).catch((err) => console.warn('[Broadcast] retry failed:', err.message));
    return ApiResponse.success(res, { id: broadcast.id, status: 'processing' }, 'Trying the failed deliveries again.');
  }),
});

export const adminNotificationCenter = make(adminActor);
export const partnerNotificationCenter = make(partnerActor);
