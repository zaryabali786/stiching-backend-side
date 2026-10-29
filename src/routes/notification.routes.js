import { Router } from 'express';
import {
  listNotifications,
  getUnreadCount,
  markRead,
  markAllRead,
  markOrdersRead,
  getNotificationDestination,
  deleteNotification,
  registerPushDevice,
  unregisterPushDevice,
} from '../controllers/notification.controller.js';

const router = Router();

router.get('/', listNotifications);
router.get('/unread-count', getUnreadCount);
router.post('/devices', registerPushDevice);
router.post('/devices/remove', unregisterPushDevice);
router.post('/read-all', markAllRead);
router.post('/read-orders', markOrdersRead);
router.get('/:id/destination', getNotificationDestination);
router.post('/:id/read', markRead);
router.delete('/:id', deleteNotification);

export default router;
