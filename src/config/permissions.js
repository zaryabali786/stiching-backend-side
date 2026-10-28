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
  { id: 'messages', label: 'Messages', description: 'Chat with customers about the articles of the partner’s own orders', actions: ['view', 'update'] },
  { id: 'general_messages', label: 'General messages', description: 'Customer chats about the order itself (not tied to one article). Admin only unless the admin enables it', actions: ['view', 'update'] },
  { id: 'catalogue', label: 'Catalogue', description: 'Brands, couriers, article types and articles', actions: ['view', 'update'] },
  { id: 'users', label: 'Users', description: 'Create and manage the partner’s own users', actions: ['view', 'create', 'update'] },
  { id: 'notifications', label: 'Notification Center', description: 'Send notifications to the partner’s own staff', actions: ['view', 'update'] },
];

/**
 * Detailed actions: one tick per button. `<module>.update` still means "every change in this module": holding it brings every
 * detailed action of that module with it (see expandPermissions), so existing users and partner modules keep working.
 * A role that ticks single actions gives exactly those, and the server checks the matching action on every route.
 */
export const PARTNER_ACTION_DETAIL = {
  receiving: [
    { id: 'receive', label: 'Receive parcels and articles', description: 'Weigh, receive, receive all, add parcel photos' },
    { id: 'issue', label: 'Report an issue', description: 'Report a problem found on an article' },
    { id: 'returns', label: 'Returns and corrected articles', description: 'Book return CN, route, loadsheet, tracking, sent back, receive corrected' },
    { id: 'unmatched', label: 'Unmatched parcels', description: 'Add or edit parcels that have no order yet' },
  ],
  production: [
    { id: 'assign', label: 'Assign and edit job cards', description: 'Assign a master or tailor, due date, priority' },
    { id: 'move', label: 'Move between stages', description: 'Move an article to the next stage on the board' },
    { id: 'scan', label: 'Scan QR (receive and complete)', description: 'Receive and complete articles by scanning their QR code' },
    { id: 'comment', label: 'Comments and customer questions', description: 'Write on the job card and ask the customer' },
    { id: 'extras', label: 'Extra items', description: 'Add, edit or remove extra material costs' },
  ],
  quality: [
    { id: 'pass', label: 'Pass or fail quality check', description: 'Tick the checklist, pass or send back to stitching' },
    { id: 'approval', label: 'Send photos for approval', description: 'Ask the customer to approve finished photos' },
    { id: 'pack', label: 'Pressing and packing', description: 'Send the order to pressing and pack it' },
    { id: 'scan', label: 'Scan QR (quality check)', description: 'Receive and complete articles in quality check by scanning' },
  ],
  notifications: [
    { id: 'create', label: 'Create notifications', description: 'Write a notification for your own staff' },
    { id: 'send', label: 'Send notifications now', description: 'Send to your own staff immediately' },
    { id: 'schedule', label: 'Schedule notifications', description: 'Choose a future date and time' },
    { id: 'edit', label: 'Edit pending scheduled notifications', description: 'Change a notification that has not been sent yet' },
    { id: 'cancel', label: 'Cancel pending scheduled notifications', description: 'Stop a notification that has not been sent yet' },
    { id: 'urgent', label: 'Send urgent notifications', description: 'Mark a notification as urgent' },
    { id: 'image', label: 'Attach images', description: 'Add a picture to a notification' },
    { id: 'history', label: 'View notification history', description: 'See what your team has sent' },
    { id: 'status', label: 'View delivery status', description: 'See who received it and what failed' },
  ],
  warehouse: [
    { id: 'book', label: 'Weight, route and book CN', description: 'Set weight and route, book or cancel a courier CN, bulk book' },
    { id: 'loadsheet', label: 'Loadsheets and handover', description: 'Create and download loadsheets, confirm handover to the courier' },
    { id: 'tracking', label: 'Tracking and returns', description: 'Refresh or edit tracking, mark received back' },
    { id: 'transfer', label: 'Transfers', description: 'Dispatch a transfer to the admin warehouse' },
  ],
};
const DETAIL_IDS = Object.fromEntries(Object.entries(PARTNER_ACTION_DETAIL).map(([m, list]) => [m, list.map((d) => `${m}.${d.id}`)]));

/** The catalogue the apps show: each module with its basic actions and its detailed ones. */
export const PARTNER_CATALOGUE = PARTNER_MODULES.map((m) => ({ ...m, detail: PARTNER_ACTION_DETAIL[m.id] || [] }));

export const ALL_PERMISSIONS = [...PARTNER_MODULES.flatMap((m) => [...m.actions.map((a) => `${m.id}.${a}`), ...(DETAIL_IDS[m.id] || [])])];
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
    // general chats are a part of Messages: without Messages there is nothing to open them from
    if (module === 'general_messages') out.add(`messages.${action === 'update' ? 'update' : 'view'}`).add('messages.view');
  }
  return ALL_PERMISSIONS.filter((p) => out.has(p)); // stable order
};

/** Permissions that open the "view" of a page, used for the first page a user lands on. */
export const LANDING_ORDER = ['overview', 'receiving', 'production', 'quality', 'warehouse', 'messages', 'teams', 'earnings', 'catalogue', 'users'];

/**
 * Every permission a list really gives: `<module>.update` brings every detailed action of that module, and any action brings `view`.
 * Used for the signed-in person, the partner's modules (the ceiling) and what a person may hand out.
 */
export const expandPermissions = (list) => {
  const out = new Set(list || []);
  for (const [module, ids] of Object.entries(DETAIL_IDS)) {
    if (out.has(`${module}.update`)) ids.forEach((id) => out.add(id));
    if (ids.some((id) => out.has(id))) out.add(`${module}.view`);
  }
  return ALL_PERMISSIONS.filter((p) => out.has(p));
};
