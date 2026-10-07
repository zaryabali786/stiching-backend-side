import { catchAsync, ApiResponse, BadRequestError } from '../utils/error.helper.js';
import { parseListQuery, sendPage } from '../utils/pagination.js';
import { PARTNER_MODULES } from '../config/permissions.js';
import { accessPayload } from '../middlewares/auth.middleware.js';
import { listUsers, createUser, updateUser, resetPassword, deactivateUser } from '../services/partner-users.service.js';

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
    modules: PARTNER_MODULES,
    delegable: [...req.access.permissions],
  }));

/** GET /api/partner/users?search&page&limit */
export const listPartnerUsers = catchAsync(async (req, res) => {
  const q = parseListQuery(req, { defaultLimit: 20 });
  const { rows, total } = await listUsers(actorOf(req), targetPartner(req), { search: q.search, from: q.from, to: q.to });
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
