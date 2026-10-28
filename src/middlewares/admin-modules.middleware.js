import { ForbiddenError } from '../utils/error.helper.js';

/**
 * Restricted admins (profiles.permissions holds `admin.limited`) may only use the admin modules they were given.
 * Full admins pass every check. Fails closed: an API prefix that is not listed here is closed to restricted admins.
 */

// first path segment (second for /settings) -> admin module; `null` = open to every admin, `'*full*'` = full admins only
const MODULE_OF = {
  overview: 'overview', dashboard: 'overview',
  orders: 'orders', 'extra-costs': 'orders',
  invoices: 'invoices', warehouse: 'warehouse', customers: 'customers',
  partners: 'partners', permissions: 'partners',
  'price-items': 'price_list', 'shipping-rates': 'shipping', reports: 'reports', support: 'support',
  banners: 'app_builder', 'home-layout': 'app_builder',
  settings: 'settings', shopify: 'settings',
  'notification-center': 'notification_center',
  badges: null,
  users: '*full*', 'admin-modules': '*full*', roles: '*full*',
};

const moduleFor = (path) => {
  const [first, second] = String(path).split('/').filter(Boolean);
  if (first === 'settings' && second === 'portal-theme') return 'portal_theme';
  if (first === 'settings' && second === 'client-theme') return 'app_builder';
  return Object.prototype.hasOwnProperty.call(MODULE_OF, first) ? MODULE_OF[first] : '*full*';
};

/** /api/admin/* */
export const adminModuleGate = (req, res, next) => {
  const modules = req.access?.adminModules;
  if (!modules) return next(); // full admin
  const needed = moduleFor(req.path);
  if (needed === null) return next();
  if (needed === '*full*') return next(new ForbiddenError('Only a full admin can do this.'));
  if (!modules.has(needed)) return next(new ForbiddenError('You do not have access to this part of the admin portal.'));
  // the Notification Center checks its detailed actions (send, schedule, urgent, ...) itself, per request
  if (needed === 'notification_center') return next();
  // what they may do inside the module: view (GET), create and edit (POST, PUT, PATCH), delete (DELETE)
  const allowed = req.access.adminActions?.get(needed);
  const action = req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS' ? 'view' : req.method === 'DELETE' ? 'delete' : 'edit';
  if (allowed && !allowed.has(action)) {
    return next(new ForbiddenError(action === 'view' ? 'You cannot view this part of the admin portal.' : action === 'delete' ? 'You are not allowed to delete here.' : 'You can view this part of the admin portal but not change it.'));
  }
  return next();
};

// the chat endpoints of the shared (partner) API that the admin Messages page uses
const CHAT_PATH = /^\/(conversations|voice-upload|access|badges|orders\/[^/]+\/(summary|conversation|messages))/;

/** /api/partner/*: a restricted admin enters the partner portal only with "Partners & teams", or reaches the chat with "Messages". */
export const partnerPortalGateForAdmins = (req, res, next) => {
  const modules = req.access?.adminModules;
  if (!modules) return next();
  if (modules.has('partners')) return next();
  if (modules.has('messages') && CHAT_PATH.test(req.path)) return next();
  return next(new ForbiddenError('You do not have access to the partner portal.'));
};
