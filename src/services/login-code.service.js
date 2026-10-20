import crypto from 'node:crypto';
import { supabaseAdmin } from '../config/supabase.js';
import { AppError, BadRequestError } from '../utils/error.helper.js';

/**
 * Sign-in with a one-time code sent to the customer's email (no password). A customer whose order came from a brand's Shopify store
 * gets an account for the email on that order; this proves they own that email.
 *
 *  - code: 6 digits the customer types, valid 10 minutes, 5 wrong tries, single use
 *  - link: a long random token inside an email button, valid 48 hours, single use
 * Only a hash is stored. Asking for codes is limited per email (the controller adds a per-address limit as well).
 */

export const CODE_TTL_MS = 10 * 60 * 1000;
export const LINK_TTL_MS = 48 * 60 * 60 * 1000;
export const MAX_ATTEMPTS = 5;
export const MAX_REQUESTS_PER_HOUR = 5;

const EMAIL = /^[^\s@<>,;]+@[^\s@<>,;]+\.[^\s@<>,;]+$/;

export const normaliseEmail = (value) => {
  const e = String(value ?? '').trim().toLowerCase();
  return e.length <= 254 && EMAIL.test(e) ? e : null;
};

const secret = () => {
  const s = process.env.LOGIN_CODE_SECRET || process.env.SUPABASE_SECRET_KEY || '';
  if (!s) {
    if (process.env.NODE_ENV === 'production') throw new AppError('Sign-in codes are not configured on the server.', 503);
    return 'development-only-secret';
  }
  return s;
};

const hash = (email, value) => crypto.createHmac('sha256', secret()).update(`${email}:${value}`).digest('hex');

const same = (a, b) => {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

/** A new code (or link token) for this email. The plain value is returned once, only the hash is kept. */
export const issueLoginCode = async (email, { kind = 'code' } = {}) => {
  const since = new Date(Date.now() - 3600_000).toISOString();
  const { count } = await supabaseAdmin.from('login_codes').select('id', { count: 'exact', head: true }).eq('email', email).eq('kind', kind).gte('created_at', since);
  if ((count ?? 0) >= MAX_REQUESTS_PER_HOUR) throw new BadRequestError('Too many sign-in codes were requested for this email. Please try again in an hour.');
  const plain = kind === 'link' ? crypto.randomBytes(24).toString('hex') : String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
  const ttl = kind === 'link' ? LINK_TTL_MS : CODE_TTL_MS;
  const { error } = await supabaseAdmin.from('login_codes').insert({ email, kind, code_hash: hash(email, plain), expires_at: new Date(Date.now() + ttl).toISOString() });
  if (error) throw error;
  return plain;
};

const consume = async (id) => {
  const { data } = await supabaseAdmin.from('login_codes').update({ consumed_at: new Date().toISOString() }).eq('id', id).is('consumed_at', null).select('id').maybeSingle();
  return !!data;
};

/** True when the typed code (or the link token) is right for this email, and it is used up. */
export const redeemLoginCode = async ({ email, code, token }) => {
  const now = Date.now();
  if (token) {
    const { data: row } = await supabaseAdmin.from('login_codes').select('*').eq('email', email).eq('kind', 'link').eq('code_hash', hash(email, String(token))).is('consumed_at', null).limit(1).maybeSingle();
    if (!row || new Date(row.expires_at).getTime() < now) return false;
    return consume(row.id);
  }
  if (!/^\d{6}$/.test(String(code ?? ''))) return false;
  const { data: row } = await supabaseAdmin.from('login_codes').select('*').eq('email', email).eq('kind', 'code').is('consumed_at', null).order('created_at', { ascending: false }).limit(1).maybeSingle();
  const attempts = Number(row?.attempts) || 0;
  if (!row || new Date(row.expires_at).getTime() < now || attempts >= MAX_ATTEMPTS) return false;
  if (!same(row.code_hash, hash(email, String(code)))) {
    await supabaseAdmin.from('login_codes').update({ attempts: attempts + 1 }).eq('id', row.id);
    return false;
  }
  return consume(row.id);
};
