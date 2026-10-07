import UserModel from '../models/user.model.js';
import { supabase, supabaseAdmin } from '../config/supabase.js';
import { config } from '../config/env.js';
import { catchAsync, BadRequestError, UnauthorizedError, ForbiddenError, ApiResponse } from '../utils/error.helper.js';
import { identityFromCode, isGoogleEnabled } from '../services/google-auth.service.js';
import { resolveAccess, accessPayload } from '../services/access.service.js';
import { invalidateProfile } from '../middlewares/auth.middleware.js';
import { randomBytes } from 'node:crypto';

const toTokens = (session) => ({
  tokenType: 'Bearer',
  accessToken: session.access_token,
  refreshToken: session.refresh_token,
  expiresIn: session.expires_in,
  expiresAt: session.expires_at,
});

/**
 * What the apps get after login: the profile plus who they are in the hierarchy. `permissions` is the EFFECTIVE list
 * (what this person may really use today), never the raw stored one. The server decides it, the apps only display it.
 */
const publicProfile = async (profile) => {
  const access = await resolveAccess(profile);
  const { permissions: _stored, ...rest } = profile;
  return { ...rest, ...accessPayload(profile, access) };
};

/** A partner user cannot sign in while their partner is switched off. */
const assertPartnerActive = async (profile) => {
  if (profile.role !== 'partner_staff') return;
  const access = await resolveAccess(profile);
  if (!access.partner || access.partner.status !== 'active') throw new ForbiddenError('Your partner account is switched off. Contact the platform admin.');
};

const profileFromBody = (body) => ({
  full_name: (body.fullName ?? body.full_name ?? '').trim(),
  phone: body.phone?.trim(),
  country: body.country?.trim(),
  city: body.city?.trim(),
  address: body.address?.trim(),
  postal_code: body.postalCode?.trim() ?? body.postal_code?.trim(),
});

/**
 * POST /api/auth/register
 * body: { email, password, fullName, phone, country, city, address }
 * Customers only. Staff accounts are never created here: an admin creates partners (with their owner login) and a
 * partner creates its own users, so there is no public staff sign-up.
 */
export const register = catchAsync(async (req, res) => {
  const { email, password, portal = 'customer' } = req.body;
  if (portal !== 'customer') {
    throw new ForbiddenError('Staff accounts cannot be created here. An admin creates partners, and partners create their own users.');
  }

  const user = await UserModel.create({
    email: email.trim().toLowerCase(),
    password,
    profile: profileFromBody(req.body),
  });

  const profile = await UserModel.getProfile(user.id);
  const { session } = await UserModel.authenticate({ email: email.trim().toLowerCase(), password });
  return ApiResponse.created(res, { user: await publicProfile(profile), tokens: session ? toTokens(session) : null }, 'Account created successfully.');
});

/**
 * POST /api/auth/login  body: { email, password }
 */
export const login = catchAsync(async (req, res) => {
  const { email, password } = req.body;
  const { user, session } = await UserModel.authenticate({ email: email.trim().toLowerCase(), password });
  if (!session) throw new BadRequestError('Please verify your email before logging in.');

  const profile = await UserModel.getProfile(user.id);
  if (!profile) throw new UnauthorizedError('No profile found for this account. Run the database migrations, then register again.');
  if (profile.is_active === false) throw new UnauthorizedError('This account has been deactivated. Contact the platform admin.');
  await assertPartnerActive(profile);

  return ApiResponse.success(res, { user: await publicProfile(profile), tokens: toTokens(session) }, 'Login successful.');
});

/**
 * POST /api/auth/google  body: { code, redirectUri, portal: 'customer' | 'staff' }
 * Same answer as /login. A first-time Google user becomes a customer; staff accounts are never created this way.
 */
export const googleLogin = catchAsync(async (req, res) => {
  const portal = req.body?.portal === 'staff' ? 'staff' : 'customer';
  const who = await identityFromCode({ code: req.body?.code, redirectUri: req.body?.redirectUri });

  let profile = await UserModel.findProfileByEmail(who.email);
  let created = false;
  if (!profile) {
    // staff accounts are created by an admin / a partner; only customers can start with Google
    if (portal === 'staff') throw new ForbiddenError('There is no staff account for this Google email. Ask your admin or partner to create one.');
    // Google proves the email, so there is no password to ask for: set an unguessable one (they can use "forgot password" later)
    const user = await UserModel.create({
      email: who.email,
      password: randomBytes(32).toString('base64url'),
      profile: { full_name: who.name, avatar_url: who.picture },
    });
    profile = await UserModel.getProfile(user.id);
    created = true;
  }
  if (profile.is_active === false) throw new UnauthorizedError('This account has been deactivated. Contact the platform admin.');
  await assertPartnerActive(profile);

  const { session } = await UserModel.signInVerifiedEmail(who.email);
  if (!session) throw new UnauthorizedError('Google sign-in could not be completed. Please try again.');
  return ApiResponse.success(res, { user: await publicProfile(profile), tokens: toTokens(session), created }, 'Login successful.');
});

export const getMe = catchAsync(async (req, res) => {
  const profile = await UserModel.getProfile(req.userId);
  return ApiResponse.success(res, { user: await publicProfile(profile) }, 'Profile retrieved.');
});

export const updateMe = catchAsync(async (req, res) => {
  const profile = await UserModel.updateProfile(req.userId, profileFromBody({ ...req.profile, ...req.body }));
  return ApiResponse.success(res, { user: await publicProfile(profile) }, 'Profile updated successfully.');
});

export const logout = catchAsync(async (req, res) => {
  await UserModel.signOut(req.token);
  return ApiResponse.success(res, null, 'Logged out successfully.');
});

export const refreshSession = catchAsync(async (req, res) => {
  const { refreshToken } = req.body || {};
  if (!refreshToken) throw new BadRequestError('refreshToken is required.');
  let result;
  try {
    result = await UserModel.refreshSession(refreshToken);
  } catch {
    throw new UnauthorizedError('Session expired. Please log in again.');
  }
  const { session, user } = result;
  if (!session) throw new UnauthorizedError('Session expired. Please log in again.');
  const profile = await UserModel.getProfile(user.id);
  if (!profile || profile.is_active === false) throw new UnauthorizedError('This account has been deactivated. Contact the platform admin.');
  await assertPartnerActive(profile);
  return ApiResponse.success(res, { user: await publicProfile(profile), tokens: toTokens(session) }, 'Session refreshed.');
});

/**
 * POST /api/auth/forgot-password  body: { email, portal }
 */
export const forgotPassword = catchAsync(async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  if (!email) throw new BadRequestError('Email is required.');
  const base = req.body.portal === 'staff' ? config.urls.adminApp : config.urls.clientApp;
  // Always answer the same way so the endpoint can't be used to discover accounts
  await supabase.auth.resetPasswordForEmail(email, { redirectTo: `${base}/login` }).catch(() => {});
  return ApiResponse.success(res, null, 'If an account exists for this email, a reset link has been sent.');
});

/**
 * POST /api/auth/change-password  body: { currentPassword, newPassword }
 */
export const changePassword = catchAsync(async (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  if (!newPassword || newPassword.length < 8) throw new BadRequestError('New password must be at least 8 characters.');
  try {
    await UserModel.authenticate({ email: req.userEmail, password: currentPassword || '' });
  } catch {
    throw new BadRequestError('Current password is incorrect.');
  }
  if (newPassword === currentPassword) throw new BadRequestError('Choose a password different from the current one.');
  await UserModel.updatePassword(req.userId, newPassword);
  // a login created with a temporary password is now properly set up
  await supabaseAdmin.from('profiles').update({ must_change_password: false, updated_at: new Date().toISOString() }).eq('id', req.userId);
  invalidateProfile(req.userId);
  return ApiResponse.success(res, null, 'Password changed successfully.');
});

/**
 * GET /api/config — public platform settings (ship-to address etc.)
 */
export const getPublicConfig = (req, res) =>
  ApiResponse.success(
    res,
    {
      ...config.platform,
      // the publishable key is safe to expose; the secret key never leaves the server
      google: { enabled: isGoogleEnabled(), clientId: isGoogleEnabled() ? config.google.clientId : null },
      payments: { stripe: { enabled: !!config.stripe.secretKey && !!config.stripe.publishableKey, publishableKey: config.stripe.publishableKey || null } },
    },
    'Platform config'
  );
