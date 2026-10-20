import { supabaseAdmin } from '../config/supabase.js';
import UserModel from '../models/user.model.js';
import { BadRequestError, ConflictError, ForbiddenError } from '../utils/error.helper.js';
import { invalidateProfile } from '../middlewares/auth.middleware.js';
import { identityFromAppleToken } from './apple-auth.service.js';
import { identityFromIdToken } from './google-auth.service.js';

/**
 * A customer deletes their own account (App Store rule 5.1.1(v)).
 *
 * What is deleted: the login (Supabase soft delete: the sign-in identities, password, sessions and the e-mail are removed),
 * the personal rows (size charts, notifications, push devices, forwarded e-mails, e-mail drafts, support chat, draft orders)
 * and the personal details on the profile (name, e-mail, phone, address, picture, shopping-address token).
 *
 * What is kept, on purpose: the customer's finished or cancelled orders with their invoices, payments, shipments and
 * delivery details. They are business and tax records, and orders.customer_id is `ON DELETE RESTRICT`, so the profile row
 * itself stays, with no personal details left on it (it reads "Deleted account"). Requires confirmation by the business:
 * how long those records are kept and whether the delivery name/address on old orders should also be erased after that.
 *
 * Not possible while an order is still in progress (anything except delivered, cancelled or draft).
 */

const FINISHED = ['delivered', 'cancelled', 'draft'];

export const DELETE_CONFIRM_WORD = 'DELETE';

/** The orders that stop the deletion: still being worked on, paid for, or on their way. */
export const openOrdersOf = async (customerId) => {
  const { data, error } = await supabaseAdmin
    .from('orders')
    .select('id, reference, status')
    .eq('customer_id', customerId)
    .not('status', 'in', `(${FINISHED.join(',')})`)
    .limit(50);
  if (error) throw error;
  return data || [];
};

/** The person proves who they are again: their password, or a fresh Apple / Google sign-in for the same e-mail. */
const verifyReauth = async (profile, { password, idToken, provider, name }) => {
  const email = String(profile.email || '').trim().toLowerCase();
  if (password) {
    try {
      await UserModel.authenticate({ email, password: String(password) });
    } catch {
      throw new BadRequestError('The password is incorrect.');
    }
    return;
  }
  if (idToken && (provider === 'apple' || provider === 'google')) {
    const who = provider === 'apple' ? await identityFromAppleToken(idToken, name) : await identityFromIdToken(idToken);
    if (String(who.email || '').trim().toLowerCase() !== email) throw new ForbiddenError('That sign-in belongs to a different account.');
    return;
  }
  throw new BadRequestError('Confirm with your password, or sign in again with Apple or Google.');
};

const must = (result, what) => {
  if (result?.error) throw new Error(`${what}: ${result.error.message}`);
};

export const deleteCustomerAccount = async ({ profile, confirm, ...proof }) => {
  if (profile.role !== 'customer') throw new ForbiddenError('Only customer accounts can be deleted here. Staff accounts are removed by an administrator.');
  if (String(confirm || '').trim().toUpperCase() !== DELETE_CONFIRM_WORD) throw new BadRequestError(`Type ${DELETE_CONFIRM_WORD} to confirm.`);

  const open = await openOrdersOf(profile.id);
  if (open.length) {
    const refs = open.slice(0, 5).map((o) => o.reference).join(', ');
    throw new ConflictError(`Your account cannot be deleted while ${open.length === 1 ? 'an order is' : `${open.length} orders are`} still in progress (${refs}${open.length > 5 ? ', ...' : ''}). You can delete it after ${open.length === 1 ? 'it is' : 'they are'} delivered or cancelled.`);
  }

  await verifyReauth(profile, proof);

  const id = profile.id;
  // 1. personal rows. Each step can be repeated safely, so a failure later on can simply be tried again.
  must(await supabaseAdmin.from('order_imports').update({ order_id: null }).eq('customer_id', id), 'detach e-mail drafts');
  must(await supabaseAdmin.from('orders').delete().eq('customer_id', id).eq('status', 'draft'), 'delete draft orders');
  for (const [table, column] of [
    ['size_charts', 'user_id'],
    ['notifications', 'user_id'],
    ['push_devices', 'user_id'],
    ['inbox_emails', 'customer_id'],
    ['order_imports', 'customer_id'],
    ['support_messages', 'customer_id'],
  ]) {
    must(await supabaseAdmin.from(table).delete().eq(column, id), `delete ${table}`);
  }

  // 2. the login. Supabase "soft delete" removes the identities, password and sessions and blanks the e-mail; the row stays so
  // the orders that point at this person keep working. Done before the profile is scrubbed: if it fails the person can retry.
  const { error: authError } = await supabaseAdmin.auth.admin.deleteUser(id, true);
  if (authError) throw new Error(`delete login: ${authError.message}`);

  // 3. the personal details on the profile
  const scrub = {
    email: `deleted-${id}@deleted.invalid`,
    full_name: 'Deleted account',
    phone: null,
    country: null,
    city: null,
    address: null,
    postal_code: null,
    avatar_url: null,
    inbound_email_token: null,
    is_active: false,
    updated_at: new Date().toISOString(),
  };
  let lastError = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    const { error } = await supabaseAdmin.from('profiles').update(scrub).eq('id', id);
    if (!error) {
      lastError = null;
      break;
    }
    lastError = error;
  }
  invalidateProfile(id);
  // the login is already gone at this point: report it for follow-up instead of failing the request
  if (lastError) console.error(`[AccountDeletion] login deleted but the profile ${id} was not scrubbed: ${lastError.message}`);
  return { deleted: true };
};
