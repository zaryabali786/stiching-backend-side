import UserModel from '../models/user.model.js';
import { supabase, supabaseAdmin } from '../config/supabase.js';
import { config } from '../config/env.js';
import { loadShipTo } from '../services/ship-to.service.js';
import { loadExpressStitching } from '../services/express-stitching.service.js';
import { loadExpressShipping } from '../services/express-shipping.service.js';
import { loadClientTheme } from './theme.controller.js';
import { loadPortalTheme } from './portal-theme.controller.js';
import { catchAsync, BadRequestError, UnauthorizedError, ForbiddenError, ApiResponse } from '../utils/error.helper.js';
import { identityFromCode, identityFromIdToken, isGoogleEnabled } from '../services/google-auth.service.js';
import { identityFromAppleToken } from '../services/apple-auth.service.js';
import { resolveAccess, accessPayload } from '../services/access.service.js';
import { invalidateProfile } from '../middlewares/auth.middleware.js';
import { randomBytes } from 'node:crypto';
import { notifyAdmins } from '../services/notification.service.js';
import { addressForToken, getForwardAddress, tokenForCode } from '../services/order-import.service.js';

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
const publicProfile = async (profile, knownAccess = null) => {
  const access = knownAccess ?? (await resolveAccess(profile));
  const { permissions: _stored, inbound_email_token: token, ...rest } = profile;
  // Customers get a personal shopping address (their Inbox); the secret token itself is not sent on.
  // One created before this feature existed gets theirs the first time they load their profile.
  let mailbox = {};
  if (profile.role === 'customer') {
    let address = addressForToken(tokenForCode(profile.customer_code) || token);
    if (!address) address = await getForwardAddress(profile.id).then((r) => r.address, () => null);
    mailbox = { mailbox_address: address };
  }
  return { ...rest, ...mailbox, ...accessPayload(profile, access) };
};

/**
 * First Google sign-in from the admin-side login: the person becomes the owner of a new partner of their own.
 * The partner starts with NO modules, so it sees and receives nothing until an admin enables what it may use
 * (Admin > Partners > Modules). An admin can also promote the person to Admin (Settings > Team & roles).
 */
const makeGooglePartner = async (profile, who) => {
  const base = (who.name || who.email.split('@')[0]).trim().slice(0, 80) || 'New partner';
  let partner = null;
  for (const name of [base, `${base} (${randomBytes(2).toString('hex')})`, `${base} (${randomBytes(3).toString('hex')})`]) {
    const { data, error } = await supabaseAdmin.from('partners').insert({ name, permissions: [], status: 'active', created_by: profile.id }).select('*').single();
    if (!error) { partner = data; break; }
    if (error.code !== '23505') throw error; // 23505 = that name is taken: try the next one
  }
  if (!partner) throw new BadRequestError('Could not set up your partner account. Please try again.');
  const { data, error } = await supabaseAdmin
    .from('profiles')
    .update({ role: 'partner_staff', partner_id: partner.id, partner_role: 'owner', permissions: [], job_title: 'Owner', requested_role: null, must_change_password: false, updated_at: new Date().toISOString() })
    .eq('id', profile.id)
    .select('*')
    .single();
  if (error) {
    await supabaseAdmin.from('partners').delete().eq('id', partner.id);
    throw error;
  }
  invalidateProfile(profile.id);
  await notifyAdmins({ type: 'alert', title: `New partner signed up: ${partner.name}`, body: `${who.email} signed in with ${who.provider || 'Google'} and was created as a partner with no modules. Enable what they may use, or make them an admin.`, link: '/admin/partners' });
  return data;
};

/** A partner user cannot sign in while their partner is switched off. */
const assertPartnerActive = async (profile) => {
  if (profile.role !== 'partner_staff') return null;
  const access = await resolveAccess(profile);
  if (!access.partner || access.partner.status !== 'active') throw new ForbiddenError('Your partner account is switched off. Contact the platform admin.');
  return access; // handed on so the reply does not look the same partner up again
};

/** Every new customer gets a personal shopping address at sign-up. A failure must never block the sign-up (it is created on first Inbox visit instead). */
const giveShoppingAddress = async (userId) => {
  try {
    await getForwardAddress(userId);
  } catch (err) {
    console.warn('[Auth] could not create the shopping address:', err.message);
  }
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

  await giveShoppingAddress(user.id);
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
  const access = await assertPartnerActive(profile);

  return ApiResponse.success(res, { user: await publicProfile(profile, access), tokens: toTokens(session) }, 'Login successful.');
});

/**
 * POST /api/auth/google  body: { code, redirectUri, portal } (website)  or  { idToken, portal } (phone app, native Google sign-in)
 *   portal: 'customer' | 'staff'
 * Same answer as /login. A first-time Google user becomes a customer; staff accounts are never created this way.
 */
export const googleLogin = catchAsync(async (req, res) => {
  const portal = req.body?.portal === 'staff' ? 'staff' : 'customer';
  // the website sends the authorization `code`; the phone app (native Google sign-in) sends the signed `idToken`
  const who = req.body?.idToken
    ? await identityFromIdToken(req.body.idToken)
    : await identityFromCode({ code: req.body?.code, redirectUri: req.body?.redirectUri });

  return signInWithIdentity(res, who, portal);
});

/**
 * POST /api/auth/apple  body: { idToken, name?, portal }  (phone app, native Sign in with Apple)
 * Same answer as /login and /google. A first-time Apple user becomes a customer (or a partner from the admin login).
 */
export const appleLogin = catchAsync(async (req, res) => {
  const portal = req.body?.portal === 'staff' ? 'staff' : 'customer';
  const who = await identityFromAppleToken(req.body?.idToken, req.body?.name);
  return signInWithIdentity(res, who, portal);
});

/** The part Google and Apple share: the provider has proven the email, so find or create the person and answer like a login. */
const signInWithIdentity = async (res, who, portal) => {
  const provider = who.provider || 'Google';
  let profile = await UserModel.findProfileByEmail(who.email);
  let created = false;
  if (!profile) {
    // Google proves the email, so there is no password to ask for: set an unguessable one (they can use "forgot password" later)
    const user = await UserModel.create({
      email: who.email,
      password: randomBytes(32).toString('base64url'),
      profile: { full_name: who.name, avatar_url: who.picture },
    });
    await giveShoppingAddress(user.id);
    profile = await UserModel.getProfile(user.id);
    created = true;
    // Google from the admin-side login: a new person becomes a Partner (never an Admin, which only an admin can grant)
    if (portal === 'staff') profile = await makeGooglePartner(profile, who);
  }
  if (profile.is_active === false) throw new UnauthorizedError('This account has been deactivated. Contact the platform admin.');
  const access = await assertPartnerActive(profile);

  // the session (two calls to Supabase) and the reply's profile do not depend on each other: run them together
  const [{ session }, user] = await Promise.all([UserModel.signInVerifiedEmail(who.email), publicProfile(profile, access)]);
  if (!session) throw new UnauthorizedError(`${provider} sign-in could not be completed. Please try again.`);
  return ApiResponse.success(res, { user, tokens: toTokens(session), created }, 'Login successful.');
};

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
 * Every app asks for it on start (and the Google button depends on it), so it must be quick: the five settings are read
 * together instead of one after the other, and the finished answer is kept for a few seconds.
 */
const PUBLIC_CONFIG_TTL_MS = 15_000;
let publicConfigCache = { at: 0, data: null };

const buildPublicConfig = async () => {
  const [shipTo, expressStitching, expressShipping, theme, portalTheme] = await Promise.all([
    loadShipTo().catch(() => ({})), // the admin's own address wins over the .env defaults
    loadExpressStitching().catch(() => ({ enabled: true, days: 5 })),
    loadExpressShipping().catch(() => ({ enabled: true, days: 3 })),
    loadClientTheme(),
    loadPortalTheme(),
  ]);
  return {
    ...config.platform,
    ...shipTo,
    expressStitching,
    expressShipping,
    // the publishable key is safe to expose; the secret key never leaves the server
    google: { enabled: isGoogleEnabled(), clientId: isGoogleEnabled() ? config.google.clientId : null, iosClientId: isGoogleEnabled() ? config.google.iosClientId || null : null },
    payments: { stripe: { enabled: !!config.stripe.secretKey && !!config.stripe.publishableKey, publishableKey: config.stripe.publishableKey || null } },
    theme,
    portalTheme,
  };
};

export const getPublicConfig = catchAsync(async (req, res) => {
  const now = Date.now();
  if (!publicConfigCache.data || now - publicConfigCache.at > PUBLIC_CONFIG_TTL_MS) {
    publicConfigCache = { at: now, data: await buildPublicConfig() };
  }
  return ApiResponse.success(res, publicConfigCache.data, 'Platform config');
});
