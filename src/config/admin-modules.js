/**
 * The modules of the ADMIN portal that a restricted admin-side user can be given.
 *
 *   Full admin        no `admin.limited` marker in profiles.permissions: every module, plus user management (all existing admins)
 *   Restricted admin  profiles.permissions holds `admin.limited` plus one `admin.<module>` per module they may use
 *
 * User management (creating admin users, changing their modules, promoting customers) is never delegable: full admins only.
 * Keep the labels in step with the sidebar of the admin app (layout/portal-shell.component.ts).
 */
export const ADMIN_MODULES = [
  { id: 'overview', label: 'Overview', description: 'Dashboard figures' },
  { id: 'orders', label: 'Orders', description: 'All orders, issues, partner assignment, extra costs' },
  { id: 'messages', label: 'Messages', description: 'Customer chats about orders' },
  { id: 'support', label: 'Support chat', description: 'General support conversations' },
  { id: 'warehouse', label: 'Warehouse', description: 'Admin warehouse: parcels, transfers, labels and handover' },
  { id: 'invoices', label: 'Invoices', description: 'Build and issue invoices, payments' },
  { id: 'reports', label: 'Reports', description: 'Revenue and order reports' },
  { id: 'customers', label: 'Customers', description: 'Customer list and details' },
  { id: 'partners', label: 'Partners & teams', description: 'Partners, their modules and their users; the partner portal' },
  { id: 'price_list', label: 'Price list', description: 'Stitching and extra price items' },
  { id: 'shipping', label: 'Shipping rates', description: 'Courier zones and rates' },
  { id: 'settings', label: 'Settings', description: 'Ship-to address, priority & fast, PostEx and own account (not user management)' },
  { id: 'app_builder', label: 'App build & theme', description: 'Customer app layout, banners and theme' },
  { id: 'portal_theme', label: 'Portal theme', description: 'Look of the admin and partner portals' },
];

export const ADMIN_LIMITED = 'admin.limited';
const IDS = new Set(ADMIN_MODULES.map((m) => m.id));
export const isAdminModule = (id) => IDS.has(id);

/**
 * What a person may do inside an admin module. The server checks it on every request of that module:
 * view = reading (GET), edit = creating and changing (POST, PUT, PATCH), delete = removing (DELETE).
 * Ticking edit or delete always brings view.
 */
export const ADMIN_ACTIONS = [
  { id: 'view', label: 'View', description: 'Open the pages and read the data' },
  { id: 'edit', label: 'Create and edit', description: 'Add new items, change existing ones, press the action buttons' },
  { id: 'delete', label: 'Delete', description: 'Remove items' },
];
const ACTION_IDS = new Set(ADMIN_ACTIONS.map((a) => a.id));
export const ADMIN_PERMISSIONS = ADMIN_MODULES.flatMap((m) => ADMIN_ACTIONS.map((a) => `${m.id}.${a.id}`));

/** Marks a login that was given a role (the role's id). The effective permissions are saved next to the marks. */
export const ROLE_MARK = 'role:';
export const roleIdsOf = (stored) => (Array.isArray(stored) ? stored : []).filter((p) => typeof p === 'string' && p.startsWith(ROLE_MARK)).map((p) => p.slice(ROLE_MARK.length));
export const withoutRoleMarks = (stored) => (Array.isArray(stored) ? stored : []).filter((p) => !(typeof p === 'string' && p.startsWith(ROLE_MARK)));

/** { moduleId: Set(actions) } of a restricted admin, or null for a full admin. `admin.<module>` alone (older users) means every action. */
export const adminActionsOf = (profile) => {
  if (profile?.role !== 'admin') return null;
  const stored = Array.isArray(profile.permissions) ? profile.permissions : [];
  if (!stored.includes(ADMIN_LIMITED)) return null;
  const map = new Map();
  for (const p of stored) {
    if (!p.startsWith('admin.') || p === ADMIN_LIMITED) continue;
    const [module, action] = p.slice(6).split('.');
    if (!IDS.has(module)) continue;
    const set = map.get(module) || new Set();
    if (!action) ADMIN_ACTIONS.forEach((a) => set.add(a.id));
    else if (ACTION_IDS.has(action)) set.add(action);
    map.set(module, set);
  }
  for (const set of map.values()) if (set.size) set.add('view');
  return map;
};

/** The restricted admin's modules, or null for a full admin. */
export const adminModulesOf = (profile) => {
  const map = adminActionsOf(profile);
  return map ? [...map.keys()].filter((id) => map.get(id).size) : null;
};

/** The stored permission list of a restricted admin with these modules (every action of each). */
export const toStoredAdminPermissions = (modules) => [ADMIN_LIMITED, ...modules.map((id) => `admin.${id}`)];

/** The stored permission list for a list of `<module>.<action>` (what a role holds). */
export const toStoredFromRole = (permissions) => [ADMIN_LIMITED, ...permissions.map((p) => `admin.${p}`)];
