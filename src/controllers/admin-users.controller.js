import { supabaseAdmin } from '../config/supabase.js';
import UserModel from '../models/user.model.js';
import { invalidateProfile } from '../middlewares/auth.middleware.js';
import { catchAsync, ApiResponse, BadRequestError, ConflictError, ForbiddenError, NotFoundError } from '../utils/error.helper.js';
import { unwrap } from '../utils/db.js';
import { ADMIN_MODULES, ADMIN_ACTIONS, ADMIN_LIMITED, isAdminModule, adminModulesOf, adminActionsOf, roleIdsOf, toStoredAdminPermissions } from '../config/admin-modules.js';
import { listRoles, createRole, updateRole, deleteRole, resolveRoleIds } from '../services/roles.service.js';
import { temporaryPassword } from '../services/partner-users.service.js';
import { notifyUser } from '../services/notification.service.js';

/**
 * Admin-side users: logins with role `admin` that may use only the admin modules they were given.
 * Everything here is for FULL admins only (the gate in middlewares/admin-modules.middleware.js closes /users and /admin-modules to
 * restricted admins). A new user never gets full access by default: modules are chosen, or "full access" is switched on explicitly.
 */

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const COLUMNS = 'id, email, role, full_name, phone, job_title, customer_code, permissions, is_active, must_change_password, created_at';

const clean = (value, label, max, required = false) => {
  const text = String(value ?? '').trim();
  if (required && !text) throw new BadRequestError(`${label} is required.`);
  if (text.length > max) throw new BadRequestError(`${label} is too long (max ${max} characters).`);
  return text || null;
};

/** Only real, unique module ids; at least one when the user is restricted. */
const cleanModules = (list) => {
  if (!Array.isArray(list)) throw new BadRequestError('Choose the modules this user may use.');
  const bad = list.filter((id) => typeof id !== 'string' || !isAdminModule(id));
  if (bad.length) throw new BadRequestError(`Unknown module: ${bad.map(String).join(', ')}.`);
  const modules = [...new Set(list)];
  if (!modules.length) throw new BadRequestError('Choose at least one module, or give the user full admin access.');
  return modules;
};

export const accessOf = (row) => {
  const modules = adminModulesOf(row);
  const actions = adminActionsOf(row);
  return {
    admin_access: modules ? 'restricted' : 'full',
    admin_modules: modules,
    admin_actions: actions ? Object.fromEntries([...actions].map(([m, set]) => [m, [...set]])) : null,
    role_ids: roleIdsOf(row.permissions),
  };
};

const shape = (row) => {
  const { permissions: _p, ...rest } = row;
  return { ...rest, ...accessOf(row) };
};

/** GET /api/admin/admin-modules */
export const getAdminModules = catchAsync(async (req, res) => ApiResponse.success(res, ADMIN_MODULES));

/**
 * POST /api/admin/users
 * body: { full_name, email, password?, phone?, job_title?, modules?: string[], full_access?: boolean, must_change_password?: boolean }
 */
export const createAdminUser = catchAsync(async (req, res) => {
  const b = req.body || {};
  const email = clean(b.email, 'Email', 160, true).toLowerCase();
  if (!EMAIL.test(email)) throw new BadRequestError('Enter a valid email address.');
  const fullName = clean(b.full_name ?? b.fullName, 'Name', 100, true);
  const phone = clean(b.phone, 'Phone', 40);
  const jobTitle = clean(b.job_title ?? b.jobTitle, 'Role / designation', 60);
  const full = b.full_access === true;
  // roles: the user holds exactly what their roles give; otherwise the older "modules" list (every action of each module)
  const permissions = full ? [] : b.role_ids !== undefined ? (await resolveRoleIds('admin', null, b.role_ids)).stored : toStoredAdminPermissions(cleanModules(b.modules));
  if (!full && b.role_ids !== undefined && !permissions.some((p) => p.startsWith('admin.') && p !== ADMIN_LIMITED)) throw new BadRequestError('Choose at least one role, or give the user full admin access.');
  const password = b.password ? String(b.password) : temporaryPassword();
  if (password.length < 8) throw new BadRequestError('The password must be at least 8 characters.');

  if ((await supabaseAdmin.from('profiles').select('id').eq('email', email).maybeSingle()).data) {
    throw new ConflictError('An account with this email already exists.');
  }
  let created;
  try {
    created = await UserModel.create({ email, password, profile: { full_name: fullName, phone: phone ?? '' } });
  } catch (err) {
    if (/already|registered|exists/i.test(err?.message || '')) throw new ConflictError('An account with this email already exists.');
    throw err;
  }
  const { data: row, error } = await supabaseAdmin
    .from('profiles')
    .update({
      role: 'admin', permissions, job_title: jobTitle, partner_id: null, partner_role: null, staff_type: null, requested_role: null,
      created_by: req.userId, must_change_password: b.must_change_password !== false, updated_at: new Date().toISOString(),
    })
    .eq('id', created.id)
    .select(COLUMNS)
    .single();
  if (error) {
    await supabaseAdmin.auth.admin.deleteUser(created.id).catch(() => {});
    throw error;
  }
  invalidateProfile(created.id);
  await notifyUser(created.id, { type: 'update', title: 'Your admin account is ready', body: 'Sign in to the admin portal. You will be asked to choose your own password.', link: '/admin/overview' }).catch(() => {});
  return ApiResponse.created(res, { user: shape(row), temporaryPassword: password }, `${fullName} can now sign in to the admin portal.`);
});

const loadAdminTarget = async (req) => {
  if (req.params.id === req.userId) throw new ForbiddenError('You cannot change your own access.');
  const { data } = await supabaseAdmin.from('profiles').select(COLUMNS).eq('id', req.params.id).maybeSingle();
  if (!data || data.role !== 'admin') throw new NotFoundError('Admin user not found.');
  return data;
};

/** PATCH /api/admin/users/:id/access  body: { modules?: string[], full_access?: boolean, job_title?: string } */
export const setAdminUserAccess = catchAsync(async (req, res) => {
  const target = await loadAdminTarget(req);
  const b = req.body || {};
  const patch = { updated_at: new Date().toISOString() };
  if (b.job_title !== undefined || b.jobTitle !== undefined) patch.job_title = clean(b.job_title ?? b.jobTitle, 'Role / designation', 60);
  if (b.full_access === true) patch.permissions = [];
  else if (b.role_ids !== undefined) {
    const stored = (await resolveRoleIds('admin', null, b.role_ids)).stored;
    if (!stored.some((p) => p.startsWith('admin.') && p !== ADMIN_LIMITED)) throw new BadRequestError('Choose at least one role, or give the user full admin access.');
    patch.permissions = stored;
  } else if (b.modules !== undefined) patch.permissions = toStoredAdminPermissions(cleanModules(b.modules));
  else if (b.full_access === false) throw new BadRequestError('Choose the modules this user may use.');
  if (Object.keys(patch).length === 1) throw new BadRequestError('Nothing to update.');
  const row = unwrap(await supabaseAdmin.from('profiles').update(patch).eq('id', target.id).select(COLUMNS).single(), 'Could not update the user');
  invalidateProfile(target.id);
  await notifyUser(target.id, { type: 'update', title: 'Your access was updated', body: 'Your admin modules were changed. Reload the page if the menu looks out of date.', link: '/admin/overview' }).catch(() => {});
  return ApiResponse.success(res, shape(row), 'Access updated.');
});

/** POST /api/admin/users/:id/reset-password  body: { password? } — a new one-time password, to be changed at the next sign-in */
export const resetAdminUserPassword = catchAsync(async (req, res) => {
  const target = await loadAdminTarget(req);
  const password = req.body?.password ? String(req.body.password) : temporaryPassword();
  if (password.length < 8) throw new BadRequestError('The password must be at least 8 characters.');
  await UserModel.updatePassword(target.id, password);
  await supabaseAdmin.from('profiles').update({ must_change_password: true, updated_at: new Date().toISOString() }).eq('id', target.id);
  invalidateProfile(target.id);
  return ApiResponse.success(res, { temporaryPassword: password }, 'Password reset. The user must choose a new one at the next sign-in.');
});

export { ADMIN_LIMITED };

// ─────────────────────────────── Roles of the admin portal ───────────────────────────────

/** GET /api/admin/roles — the roles, plus the modules and actions a role is built from */
export const listAdminRoles = catchAsync(async (req, res) =>
  ApiResponse.success(res, { roles: await listRoles('admin', null), modules: ADMIN_MODULES, actions: ADMIN_ACTIONS }));

/** POST /api/admin/roles  body: { name, description?, permissions: ['orders.view', 'orders.edit', ...] } */
export const createAdminRole = catchAsync(async (req, res) => {
  const role = await createRole('admin', null, req.body || {}, req.userId);
  return ApiResponse.created(res, role, `Role "${role.name}" created.`);
});

/** PATCH /api/admin/roles/:id */
export const updateAdminRole = catchAsync(async (req, res) => {
  const { role, updated_users: users } = await updateRole('admin', null, req.params.id, req.body || {}, req.userId);
  return ApiResponse.success(res, role, users ? `Role saved. ${users} user${users === 1 ? '' : 's'} updated.` : 'Role saved.');
});

/** DELETE /api/admin/roles/:id */
export const deleteAdminRole = catchAsync(async (req, res) => {
  const role = await deleteRole('admin', null, req.params.id, req.userId);
  return ApiResponse.success(res, null, `Role "${role.name}" removed.`);
});
