/**
 * Permission catalogue for the partner side of the platform.
 *
 * A permission is `<module>.<action>`. Modules mirror the pages of the partner portal; `update` covers every
 * change in that module (create, edit, delete, move) and always comes together with `view`.
 *
 * Hierarchy:
 *   Admin      everything, always (admin-only areas such as invoices, customers, price list and settings are not delegable)
 *   Partner    only what the admin enabled for that partner  (partners.permissions)
 *   User       only what their partner granted, and never more than the partner has  (profiles.permissions)
 *
 * Keep the default list in migrations/0005_partners_rbac.sql in step with this file (scripts/e2e-rbac.mjs checks it).
 */
export const PARTNER_MODULES = [
  { id: 'overview', label: 'Overview', description: 'Dashboard with production and warehouse figures', actions: ['view'] },
  { id: 'receiving', label: 'Receiving', description: 'Receive parcels, report issues, unmatched parcels', actions: ['view', 'update'] },
  { id: 'production', label: 'Production', description: 'Production board and job cards, assign work', actions: ['view', 'update'] },
  { id: 'quality', label: 'Quality check', description: 'QC, send photos for approval, pack orders', actions: ['view', 'update'] },
  { id: 'warehouse', label: 'Warehouse', description: 'Dispatch route, direct shipping, transfers', actions: ['view', 'update'] },
  { id: 'teams', label: 'Teams', description: 'Masters and tailors, capacity', actions: ['view', 'update'] },
  { id: 'earnings', label: 'Earnings', description: 'What the partner earns per invoice', actions: ['view'] },
  { id: 'messages', label: 'Messages', description: 'Chat with customers', actions: ['view', 'update'] },
  { id: 'catalogue', label: 'Catalogue', description: 'Brands, couriers, article types and articles', actions: ['view', 'update'] },
  { id: 'users', label: 'Users', description: 'Create and manage the partner’s own users', actions: ['view', 'create', 'update'] },
];

export const ALL_PERMISSIONS = PARTNER_MODULES.flatMap((m) => m.actions.map((a) => `${m.id}.${a}`));
const PERMISSION_SET = new Set(ALL_PERMISSIONS);

export const isValidPermission = (p) => PERMISSION_SET.has(p);

/**
 * Clean a list sent by a client: only known permissions, no duplicates, and `update`/`create` always bring `view`.
 * @throws {Error} with `.unknown` when something is not a real permission
 */
export const normalizePermissions = (list) => {
  if (!Array.isArray(list)) throw Object.assign(new Error('Permissions must be a list.'), { unknown: [] });
  const unknown = list.filter((p) => typeof p !== 'string' || !PERMISSION_SET.has(p));
  if (unknown.length) throw Object.assign(new Error(`Unknown permission: ${unknown.map(String).join(', ')}`), { unknown });
  const out = new Set(list);
  for (const p of list) {
    const [module, action] = p.split('.');
    if (action !== 'view') out.add(`${module}.view`);
  }
  return ALL_PERMISSIONS.filter((p) => out.has(p)); // stable order
};

/** Permissions that open the "view" of a page, used for the first page a user lands on. */
export const LANDING_ORDER = ['overview', 'receiving', 'production', 'quality', 'warehouse', 'messages', 'teams', 'earnings', 'catalogue', 'users'];
