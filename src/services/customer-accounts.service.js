import { randomBytes } from 'node:crypto';
import UserModel from '../models/user.model.js';
import { ConflictError } from '../utils/error.helper.js';
import { getForwardAddress } from './order-import.service.js';

/**
 * The customer account of an email address that placed an order on a brand's Shopify store. If it already exists it is reused; if not
 * it is created without a password (the customer signs in with a one-time code sent to that email). A staff or deactivated account is
 * never used for a customer order.
 */
export const findOrCreateCustomerByEmail = async ({ email, name }) => {
  const existing = await UserModel.findProfileByEmail(email);
  if (existing) {
    if (existing.role !== 'customer' || existing.requested_role) throw new ConflictError('That email belongs to a staff account, so it cannot be used for a customer order.');
    if (existing.is_active === false) throw new ConflictError('That customer account is deactivated.');
    return { profile: existing, created: false };
  }
  const user = await UserModel.create({
    email,
    password: randomBytes(32).toString('base64url'), // nobody knows it: the customer signs in with a code (or sets one with "forgot password")
    profile: { full_name: String(name || '').trim().slice(0, 120) },
  });
  // a failure here must never stop the order: the shopping address is created on the first Inbox visit instead
  await getForwardAddress(user.id).catch(() => null);
  const profile = await UserModel.getProfile(user.id);
  return { profile, created: true };
};
