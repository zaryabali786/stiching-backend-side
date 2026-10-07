import { Router } from 'express';
import authRoutes from './auth.routes.js';
import adminRoutes from './admin.routes.js';
import partnerRoutes from './partner.routes.js';
import clientRoutes from './client.routes.js';
import notificationRoutes from './notification.routes.js';
import { authenticate, requireRole } from '../middlewares/auth.middleware.js';
import { getPublicConfig } from '../controllers/auth.controller.js';
import { getRedisStatus } from '../config/redis.js';
import { inboundEmailWebhook } from '../controllers/order-import.controller.js';

const apiRouter = Router();

apiRouter.get('/health', (req, res) => {
  res.status(200).json({
    status: 'ok',
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
    services: { redis: getRedisStatus() },
  });
});

apiRouter.get('/config', getPublicConfig);

// Inbound-mail provider webhook (forwarded brand emails) — authenticated by a shared secret, not a user token
apiRouter.post('/inbound/email', inboundEmailWebhook);

apiRouter.use('/auth', authRoutes);
apiRouter.use('/notifications', authenticate, notificationRoutes);
// Pending staff sign-ups keep role 'customer' until approved, but must not use the customer app
const notPendingStaff = (req, res, next) =>
  req.profile?.requested_role
    ? res.status(403).json({ success: false, statusCode: 403, message: 'This is a staff account awaiting approval. Use the admin / partner portal.' })
    : next();
apiRouter.use('/client', authenticate, requireRole('customer'), notPendingStaff, clientRoutes);
// Staff areas: the partner (or the admin) must be active and a temporary password must have been replaced
const staffGate = (req, res, next) => {
  if (req.profile?.must_change_password) {
    return res.status(403).json({ success: false, statusCode: 403, code: 'PASSWORD_CHANGE_REQUIRED', message: 'Choose your own password before you continue.' });
  }
  if (req.userRole === 'partner_staff' && (!req.access?.partner || req.access.partner.status !== 'active')) {
    return res.status(403).json({ success: false, statusCode: 403, message: 'Your partner account is switched off. Contact the platform admin.' });
  }
  next();
};
apiRouter.use('/partner', authenticate, requireRole('partner_staff', 'admin'), staffGate, partnerRoutes);
apiRouter.use('/admin', authenticate, requireRole('admin'), staffGate, adminRoutes);

export default apiRouter;
