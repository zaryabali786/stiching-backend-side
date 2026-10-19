import { createRemoteJWKSet, jwtVerify } from 'jose';
import { config } from '../config/env.js';
import { AppError, BadRequestError, UnauthorizedError } from '../utils/error.helper.js';

/**
 * "Continue with Apple" (native Sign in with Apple, iPhone app).
 * The phone hands the app a signed identity token. It is verified here against Apple's public keys: signature, issuer,
 * expiry and that it was issued for one of OUR apps (the bundle id is the audience). The email comes only from the token.
 */

export const isAppleEnabled = () => config.apple.clientIds.length > 0;

const appleKeys = createRemoteJWKSet(new URL('https://appleid.apple.com/auth/keys'));

/**
 * @returns {Promise<{ email: string, name: string, picture: null, sub: string, provider: string }>}
 */
export const identityFromAppleToken = async (idToken, nameFromApp) => {
  if (!isAppleEnabled()) throw new AppError('Apple sign-in is not set up yet.', 503);
  if (!idToken || typeof idToken !== 'string' || idToken.length > 4096) throw new BadRequestError('Apple did not return a sign-in token.');
  let claims;
  try {
    ({ payload: claims } = await jwtVerify(idToken, appleKeys, { issuer: 'https://appleid.apple.com', audience: config.apple.clientIds }));
  } catch {
    throw new UnauthorizedError('Apple sign-in could not be verified. Please try again.');
  }
  // Apple sends email_verified as true or "true"; a "Hide My Email" relay address counts as verified too
  const verified = claims.email_verified === true || claims.email_verified === 'true';
  if (!claims.email || !verified) throw new UnauthorizedError('Your Apple email could not be verified. Please use another sign-in method.');
  // Apple shares the person's name only the very first time: the app passes it along, otherwise it stays empty
  const name = String(nameFromApp || '').trim().slice(0, 120);
  return { email: String(claims.email).trim().toLowerCase(), name, picture: null, sub: claims.sub, provider: 'Apple' };
};
