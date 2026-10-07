import { createRemoteJWKSet, jwtVerify } from 'jose';
import { supabaseAdmin } from '../config/supabase.js';
import { config } from '../config/env.js';
import { UnauthorizedError, ForbiddenError } from '../utils/error.helper.js';
import { resolveAccess, accessPayload, withActivePartner } from '../services/access.service.js';

// Verify tokens locally against the project's JWKS when possible (no network round-trip per request),
// falling back to Supabase Auth (getUser) for legacy HS256-signed tokens.
let JWKS = null;
if (config.supabase.jwksUrl) {
  try {
    JWKS = createRemoteJWKSet(new URL(config.supabase.jwksUrl));
  } catch (err) {
    console.warn('[JWKS Warning]: Failed to initialize Remote JWKS set:', err.message);
  }
}

// Small in-memory profile cache so we don't hit the database on every request.
const PROFILE_TTL_MS = 30_000;
const profileCache = new Map();

export const invalidateProfile = (userId) => profileCache.delete(userId);

/** Forget the cached profiles of everyone in a partner (after the admin changes what the partner may use). */
export const invalidatePartnerUsers = (partnerId) => {
  for (const [id, entry] of profileCache) if (entry.profile.partner_id === partnerId) profileCache.delete(id);
};

export const loadProfile = async (userId, { fresh = false } = {}) => {
  const cached = profileCache.get(userId);
  if (!fresh && cached && cached.expires > Date.now()) return cached.profile;

  const { data, error } = await supabaseAdmin.from('profiles').select('*').eq('id', userId).maybeSingle();
  if (error) throw error;
  if (data) profileCache.set(userId, { profile: data, expires: Date.now() + PROFILE_TTL_MS });
  return data;
};

export const verifyToken = async (token) => {
  if (JWKS) {
    try {
      const { payload } = await jwtVerify(token, JWKS);
      return { id: payload.sub, email: payload.email };
    } catch (err) {
      if (err.code === 'ERR_JWT_EXPIRED') {
        throw new UnauthorizedError('Your session has expired. Please log in again.');
      }
      // fall through to Supabase verification (e.g. HS256 legacy tokens)
    }
  }

  const { data, error } = await supabaseAdmin.auth.getUser(token);
  if (error || !data?.user) {
    throw new UnauthorizedError('Unauthorized: Invalid or expired token.');
  }
  return { id: data.user.id, email: data.user.email };
};

/**
 * Verifies the Bearer token and attaches the user's profile.
 * The role ALWAYS comes from public.profiles (never from user-editable metadata).
 */
export const authenticate = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization || '';
    if (!authHeader.startsWith('Bearer ')) {
      throw new UnauthorizedError('Access denied. Please log in.');
    }
    const token = authHeader.slice(7).trim();
    if (!token) throw new UnauthorizedError('Access denied. Please log in.');

    const identity = await verifyToken(token);
    const profile = await loadProfile(identity.id);

    if (!profile) {
      throw new UnauthorizedError('No profile found for this account. Please register again.');
    }
    if (profile.is_active === false) {
      throw new ForbiddenError('This account has been deactivated. Contact the platform admin.');
    }

    // authorization: who this is in the hierarchy and what they may do (never taken from the request)
    req.access = await withActivePartner(await resolveAccess(profile), req.headers['x-partner-id']);
    req.partnerId = req.access.partnerId;
    req.permissions = req.access.permissions;
    req.isAdmin = req.access.isAdmin;

    req.token = token;
    req.userId = profile.id;
    req.userEmail = profile.email;
    req.userRole = profile.role;
    req.profile = profile;
    req.user = profile;
    next();
  } catch (err) {
    next(err);
  }
};

/**
 * Restrict a route to specific roles: requireRole('admin'), requireRole('partner_staff', 'admin')
 */
export const requireRole = (...allowedRoles) => (req, res, next) => {
  if (!req.profile) return next(new UnauthorizedError('Unauthorized: User not authenticated.'));
  if (!allowedRoles.includes(req.userRole)) {
    return next(new ForbiddenError(`Access restricted to: ${allowedRoles.join(', ')}.`));
  }
  next();
};

/** Marks a guard so scripts/audit-routes.mjs can list what protects each route. */
const tag = (fn, info) => Object.assign(fn, { guard: info });

/** Every listed permission is required (admins always pass). */
export const requirePermission = (...permissions) => tag((req, res, next) => {
  if (!req.access) return next(new UnauthorizedError('Unauthorized: User not authenticated.'));
  if (req.access.isAdmin || permissions.every((p) => req.access.permissions.has(p))) return next();
  return next(new ForbiddenError('You do not have permission to do this.'));
}, { type: 'permission', permissions });

/** At least one of the listed permissions is required (admins always pass). */
export const requireAnyPermission = (...permissions) => tag((req, res, next) => {
  if (!req.access) return next(new UnauthorizedError('Unauthorized: User not authenticated.'));
  if (req.access.isAdmin || permissions.some((p) => req.access.permissions.has(p))) return next();
  return next(new ForbiddenError('You do not have permission to do this.'));
}, { type: 'permission', permissions });

export { accessPayload };
export default authenticate;
