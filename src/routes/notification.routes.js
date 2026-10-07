import { Router } from 'express';
import {
  listNotifications,
  getUnreadCount,
  markRead,
  markAllRead,
  deleteNotification,
} from '../controllers/notification.controller.js';

const router = Router();

router.get('/', listNotifications);
router.get('/unread-count', getUnreadCount);
router.post('/read-all', markAllRead);
router.post('/:id/read', markRead);
router.delete('/:id', deleteNotification);

export default router;
