import { supabaseAdmin } from '../config/supabase.js';
import { ALL_PERMISSIONS } from '../config/permissions.js';
import { BadRequestError, ForbiddenError, NotFoundError } from '../utils/error.helper.js';

/**
 * Who may do what. Authentication (who are you?) lives in auth.middleware; this is authorization:
 *
 *   admin           everything, every partner
 *   partner owner   the modules the admin enabled for the partner
 *   partner member  what the partner granted, limited to what the partner itself has
 *   customer        nothing on the staff side
 *
 * Everything is read from the database for the signed-in user. Nothing here ever trusts a role, partner id or
 * permission list sent by the browser.
 */

const PARTNER_TTL_MS = 15_000;
const partnerCache = new Map();

export const invalidatePartner = (partnerId) => partnerCache.delete(partnerId);

export const loadPartner = async (partnerId) => {
  if (!partnerId) return null;
  const cached = partnerCache.get(partnerId);
  if (cached && cached.expires > Date.now()) return cached.partner;
  const { data, error } = await supabaseAdmin.from('partners').select('*').eq('id', partnerId).maybeSingle();
  if (error) throw error;
  partnerCache.set(partnerId, { partner: data, expires: Date.now() + PARTNER_TTL_MS });
  return data;
};

/**
 * @typedef {object} Access
 * @property {boolean} isAdmin
 * @property {string|null} partnerId   null for admins and customers
 * @property {object|null} partner
 * @property {Set<string>} permissions  effective permissions (admins hold every one)
 */

/** @returns {Promise<Access>} */
export const resolveAccess = async (profile) => {
  if (!profile) return { isAdmin: false, partnerId: null, partner: null, permissions: new Set() };
  if (profile.role === 'admin') return { isAdmin: true, partnerId: null, partner: null, permissions: new Set(ALL_PERMISSIONS) };
  if (profile.role !== 'partner_staff' || !profile.partner_id) return { isAdmin: false, partnerId: null, partner: null, permissions: new Set() };

  const partner = await loadPartner(profile.partner_id);
  if (!partner || partner.status !== 'active') return { isAdmin: false, partnerId: profile.partner_id, partner, permissions: new Set() };

  const ceiling = new Set(partner.permissions || []);
  const granted = profile.partner_role === 'owner' ? [...ceiling] : (profile.permissions || []).filter((p) => ceiling.has(p));
  return { isAdmin: false, partnerId: profile.partner_id, partner, permissions: new Set(granted.filter((p) => ALL_PERMISSIONS.includes(p))) };
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Admin partner switcher: an admin may send `X-Partner-Id` to work inside one partner. The partner must exist; the
 * header is ignored for everybody else, so a partner user can never switch tenants by sending it.
 * @returns {Promise<Access>} the same access with `activePartnerId` / `activePartner` set
 */
export const withActivePartner = async (access, headerValue) => {
  const raw = Array.isArray(headerValue) ? headerValue[0] : headerValue;
  if (!access.isAdmin || !raw) return { ...access, activePartnerId: null, activePartner: null };
  if (!UUID.test(String(raw))) throw new BadRequestError('X-Partner-Id is not a valid partner id.');
  const partner = await loadPartner(String(raw));
  if (!partner) throw new NotFoundError('The selected partner no longer exists.');
  return { ...access, activePartnerId: partner.id, activePartner: partner };
};

/** The partner an admin has switched into (undefined when viewing every partner, and always undefined for non-admins). */
export const activePartnerOf = (access) => (access?.isAdmin ? access.activePartnerId || undefined : undefined);

/** Limit a query on `orders` (or any table with `partner_id`) to the admin's selected partner, if any. */
export const inActivePartner = (access, query, column = 'partner_id') => {
  const id = activePartnerOf(access);
  return id ? query.eq(column, id) : query;
};

export const can = (access, permission) => access.isAdmin || access.permissions.has(permission);
export const canAny = (access, permissions) => access.isAdmin || permissions.some((p) => access.permissions.has(p));

/** The partner whose data this request may touch, or `undefined` for an admin (all partners). */
export const scopeOf = (access) => (access.isAdmin ? access.activePartnerId || undefined : access.partnerId || NO_PARTNER);

/** A real UUID that no row has: a partner user without a partner (should not exist) sees nothing. */
export const NO_PARTNER = '00000000-0000-0000-0000-000000000000';

/** Restrict a Supabase query on a table that has a `partner_id` column to the caller's partner. */
export const scoped = (access, query, column = 'partner_id') => {
  const partnerId = scopeOf(access);
  return partnerId === undefined ? query : query.eq(column, partnerId);
};

/** Can this caller act on a row that belongs to `partnerId`? */
export const ownsPartnerRow = (access, partnerId) => access.isAdmin || (!!partnerId && partnerId === access.partnerId);

/** What the apps need after login: identity, hierarchy position and the effective permission list. */
export const accessPayload = (profile, access) => ({
  role: profile.role,
  partner_id: access.partnerId,
  partner: access.partner ? { id: access.partner.id, name: access.partner.name, status: access.partner.status } : null,
  partner_role: profile.partner_role || null,
  staff_type: profile.staff_type || null,
  permissions: [...access.permissions],
});

/**
 * The partner a newly created row (team member, parcel, ...) belongs to: the caller's own partner. An admin names one
 * (`partner_id` in the body) or, when they do not, the default partner.
 */
export const partnerForWrite = async (access, bodyPartnerId) => {
  if (!access.isAdmin) {
    if (!access.partnerId) throw new ForbiddenError('Your account is not linked to a partner.');
    return access.partnerId;
  }
  if (bodyPartnerId || access.activePartnerId) {
    const partner = await loadPartner(String(bodyPartnerId || access.activePartnerId));
    if (!partner) throw new NotFoundError('Partner not found');
    return partner.id;
  }
  const { data } = await supabaseAdmin.from('partners').select('id').eq('is_default', true).maybeSingle();
  if (!data) throw new BadRequestError('Choose which partner this is for (partner_id).');
  return data.id;
};

/** An order id taken from a request body: it must be one the caller may act on. */
export const assertOrderAccess = async (access, orderId) => {
  const { data } = await supabaseAdmin.from('orders').select('id, partner_id').eq('id', orderId).maybeSingle();
  if (!data) throw new NotFoundError('Order not found');
  if (!ownsPartnerRow(access, data.partner_id)) throw new ForbiddenError('This order belongs to another partner.');
  return data;
};

/** A team member id taken from a request body must belong to the same partner as the row it is used on. */
export const assertMemberOfPartner = async (memberId, partnerId, label = 'Team member') => {
  const { data } = await supabaseAdmin.from('team_members').select('id, name, role, partner_id').eq('id', memberId).maybeSingle();
  if (!data) throw new NotFoundError(`${label} not found`);
  if (data.partner_id !== partnerId) throw new ForbiddenError(`${label} belongs to another partner.`);
  return data;
};
