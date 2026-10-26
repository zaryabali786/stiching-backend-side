import express, { Router } from 'express';
import authRoutes from './auth.routes.js';
import adminRoutes from './admin.routes.js';
import partnerRoutes from './partner.routes.js';
import clientRoutes from './client.routes.js';
import notificationRoutes from './notification.routes.js';
import { authenticate, requireRole } from '../middlewares/auth.middleware.js';
import { adminModuleGate, partnerPortalGateForAdmins } from '../middlewares/admin-modules.middleware.js';
import { getPublicConfig } from '../controllers/auth.controller.js';
import { getRedisStatus } from '../config/redis.js';
import { pushEnabled } from '../services/push.service.js';
import { inboundEmailWebhook } from '../controllers/order-import.controller.js';
import { courierTrackingWebhook } from '../controllers/courier-webhook.controller.js';
import { getAtelierAddress, shopifyInstall, shopifyInstallCallback, shopifyLanding } from '../controllers/shopify.controller.js';
import { APP_ASSETS_DIR, getAppState, listAppOrders, markSetupStep, requireShopifySession, runSetupStep, saveAppSettings, serveApp } from '../controllers/shopify-app.controller.js';

const apiRouter = Router();

apiRouter.get('/health', (req, res) => {
  res.status(200).json({
    status: 'ok',
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
    services: { redis: getRedisStatus(), push: { enabled: pushEnabled() } },
  });
});

apiRouter.get('/config', getPublicConfig);

// Inbound-mail provider webhook (forwarded brand emails) — authenticated by a shared secret, not a user token
apiRouter.post('/inbound/email', inboundEmailWebhook);
// Courier tracking events of return parcels: authenticated by a shared secret
apiRouter.post('/webhooks/courier', courierTrackingWebhook);

// Shopify: a brand installs the app here; the product-page block reads the atelier address
apiRouter.get('/shopify', shopifyLanding);
apiRouter.get('/shopify/auth', shopifyInstall);
apiRouter.get('/shopify/auth/callback', shopifyInstallCallback);
apiRouter.get('/shopify/atelier', getAtelierAddress);
// Shopify: the Stitch&Ship page inside the brand's Shopify admin (the page, its files, and the calls it makes with Shopify's session token)
apiRouter.use('/shopify/app/assets', express.static(APP_ASSETS_DIR, { index: false, maxAge: '5m' }));
apiRouter.get(['/shopify/app', '/shopify/app/settings', '/shopify/app/orders', '/shopify/app/updates', '/shopify/app/help'], serveApp);
apiRouter.get('/shopify/embedded/state', requireShopifySession, getAppState);
apiRouter.put('/shopify/embedded/settings', requireShopifySession, saveAppSettings);
apiRouter.post('/shopify/embedded/setup/:step', requireShopifySession, runSetupStep);
apiRouter.put('/shopify/embedded/setup/:step/done', requireShopifySession, markSetupStep);
apiRouter.get('/shopify/embedded/orders', requireShopifySession, listAppOrders);

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
apiRouter.use('/partner', authenticate, requireRole('partner_staff', 'admin'), staffGate, partnerPortalGateForAdmins, partnerRoutes);
apiRouter.use('/admin', authenticate, requireRole('admin'), staffGate, adminModuleGate, adminRoutes);

export default apiRouter;
