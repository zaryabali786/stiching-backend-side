/**
 * Creates (or promotes) an admin login. There is no public staff sign-up any more, so this is how the very first
 * admin of a fresh install is made:
 *
 *   node scripts/create-admin.mjs you@company.com "Your Name" "a-strong-password"
 *
 * If the email already has an account it becomes an admin (the password is left alone unless one is given).
 */
import { supabaseAdmin } from '../src/config/supabase.js';
import UserModel from '../src/models/user.model.js';

const [email, name = '', password] = process.argv.slice(2);
if (!email || !/^\S+@\S+\.\S+$/.test(email)) {
  console.error('Usage: node scripts/create-admin.mjs <email> ["Full name"] [password]');
  process.exit(1);
}

try {
  const profile = await UserModel.findProfileByEmail(email.trim().toLowerCase());
  let id = profile?.id;
  if (!id) {
    if (!password || password.length < 8) throw new Error('A new admin needs a password of at least 8 characters.');
    const user = await UserModel.create({ email: email.trim().toLowerCase(), password, profile: { full_name: name } });
    id = user.id;
    console.log(`Created ${email}`);
  } else if (password) {
    if (password.length < 8) throw new Error('The password must be at least 8 characters.');
    await UserModel.updatePassword(id, password);
    console.log('Password updated');
  }
  await UserModel.setRole(id, 'admin', { partner_id: null, partner_role: null, permissions: [], must_change_password: false });
  console.log(`${email} is an admin.`);
  process.exit(0);
} catch (err) {
  console.error('Failed:', err.message);
  process.exit(1);
}
