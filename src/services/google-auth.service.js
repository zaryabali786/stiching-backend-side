import { config } from '../config/env.js';
import { AppError, BadRequestError, UnauthorizedError } from '../utils/error.helper.js';

/**
 * "Continue with Google" (OAuth authorization-code flow).
 * The app sends the user to Google, Google returns to `<app>/login?code=...`, and the app hands the code to
 * POST /api/auth/google. Only this server holds the client secret: it swaps the code for the signed id_token straight
 * from Google over TLS, so the identity (email, name) is never taken from the browser.
 */

export const isGoogleEnabled = () => !!config.google.clientId && !!config.google.clientSecret;

/** Where Google may send people back to: our two apps' login pages. */
const allowedRedirects = () =>
  new Set([`${config.urls.clientApp}/login`, `${config.urls.adminApp}/login`].map((u) => u.replace(/\/+login$/, '/login')));

const decodePayload = (jwt) => {
  try {
    return JSON.parse(Buffer.from(String(jwt).split('.')[1], 'base64url').toString('utf8'));
  } catch {
    throw new UnauthorizedError('Google sign-in failed. Please try again.');
  }
};

/**
 * @returns {Promise<{ email: string, name: string, picture: string|null, sub: string }>}
 */
export const identityFromCode = async ({ code, redirectUri }) => {
  if (!isGoogleEnabled()) throw new AppError('Google sign-in is not set up yet.', 503);
  if (!code || typeof code !== 'string') throw new BadRequestError('Google did not return a sign-in code.');
  if (!allowedRedirects().has(String(redirectUri || ''))) throw new BadRequestError('This sign-in address is not allowed.');

  let res;
  try {
    res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: config.google.clientId,
        client_secret: config.google.clientSecret,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code',
      }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new AppError('Could not reach Google. Please try again.', 502);
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.id_token) {
    // a reused / expired code or a redirect address that is not registered in Google Cloud
    throw new UnauthorizedError(body.error === 'redirect_uri_mismatch' ? 'This address is not registered for Google sign-in yet.' : 'Google sign-in expired. Please try again.');
  }

  const claims = decodePayload(body.id_token);
  const issuerOk = claims.iss === 'https://accounts.google.com' || claims.iss === 'accounts.google.com';
  if (!issuerOk || claims.aud !== config.google.clientId || !(claims.exp * 1000 > Date.now())) throw new UnauthorizedError('Google sign-in could not be verified.');
  if (!claims.email || claims.email_verified !== true) throw new UnauthorizedError('Your Google email is not verified.');

  return { email: String(claims.email).trim().toLowerCase(), name: String(claims.name || '').trim(), picture: claims.picture || null, sub: claims.sub };
};
