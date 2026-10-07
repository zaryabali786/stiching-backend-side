import { randomBytes } from 'node:crypto';
import { supabaseAdmin } from '../config/supabase.js';
import UserModel from '../models/user.model.js';
import { invalidateProfile } from '../middlewares/auth.middleware.js';
import { BadRequestError, ConflictError, ForbiddenError, NotFoundError } from '../utils/error.helper.js';
import { unwrap } from '../utils/db.js';
import { ilikeAny } from '../utils/pagination.js';
import { normalizePermissions } from '../config/permissions.js';
import { loadPartner } from './access.service.js';
import { notifyUser } from './notification.service.js';

/**
 * Logins that belong to a partner: the owner (created by the admin together with the partner) and the partner's
 * own users such as master tailors, tailors and other staff (created by the owner or by a user who may create users).
 *
 * Rules enforced here, whoever calls:
 *  - a user always belongs to exactly one partner, taken from the caller's session (or the partner the admin chose)
 *  - permissions can only be a subset of what the creator holds, which is itself a subset of the partner's modules
 *  - nobody can edit themselves into more access, and a non-owner cannot touch the owner or a more privileged user
 *  - logins are created with a temporary password that must be changed on first sign-in
 */

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const USER_COLUMNS = 'id, email, role, full_name, phone, job_title, staff_type, partner_id, partner_role, permissions, is_active, must_change_password, created_at';

/** A readable one-time password (shown once to whoever creates the login). */
export const temporaryPassword = () => randomBytes(9).toString('base64url');

const cleanText = (value, label, max, required = false) => {
  const text = String(value ?? '').trim();
  if (required && !text) throw new BadRequestError(`${label} is required.`);
  if (text.length > max) throw new BadRequestError(`${label} is too long (max ${max} characters).`);
  return text || null;
};

export const STAFF_TYPES = ['master', 'tailor', 'staff'];

const cleanStaffType = (value) => {
  const type = String(value ?? 'staff').trim().toLowerCase();
  if (!STAFF_TYPES.includes(type)) throw new BadRequestError(`Type must be one of: ${STAFF_TYPES.join(', ')}.`);
  return type;
};

const cleanPermissions = (list) => {
  try {
    return normalizePermissions(list ?? []);
  } catch (err) {
    throw new BadRequestError(err.message);
  }
};

/** The permissions the caller may hand out: everything for an admin, otherwise what they themselves hold. */
const grantable = (actor) => (actor.access.isAdmin ? null : actor.access.permissions);

const assertSubset = (permissions, actor) => {
  const allowed = grantable(actor);
  if (!allowed) return;
  const extra = permissions.filter((p) => !allowed.has(p));
  if (extra.length) throw new ForbiddenError(`You cannot give permissions you do not have yourself: ${extra.join(', ')}.`);
};

const assertWithinPartner = (permissions, partner) => {
  const ceiling = new Set(partner.permissions || []);
  const extra = permissions.filter((p) => !ceiling.has(p));
  if (extra.length) throw new BadRequestError(`This partner has not been given: ${extra.join(', ')}. Ask the admin to enable those modules first.`);
};

/** Can `actor` manage this person? */
const assertCanManage = (actor, target) => {
  if (actor.access.isAdmin) return;
  if (target.id === actor.profile.id) throw new ForbiddenError('You cannot change your own access. Ask the owner or an admin.');
  if (target.partner_id !== actor.access.partnerId) throw new ForbiddenError('This user belongs to another partner.');
  if (actor.profile.partner_role === 'owner') return;
  if (target.partner_role === 'owner') throw new ForbiddenError('Only an admin can change the partner owner.');
  const mine = actor.access.permissions;
  if ((target.permissions || []).some((p) => !mine.has(p))) throw new ForbiddenError('This user has access you do not have, so you cannot manage them.');
};

const shape = (row, viewerId) => ({
  ...row,
  is_owner: row.partner_role === 'owner',
  is_me: row.id === viewerId,
});

/** @param {{ profile: object, access: import('./access.service.js').Access }} actor */
export const listUsers = async (actor, partnerId, { search, from, to, activeOnly = false }) => {
  let query = supabaseAdmin
    .from('profiles')
    .select(USER_COLUMNS, { count: 'exact' })
    .eq('role', 'partner_staff')
    .eq('partner_id', partnerId)
    .order('partner_role', { ascending: false }) // 'owner' sorts after 'member', so this lists the owner first
    .order('full_name', { ascending: true })
    .range(from, to);
  if (activeOnly) query = query.eq('is_active', true);
  if (search) query = query.or(ilikeAny(['full_name', 'email', 'job_title'], search));
  const result = await query;
  const rows = unwrap(result, 'Could not load users').map((r) => shape(r, actor.profile.id));
  return { rows, total: result.count };
};

const loadTarget = async (partnerId, userId) => {
  const { data } = await supabaseAdmin.from('profiles').select(USER_COLUMNS).eq('id', userId).maybeSingle();
  if (!data || data.role === 'admin' || data.partner_id !== partnerId || !data.partner_id) throw new NotFoundError('User not found');
  return data;
};

/**
 * Create a login. `owner: true` is only for the admin creating a partner.
 * @returns {{ user: object, temporaryPassword: string }}
 */
export const createUser = async (actor, partnerId, body, { owner = false } = {}) => {
  const partner = await loadPartner(partnerId);
  if (!partner) throw new NotFoundError('Partner not found');
  if (partner.status !== 'active' && !owner) throw new BadRequestError('This partner is switched off.');

  const email = cleanText(body.email, 'Email', 160, true).toLowerCase();
  if (!EMAIL.test(email)) throw new BadRequestError('Enter a valid email address.');
  const fullName = cleanText(body.full_name ?? body.fullName, 'Name', 100, true);
  const phone = cleanText(body.phone, 'Phone', 40);
  const jobTitle = cleanText(body.job_title ?? body.jobTitle, 'Job title', 60);

  const staffType = owner ? null : cleanStaffType(body.staff_type ?? body.staffType);
  let permissions = [];
  if (!owner) {
    permissions = cleanPermissions(body.permissions);
    assertWithinPartner(permissions, partner);
    assertSubset(permissions, actor);
  }

  const password = body.password ? String(body.password) : temporaryPassword();
  if (password.length < 8) throw new BadRequestError('The password must be at least 8 characters.');

  const existing = await supabaseAdmin.from('profiles').select('id').eq('email', email).maybeSingle();
  if (existing.data) throw new ConflictError('An account with this email already exists.');

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
      role: 'partner_staff',
      partner_id: partnerId,
      partner_role: owner ? 'owner' : 'member',
      permissions,
      job_title: jobTitle || (owner ? 'Owner' : staffType === 'master' ? 'Master Tailor' : staffType === 'tailor' ? 'Tailor' : null),
      staff_type: staffType,
      created_by: actor.profile.id,
      must_change_password: true,
      requested_role: null,
      updated_at: new Date().toISOString(),
    })
    .eq('id', created.id)
    .select(USER_COLUMNS)
    .single();
  if (error) {
    await supabaseAdmin.auth.admin.deleteUser(created.id).catch(() => {});
    throw error;
  }
  invalidateProfile(created.id);
  await notifyUser(created.id, { type: 'update', title: `Welcome to ${partner.name}`, body: 'Your account is ready. Please set your own password.', link: '/partner/overview' });
  return { user: shape(row, actor.profile.id), temporaryPassword: password };
};

/** Change name, phone, title, permissions or active state of a partner user. */
export const updateUser = async (actor, partnerId, userId, body) => {
  const partner = await loadPartner(partnerId);
  if (!partner) throw new NotFoundError('Partner not found');
  const target = await loadTarget(partnerId, userId);
  assertCanManage(actor, target);

  const patch = {};
  if (body.full_name !== undefined || body.fullName !== undefined) patch.full_name = cleanText(body.full_name ?? body.fullName, 'Name', 100, true);
  if (body.phone !== undefined) patch.phone = cleanText(body.phone, 'Phone', 40) ?? '';
  if (body.job_title !== undefined || body.jobTitle !== undefined) patch.job_title = cleanText(body.job_title ?? body.jobTitle, 'Job title', 60);
  if (body.staff_type !== undefined || body.staffType !== undefined) {
    if (target.partner_role === 'owner') throw new BadRequestError('The owner has no staff type.');
    patch.staff_type = cleanStaffType(body.staff_type ?? body.staffType);
  }
  if (body.permissions !== undefined) {
    if (target.partner_role === 'owner') throw new BadRequestError('The owner always has every module of the partner. Change the partner’s modules instead.');
    const permissions = cleanPermissions(body.permissions);
    assertWithinPartner(permissions, partner);
    assertSubset(permissions, actor);
    patch.permissions = permissions;
  }
  if (body.is_active !== undefined) {
    if (target.partner_role === 'owner' && !actor.access.isAdmin) throw new ForbiddenError('Only an admin can switch the partner owner off.');
    patch.is_active = !!body.is_active;
  }
  if (!Object.keys(patch).length) throw new BadRequestError('Nothing to update.');

  const row = unwrap(
    await supabaseAdmin.from('profiles').update({ ...patch, updated_at: new Date().toISOString() }).eq('id', target.id).select(USER_COLUMNS).single(),
    'Could not update the user'
  );
  invalidateProfile(target.id);
  if (patch.permissions) await notifyUser(target.id, { type: 'update', title: 'Your access was updated', body: 'Your permissions changed. Pages you can no longer use have been removed from your menu.', link: '/partner/overview' });
  return shape(row, actor.profile.id);
};

/** A new temporary password (the old one stops working); the person must pick their own at next sign-in. */
export const resetPassword = async (actor, partnerId, userId) => {
  const target = await loadTarget(partnerId, userId);
  assertCanManage(actor, target);
  const password = temporaryPassword();
  await UserModel.updatePassword(target.id, password);
  unwrap(await supabaseAdmin.from('profiles').update({ must_change_password: true, updated_at: new Date().toISOString() }).eq('id', target.id));
  invalidateProfile(target.id);
  return { user: shape(target, actor.profile.id), temporaryPassword: password };
};

/** Switch a login off (history stays; the person can no longer sign in or use the API). */
export const deactivateUser = async (actor, partnerId, userId) => {
  const target = await loadTarget(partnerId, userId);
  assertCanManage(actor, target);
  if (target.partner_role === 'owner' && !actor.access.isAdmin) throw new ForbiddenError('Only an admin can switch the partner owner off.');
  unwrap(await supabaseAdmin.from('profiles').update({ is_active: false, updated_at: new Date().toISOString() }).eq('id', target.id));
  invalidateProfile(target.id);
  return shape({ ...target, is_active: false }, actor.profile.id);
};
