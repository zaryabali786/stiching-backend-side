import { catchAsync, ApiResponse, BadRequestError } from '../utils/error.helper.js';
import { parseListQuery, sendPage } from '../utils/pagination.js';
import { PARTNER_CATALOGUE } from '../config/permissions.js';
import { accessPayload } from '../middlewares/auth.middleware.js';
import { listUsers, createUser, updateUser, resetPassword, deactivateUser, taggableTeamMembers, taggableUsers } from '../services/partner-users.service.js';
import { listRoles, createRole, updateRole, deleteRole } from '../services/roles.service.js';
import { expandPermissions } from '../config/permissions.js';
import { ForbiddenError } from '../utils/error.helper.js';

/**
 * The partner's own users. The partner is ALWAYS the caller's own (from the session); only an admin may
 * name another one with ?partner_id= (the admin portal uses /admin/partners/:id/users instead).
 */
const targetPartner = (req) => {
  if (!req.access.isAdmin) return req.partnerId;
  const id = req.query.partner_id || req.body?.partner_id || req.access.activePartnerId;
  if (!id) throw new BadRequestError('Choose a partner (partner_id).');
  return String(id);
};

const actorOf = (req) => ({ profile: req.profile, access: req.access });

/** GET /api/partner/access — who I am in the hierarchy, what I may use and what I may hand out */
export const getPartnerAccess = catchAsync(async (req, res) =>
  ApiResponse.success(res, {
    ...accessPayload(req.profile, req.access),
    modules: PARTNER_CATALOGUE,
    delegable: [...req.access.permissions],
  }));

/** GET /api/partner/users?search&page&limit */
export const listPartnerUsers = catchAsync(async (req, res) => {
  const q = parseListQuery(req, { defaultLimit: 20 });
  const { rows, total } = await listUsers(actorOf(req), targetPartner(req), { search: q.search, from: q.from, to: q.to, excludeTeam: false });
  return sendPage(res, rows, q, total);
});

/** POST /api/partner/users  body: { email, full_name, staff_type?: 'master'|'tailor'|'staff', phone?, job_title?, permissions: [...], password? } */
export const createPartnerUser = catchAsync(async (req, res) => {
  const { user, temporaryPassword } = await createUser(actorOf(req), targetPartner(req), req.body || {});
  return ApiResponse.created(res, { user, temporaryPassword }, `${user.full_name} can now sign in. Share the temporary password once; they must choose their own at first sign-in.`);
});

/** PATCH /api/partner/users/:id  body: { full_name?, phone?, job_title?, permissions?, is_active? } */
export const updatePartnerUser = catchAsync(async (req, res) => {
  const user = await updateUser(actorOf(req), targetPartner(req), req.params.id, req.body || {});
  return ApiResponse.success(res, user, 'User updated.');
});

/** POST /api/partner/users/:id/reset-password */
export const resetPartnerUserPassword = catchAsync(async (req, res) => {
  const { user, temporaryPassword } = await resetPassword(actorOf(req), targetPartner(req), req.params.id);
  return ApiResponse.success(res, { user, temporaryPassword }, 'New temporary password created. Share it once; they must choose their own at next sign-in.');
});

/** DELETE /api/partner/users/:id — switches the login off (history is kept) */
export const deactivatePartnerUser = catchAsync(async (req, res) => {
  const user = await deactivateUser(actorOf(req), targetPartner(req), req.params.id);
  return ApiResponse.success(res, user, `${user.full_name} can no longer sign in.`);
});

/** GET /api/partner/users/team-members?user_id= — the team members a login can be tagged with */
export const listTaggableTeamMembers = catchAsync(async (req, res) =>
  ApiResponse.success(res, await taggableTeamMembers(targetPartner(req), req.query.user_id ? String(req.query.user_id) : null)));

// ─────────────────────────────── Roles ───────────────────────────────

/** A role can only hold what the person making it holds themselves. */
const assertRoleWithin = (req, permissions) => {
  if (req.access.isAdmin || !Array.isArray(permissions)) return;
  const mine = new Set(req.access.permissions);
  const extra = expandPermissions(permissions).filter((p) => !mine.has(p));
  if (extra.length) throw new ForbiddenError(`You cannot give permissions you do not have yourself: ${extra.join(', ')}.`);
};

/** GET /api/partner/roles */
export const listPartnerRoles = catchAsync(async (req, res) => ApiResponse.success(res, await listRoles('partner', targetPartner(req))));

/** POST /api/partner/roles  body: { name, description?, permissions: ['production.assign', ...] } */
export const createPartnerRole = catchAsync(async (req, res) => {
  assertRoleWithin(req, req.body?.permissions);
  const role = await createRole('partner', targetPartner(req), req.body || {}, req.userId);
  return ApiResponse.created(res, role, `Role "${role.name}" created.`);
});

/** PATCH /api/partner/roles/:id */
export const updatePartnerRole = catchAsync(async (req, res) => {
  assertRoleWithin(req, req.body?.permissions);
  const { role, updated_users: users } = await updateRole('partner', targetPartner(req), req.params.id, req.body || {}, req.userId);
  return ApiResponse.success(res, role, users ? `Role saved. ${users} user${users === 1 ? '' : 's'} updated.` : 'Role saved.');
});

/** DELETE /api/partner/roles/:id — only a role nobody holds */
export const deletePartnerRole = catchAsync(async (req, res) => {
  const role = await deleteRole('partner', targetPartner(req), req.params.id, req.userId);
  return ApiResponse.success(res, null, `Role "${role.name}" removed.`);
});

/** GET /api/partner/teams/users?member_id= — users a team member can be linked to */
export const listTaggableUsers = catchAsync(async (req, res) =>
  ApiResponse.success(res, await taggableUsers(targetPartner(req), req.query.member_id ? String(req.query.member_id) : null)));
