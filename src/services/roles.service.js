import { randomUUID } from 'node:crypto';
import { supabaseAdmin } from '../config/supabase.js';
import { normalizePermissions, ALL_PERMISSIONS } from '../config/permissions.js';
import { ADMIN_PERMISSIONS, ROLE_MARK, roleIdsOf, toStoredFromRole } from '../config/admin-modules.js';
import { BadRequestError, ConflictError, NotFoundError } from '../utils/error.helper.js';
import { invalidateProfile } from '../middlewares/auth.middleware.js';

/**
 * Roles: named sets of permissions that are given to users. Each portal keeps its own list.
 *   partner  one list per partner (platform_settings `roles:partner:<partner id>`), permissions are `<module>.<action>`
 *   admin    one list for the admin portal (`roles:admin`), permissions are `<admin module>.<view|edit|delete>`
 * A user may hold several roles; their permissions are the union of those roles and nothing else. The effective list is
 * saved in profiles.permissions together with a `role:<id>` mark per role, so every existing check keeps working unchanged.
 * Changing a role updates every user who holds it. A user without a role keeps the permissions they already had.
 */

const key = (kind, partnerId) => (kind === 'admin' ? 'roles:admin' : `roles:partner:${partnerId}`);

export const OWNER_ROLE = { id: 'owner', name: 'Owner', description: 'Every module the partner has. It cannot be changed or removed.', permissions: [], locked: true };

export const loadRoles = async (kind, partnerId) => {
  const { data } = await supabaseAdmin.from('platform_settings').select('value').eq('key', key(kind, partnerId)).maybeSingle();
  return Array.isArray(data?.value?.roles) ? data.value.roles : [];
};

const saveRoles = async (kind, partnerId, roles, userId) => {
  const { error } = await supabaseAdmin.from('platform_settings').upsert({ key: key(kind, partnerId), value: { roles }, updated_by: userId ?? null, updated_at: new Date().toISOString() });
  if (error) throw error;
};

const cleanText = (value, label, max, required = false) => {
  const text = String(value ?? '').trim();
  if (required && !text) throw new BadRequestError(`${label} is required.`);
  if (text.length > max) throw new BadRequestError(`${label} is too long (max ${max} characters).`);
  return text;
};

const cleanPermissionsFor = (kind, list) => {
  if (!Array.isArray(list)) throw new BadRequestError('Choose what this role may do.');
  if (kind === 'admin') {
    const valid = new Set(ADMIN_PERMISSIONS);
    const bad = list.filter((p) => !valid.has(p));
    if (bad.length) throw new BadRequestError(`Unknown permission: ${bad.join(', ')}.`);
    const out = new Set(list);
    for (const p of list) if (!p.endsWith('.view')) out.add(`${p.split('.')[0]}.view`);
    return ADMIN_PERMISSIONS.filter((p) => out.has(p));
  }
  try {
    return normalizePermissions(list);
  } catch (err) {
    throw new BadRequestError(err.message);
  }
};

/** Roles with how many users hold each. Partner lists start with the locked Owner role. */
export const listRoles = async (kind, partnerId) => {
  const roles = await loadRoles(kind, partnerId);
  let q = supabaseAdmin.from('profiles').select('permissions');
  q = kind === 'admin' ? q.eq('role', 'admin') : q.eq('role', 'partner_staff').eq('partner_id', partnerId);
  const { data } = await q;
  const counts = new Map();
  for (const row of data || []) for (const id of roleIdsOf(row.permissions)) counts.set(id, (counts.get(id) || 0) + 1);
  const owners = kind === 'partner' ? (await supabaseAdmin.from('profiles').select('id', { count: 'exact', head: true }).eq('partner_id', partnerId).eq('partner_role', 'owner')).count || 0 : 0;
  const list = roles.map((r) => ({ ...r, user_count: counts.get(r.id) || 0 }));
  return kind === 'partner' ? [{ ...OWNER_ROLE, user_count: owners }, ...list] : list;
};

const assertUniqueName = (roles, name, exceptId) => {
  if (roles.some((r) => r.id !== exceptId && r.name.toLowerCase() === name.toLowerCase())) throw new ConflictError(`A role called "${name}" already exists.`);
  if (name.toLowerCase() === 'owner') throw new ConflictError('"Owner" is a built-in role. Choose another name.');
};

/** The effective stored permission list of a user who holds these roles. */
export const permissionsFromRoles = (kind, roles, roleIds) => {
  const chosen = roleIds.map((id) => roles.find((r) => r.id === id)).filter(Boolean);
  const union = new Set(chosen.flatMap((r) => r.permissions));
  const marks = chosen.map((r) => `${ROLE_MARK}${r.id}`);
  if (kind === 'admin') return [...toStoredFromRole(ADMIN_PERMISSIONS.filter((p) => union.has(p))), ...marks];
  return [...ALL_PERMISSIONS.filter((p) => union.has(p)), ...marks];
};

export const createRole = async (kind, partnerId, input, userId) => {
  const roles = await loadRoles(kind, partnerId);
  const name = cleanText(input.name, 'Role name', 60, true);
  assertUniqueName(roles, name);
  const permissions = cleanPermissionsFor(kind, input.permissions);
  if (!permissions.length) throw new BadRequestError('Tick at least one thing this role may do.');
  const now = new Date().toISOString();
  const role = { id: randomUUID(), name, description: cleanText(input.description, 'Description', 200), permissions, created_at: now, updated_at: now };
  await saveRoles(kind, partnerId, [...roles, role], userId);
  return { ...role, user_count: 0 };
};

/** Rewrite the permissions of everyone who holds a role (after the role changed). */
const resyncHolders = async (kind, partnerId, roles, roleId) => {
  let q = supabaseAdmin.from('profiles').select('id, permissions').contains('permissions', [`${ROLE_MARK}${roleId}`]);
  q = kind === 'admin' ? q.eq('role', 'admin') : q.eq('role', 'partner_staff').eq('partner_id', partnerId);
  const { data } = await q;
  for (const row of data || []) {
    const ids = roleIdsOf(row.permissions).filter((id) => roles.some((r) => r.id === id));
    await supabaseAdmin.from('profiles').update({ permissions: permissionsFromRoles(kind, roles, ids), updated_at: new Date().toISOString() }).eq('id', row.id);
    invalidateProfile(row.id);
  }
  return (data || []).length;
};

export const updateRole = async (kind, partnerId, roleId, input, userId) => {
  if (roleId === OWNER_ROLE.id) throw new BadRequestError('The Owner role cannot be changed.');
  const roles = await loadRoles(kind, partnerId);
  const role = roles.find((r) => r.id === roleId);
  if (!role) throw new NotFoundError('Role not found');
  const next = { ...role, updated_at: new Date().toISOString() };
  if (input.name !== undefined) {
    next.name = cleanText(input.name, 'Role name', 60, true);
    assertUniqueName(roles, next.name, role.id);
  }
  if (input.description !== undefined) next.description = cleanText(input.description, 'Description', 200);
  if (input.permissions !== undefined) {
    next.permissions = cleanPermissionsFor(kind, input.permissions);
    if (!next.permissions.length) throw new BadRequestError('Tick at least one thing this role may do.');
  }
  const list = roles.map((r) => (r.id === role.id ? next : r));
  await saveRoles(kind, partnerId, list, userId);
  const holders = input.permissions !== undefined ? await resyncHolders(kind, partnerId, list, role.id) : 0;
  return { role: next, updated_users: holders };
};

export const deleteRole = async (kind, partnerId, roleId, userId) => {
  if (roleId === OWNER_ROLE.id) throw new BadRequestError('The Owner role cannot be removed.');
  const roles = await loadRoles(kind, partnerId);
  const role = roles.find((r) => r.id === roleId);
  if (!role) throw new NotFoundError('Role not found');
  const listed = (await listRoles(kind, partnerId)).find((r) => r.id === roleId);
  if (listed?.user_count) throw new ConflictError(`${listed.user_count} user${listed.user_count === 1 ? ' still has' : 's still have'} the role "${role.name}". Change their roles first.`);
  await saveRoles(kind, partnerId, roles.filter((r) => r.id !== roleId), userId);
  return role;
};

/** Validate role ids and return the stored permission list for them. */
export const resolveRoleIds = async (kind, partnerId, roleIds) => {
  if (!Array.isArray(roleIds)) throw new BadRequestError('Choose the roles for this user.');
  const roles = await loadRoles(kind, partnerId);
  const ids = [...new Set(roleIds.map(String))];
  if (ids.some((id) => !roles.some((r) => r.id === id))) throw new BadRequestError('One of the chosen roles no longer exists.');
  return { ids, stored: permissionsFromRoles(kind, roles, ids), roles: roles.filter((r) => ids.includes(r.id)) };
};
