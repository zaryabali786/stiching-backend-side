import { supabaseAdmin } from '../config/supabase.js';
import UserModel from '../models/user.model.js';
import { BadRequestError, ConflictError, ForbiddenError } from '../utils/error.helper.js';
import { invalidateProfile } from '../middlewares/auth.middleware.js';
import { checkTransition, setOrderStatus } from './order.service.js';
import { notifyAdmins } from './notification.service.js';
import { identityFromAppleToken } from './apple-auth.service.js';
import { identityFromIdToken } from './google-auth.service.js';

/**
 * Anyone deletes their own account (App Store rule 5.1.1(v)): customers, partner staff and admins.
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
 * Orders still in progress are cancelled (after the person confirmed it in the app); an order already shipped cannot be recalled and stays.
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

/** What would happen to the customer's open orders if they deleted the account now (shown in the confirmation popup). */
export const previewDeletion = async (profile) => {
  if (profile.role !== 'customer') return { openOrders: [] };
  const open = await openOrdersOf(profile.id);
  return { openOrders: open.map((o) => ({ reference: o.reference, status: o.status, willBeCancelled: checkTransition(o.status, 'cancelled').ok })) };
};

const must = (result, what) => {
  if (result?.error) throw new Error(`${what}: ${result.error.message}`);
};

/** Nobody may delete the last way into the platform or leave a team without its owner. */
const assertStaffMayLeave = async (profile) => {
  if (profile.role === 'admin') {
    const { count, error } = await supabaseAdmin.from('profiles').select('id', { count: 'exact', head: true }).eq('role', 'admin').eq('is_active', true).neq('id', profile.id);
    if (error) throw error;
    if (!count) throw new ConflictError('You are the only active admin. Make another person an admin (Settings > Team & roles) before deleting your account.');
    return;
  }
  if (profile.partner_role === 'owner') {
    const { count, error } = await supabaseAdmin.from('profiles').select('id', { count: 'exact', head: true }).eq('partner_id', profile.partner_id).eq('is_active', true).neq('id', profile.id);
    if (error) throw error;
    if (count) throw new ConflictError('You are the owner of this team and other people still use it. Ask an admin to remove the other members or to make someone else the owner first.');
  }
};

/** Staff: the login and personal details go; the row stays (work history points at it) as an inactive "Deleted account". */
const deleteStaffLogin = async (profile) => {
  const id = profile.id;
  for (const [table, column] of [['notifications', 'user_id'], ['push_devices', 'user_id']]) {
    must(await supabaseAdmin.from(table).delete().eq(column, id), `delete ${table}`);
  }
  const { error: authError } = await supabaseAdmin.auth.admin.deleteUser(id, true);
  if (authError) throw new Error(`delete login: ${authError.message}`);
  const scrub = {
    email: `deleted-${id}@deleted.invalid`,
    full_name: 'Deleted account',
    phone: null, country: null, city: null, address: null, postal_code: null, avatar_url: null, job_title: null,
    permissions: [],
    is_active: false,
    updated_at: new Date().toISOString(),
  };
  let lastError = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    const { error } = await supabaseAdmin.from('profiles').update(scrub).eq('id', id);
    if (!error) { lastError = null; break; }
    lastError = error;
  }
  invalidateProfile(id);
  if (lastError) console.error(`[AccountDeletion] login deleted but the profile ${id} was not scrubbed: ${lastError.message}`);
  return { deleted: true };
};

export const deleteCustomerAccount = async ({ profile, confirm, cancelOrders, ...proof }) => {
  const isStaff = profile.role === 'admin' || profile.role === 'partner_staff';
  if (!isStaff && profile.role !== 'customer') throw new ForbiddenError('This account cannot be deleted here.');
  if (String(confirm || '').trim().toUpperCase() !== DELETE_CONFIRM_WORD) throw new BadRequestError(`Type ${DELETE_CONFIRM_WORD} to confirm.`);

  if (isStaff) await assertStaffMayLeave(profile);

  await verifyReauth(profile, proof);

  const id = profile.id;
  if (isStaff) return deleteStaffLogin(profile);

  // Open orders: the person has been told in the app that they will be cancelled. Without that consent nothing is touched.
  const open = await openOrdersOf(id);
  const cancelled = [];
  if (open.length) {
    if (!cancelOrders) throw new ConflictError('You have orders in progress. Confirm that they will be cancelled to delete your account.');
    for (const o of open) {
      if (!checkTransition(o.status, 'cancelled').ok) continue; // already shipped: it cannot be recalled and is delivered as planned
      await setOrderStatus(o.id, 'cancelled', { note: 'Cancelled because the customer deleted their account', actorId: id });
      cancelled.push(o.reference);
    }
    if (cancelled.length) {
      await notifyAdmins({ type: 'alert', title: `Customer deleted their account: ${cancelled.length} order${cancelled.length === 1 ? '' : 's'} cancelled`, body: `Orders ${cancelled.join(', ')} were cancelled automatically. Check whether any payment needs a refund.`, link: '/admin/orders' }).catch(() => undefined);
    }
  }
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
