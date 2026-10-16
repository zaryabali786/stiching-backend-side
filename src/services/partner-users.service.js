import { randomBytes } from 'node:crypto';
import { supabaseAdmin } from '../config/supabase.js';
import UserModel from '../models/user.model.js';
import { invalidateProfile } from '../middlewares/auth.middleware.js';
import { BadRequestError, ConflictError, ForbiddenError, NotFoundError } from '../utils/error.helper.js';
import { unwrap } from '../utils/db.js';
import { ilikeAny } from '../utils/pagination.js';
import { normalizePermissions } from '../config/permissions.js';
import { loadPartner } from './access.service.js';
import { resolveRoleIds } from './roles.service.js';
import { roleIdsOf, withoutRoleMarks } from '../config/admin-modules.js';
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

export const STAFF_TYPES = ['master', 'tailor', 'qa', 'pressing', 'packing', 'staff'];

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
  if (withoutRoleMarks(target.permissions).some((p) => !mine.has(p))) throw new ForbiddenError('This user has access you do not have, so you cannot manage them.');
};

/** The user as the apps see it: their permissions without the role marks, the roles they hold and the team member they are tagged with. */
const shape = (row, viewerId, team = null) => ({
  ...row,
  permissions: withoutRoleMarks(row.permissions),
  role_ids: roleIdsOf(row.permissions),
  team_member: team,
  is_owner: row.partner_role === 'owner',
  is_me: row.id === viewerId,
});

const teamOf = async (partnerId, userIds) => {
  if (!userIds.length) return new Map();
  const rows = unwrap(await supabaseAdmin.from('team_members').select('id, name, role, user_id').eq('partner_id', partnerId).in('user_id', userIds));
  return new Map(rows.map((m) => [m.user_id, { id: m.id, name: m.name, role: m.role }]));
};

/**
 * Tag a login with ONE team member (or untag with null). One login per team member and one member per login.
 * The member's role decides what the person scans (master, tailor, quality check, pressing, packing).
 */
export const tagTeamMember = async (partnerId, userId, memberId) => {
  const now = new Date().toISOString();
  const { data: current } = await supabaseAdmin.from('team_members').select('id').eq('partner_id', partnerId).eq('user_id', userId);
  if (!memberId) {
    for (const m of current || []) await supabaseAdmin.from('team_members').update({ user_id: null, updated_at: now }).eq('id', m.id);
    await supabaseAdmin.from('profiles').update({ staff_type: 'staff', updated_at: now }).eq('id', userId);
    invalidateProfile(userId);
    return null;
  }
  const member = (await supabaseAdmin.from('team_members').select('id, name, role, user_id, is_active, partner_id').eq('id', memberId).maybeSingle()).data;
  if (!member || member.partner_id !== partnerId) throw new NotFoundError('Team member not found');
  if (!member.is_active) throw new BadRequestError(`${member.name} is no longer in the active team.`);
  if (member.user_id && member.user_id !== userId) throw new ConflictError(`${member.name} is already tagged with another user.`);
  for (const m of current || []) if (m.id !== member.id) await supabaseAdmin.from('team_members').update({ user_id: null, updated_at: now }).eq('id', m.id);
  unwrap(await supabaseAdmin.from('team_members').update({ user_id: userId, updated_at: now }).eq('id', member.id));
  unwrap(await supabaseAdmin.from('profiles').update({ staff_type: member.role, updated_at: now }).eq('id', userId));
  invalidateProfile(userId);
  return { id: member.id, name: member.name, role: member.role };
};

/** Active team members that are not tagged with a login yet (plus the one already tagged with `userId`). */
export const taggableTeamMembers = async (partnerId, userId = null) => {
  const rows = unwrap(await supabaseAdmin.from('team_members').select('id, name, role, user_id').eq('partner_id', partnerId).eq('is_active', true).order('name'));
  return rows.filter((m) => !m.user_id || m.user_id === userId).map((m) => ({ id: m.id, name: m.name, role: m.role }));
};

/** @param {{ profile: object, access: import('./access.service.js').Access }} actor */
export const listUsers = async (actor, partnerId, { search, from, to, activeOnly = false, excludeTeam = false }) => {
  // a team person's login (given on the Teams page) belongs to Teams, not to the partner's own users
  const teamLogins = excludeTeam
    ? unwrap(await supabaseAdmin.from('team_members').select('user_id').eq('partner_id', partnerId).not('user_id', 'is', null)).map((t) => t.user_id)
    : [];
  let query = supabaseAdmin
    .from('profiles')
    .select(USER_COLUMNS, { count: 'exact' })
    .eq('role', 'partner_staff')
    .eq('partner_id', partnerId)
    .order('partner_role', { ascending: false }) // 'owner' sorts after 'member', so this lists the owner first
    .order('full_name', { ascending: true })
    .range(from, to);
  if (activeOnly) query = query.eq('is_active', true);
  if (teamLogins.length) query = query.not('id', 'in', `(${teamLogins.join(',')})`);
  if (search) query = query.or(ilikeAny(['full_name', 'email', 'job_title'], search));
  const result = await query;
  const raw = unwrap(result, 'Could not load users');
  const team = await teamOf(partnerId, raw.map((r) => r.id));
  const rows = raw.map((r) => shape(r, actor.profile.id, team.get(r.id) || null));
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
  if (!owner && body.role_ids !== undefined) {
    // everything comes from the roles: the user holds exactly what their roles give
    const resolved = await resolveRoleIds('partner', partnerId, body.role_ids);
    assertSubset(withoutRoleMarks(resolved.stored), actor);
    permissions = resolved.stored;
  } else if (!owner) {
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
      must_change_password: body.must_change_password !== false,
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
  let team = null;
  if (!owner && body.team_member_id) {
    try {
      team = await tagTeamMember(partnerId, created.id, body.team_member_id);
    } catch (err) {
      // do not leave a half-made login behind
      await supabaseAdmin.from('profiles').delete().eq('id', created.id);
      await supabaseAdmin.auth.admin.deleteUser(created.id).catch(() => {});
      throw err;
    }
  }
  await notifyUser(created.id, { type: 'update', title: `Welcome to ${partner.name}`, body: 'Your account is ready. Please set your own password.', link: '/partner/overview' });
  return { user: shape(row, actor.profile.id, team), temporaryPassword: password };
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
  if (body.role_ids !== undefined) {
    if (target.partner_role === 'owner') throw new BadRequestError('The owner always has every module of the partner.');
    const resolved = await resolveRoleIds('partner', partnerId, body.role_ids);
    assertSubset(withoutRoleMarks(resolved.stored), actor);
    patch.permissions = resolved.stored;
  } else if (body.permissions !== undefined) {
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
  const retag = body.team_member_id !== undefined && target.partner_role !== 'owner';
  if (!Object.keys(patch).length && !retag) throw new BadRequestError('Nothing to update.');

  const row = !Object.keys(patch).length ? target : unwrap(
    await supabaseAdmin.from('profiles').update({ ...patch, updated_at: new Date().toISOString() }).eq('id', target.id).select(USER_COLUMNS).single(),
    'Could not update the user'
  );
  invalidateProfile(target.id);
  const team = retag ? await tagTeamMember(partnerId, target.id, body.team_member_id || null) : (await teamOf(partnerId, [target.id])).get(target.id) || null;
  if (patch.permissions) await notifyUser(target.id, { type: 'update', title: 'Your access was updated', body: 'Your permissions changed. Pages you can no longer use have been removed from your menu.', link: '/partner/overview' });
  return shape(row, actor.profile.id, team);
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

/**
 * Users (logins) of the partner that a team member can be linked to: active, not the owner, not already linked to another
 * team member. `memberId` keeps the user the member has now in the list (editing).
 */
export const taggableUsers = async (partnerId, memberId = null) => {
  const users = unwrap(await supabaseAdmin.from('profiles').select('id, full_name, email, job_title, partner_role').eq('role', 'partner_staff').eq('partner_id', partnerId).eq('is_active', true).order('full_name'));
  const linked = unwrap(await supabaseAdmin.from('team_members').select('id, user_id').eq('partner_id', partnerId).not('user_id', 'is', null));
  const taken = new Set(linked.filter((m) => m.id !== memberId).map((m) => m.user_id));
  return users.filter((u) => u.partner_role !== 'owner' && !taken.has(u.id)).map((u) => ({ id: u.id, full_name: u.full_name, email: u.email, job_title: u.job_title }));
};

/** Link a team member to an existing user, change the user, or unlink (null). The user's staff type follows the member's role. */
export const setMemberUser = async (partnerId, memberId, userId) => {
  const member = (await supabaseAdmin.from('team_members').select('id, user_id, partner_id').eq('id', memberId).maybeSingle()).data;
  if (!member || member.partner_id !== partnerId) throw new NotFoundError('Team member not found');
  if (member.user_id && member.user_id !== userId) {
    unwrap(await supabaseAdmin.from('team_members').update({ user_id: null, updated_at: new Date().toISOString() }).eq('id', memberId));
    unwrap(await supabaseAdmin.from('profiles').update({ staff_type: 'staff', updated_at: new Date().toISOString() }).eq('id', member.user_id));
    invalidateProfile(member.user_id);
  }
  if (!userId) return null;
  const user = (await supabaseAdmin.from('profiles').select('id, role, partner_id, partner_role, is_active').eq('id', userId).maybeSingle()).data;
  if (!user || user.role !== 'partner_staff' || user.partner_id !== partnerId) throw new NotFoundError('User not found');
  if (user.partner_role === 'owner') throw new BadRequestError('The owner cannot be a team member.');
  if (!user.is_active) throw new BadRequestError('That user is switched off.');
  const other = (await supabaseAdmin.from('team_members').select('name').eq('user_id', userId).neq('id', memberId).maybeSingle()).data;
  if (other) throw new ConflictError(`That user is already ${other.name}. One user can be one team member.`);
  return tagTeamMember(partnerId, userId, memberId);
};
