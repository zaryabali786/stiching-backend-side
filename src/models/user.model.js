import { supabase, supabaseAdmin } from '../config/supabase.js';
import { invalidateProfile } from '../middlewares/auth.middleware.js';

const PROFILE_FIELDS = ['full_name', 'phone', 'country', 'city', 'address', 'postal_code', 'avatar_url'];

export class UserModel {
  /**
   * Create a confirmed user with the Admin API (works even when public email sign-ups are disabled).
   * The DB trigger creates the profile with role 'customer'.
   */
  static async create({ email, password, profile = {}, requestedRole = null }) {
    const { data, error } = await supabaseAdmin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: {
        full_name: profile.full_name || '',
        phone: profile.phone || '',
        country: profile.country || '',
        city: profile.city || '',
        address: profile.address || '',
        requested_role: requestedRole,
      },
    });
    if (error) throw error;

    // Make sure the profile row exists even if the trigger is missing, and store all fields.
    const row = { id: data.user.id, email, role: 'customer', requested_role: requestedRole, updated_at: new Date().toISOString() };
    for (const key of PROFILE_FIELDS) if (profile[key] !== undefined) row[key] = profile[key];
    const { error: upsertError } = await supabaseAdmin.from('profiles').upsert(row, { onConflict: 'id' });
    if (upsertError) {
      // Roll back the auth user so the email can be used again once the DB is fixed
      await supabaseAdmin.auth.admin.deleteUser(data.user.id).catch(() => {});
      throw upsertError;
    }
    return data.user;
  }

  static async authenticate({ email, password }) {
    const { data, error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) throw error;
    return { user: data.user, session: data.session };
  }

  /**
   * A normal session for an email that was already verified elsewhere (Google), without a password:
   * the Admin API issues a one-time magic-link token that is redeemed straight away.
   */
  static async signInVerifiedEmail(email) {
    const { data: link, error } = await supabaseAdmin.auth.admin.generateLink({ type: 'magiclink', email });
    if (error) throw error;
    const { data, error: verifyError } = await supabase.auth.verifyOtp({ token_hash: link.properties.hashed_token, type: 'magiclink' });
    if (verifyError) throw verifyError;
    return { user: data.user, session: data.session };
  }

  static async findProfileByEmail(email) {
    const { data, error } = await supabaseAdmin.from('profiles').select('*').eq('email', email.trim().toLowerCase()).limit(1).maybeSingle();
    if (error) throw error;
    return data;
  }

  static async getProfile(userId) {
    const { data, error } = await supabaseAdmin.from('profiles').select('*').eq('id', userId).maybeSingle();
    if (error) throw error;
    return data;
  }

  static async updateProfile(userId, updates) {
    const patch = { updated_at: new Date().toISOString() };
    for (const key of PROFILE_FIELDS) if (updates[key] !== undefined) patch[key] = updates[key];
    const { data, error } = await supabaseAdmin.from('profiles').update(patch).eq('id', userId).select('*').single();
    if (error) throw error;
    invalidateProfile(userId);
    return data;
  }

  static async setRole(userId, role, extra = {}) {
    const { data, error } = await supabaseAdmin
      .from('profiles')
      .update({ role, requested_role: null, updated_at: new Date().toISOString(), ...extra })
      .eq('id', userId)
      .select('*')
      .single();
    if (error) throw error;
    invalidateProfile(userId);
    return data;
  }

  static async refreshSession(refreshToken) {
    const { data, error } = await supabase.auth.refreshSession({ refresh_token: refreshToken });
    if (error) throw error;
    return data;
  }

  static async signOut(accessToken) {
    if (!accessToken) return;
    await supabaseAdmin.auth.admin.signOut(accessToken).catch(() => {});
  }

  static async updatePassword(userId, password) {
    const { error } = await supabaseAdmin.auth.admin.updateUserById(userId, { password });
    if (error) throw error;
  }

  static async adminExists() {
    const { count, error } = await supabaseAdmin.from('profiles').select('id', { count: 'exact', head: true }).eq('role', 'admin');
    if (error) throw error;
    return (count || 0) > 0;
  }
}

export default UserModel;
