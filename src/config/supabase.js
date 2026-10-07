import { createClient } from '@supabase/supabase-js';
import { config } from './env.js';

if (!config.supabase.url) {
  throw new Error('SUPABASE_URL is not set in environment variables.');
}

// Public client for standard operations (signInWithPassword, signUp, public tables)
export const supabase = createClient(
  config.supabase.url,
  config.supabase.publishableKey || config.supabase.secretKey,
  {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  }
);

// Admin client for backend-only privileged operations (admin.createUser, bypass RLS, admin.getUserById)
export const supabaseAdmin = createClient(
  config.supabase.url,
  config.supabase.secretKey || config.supabase.publishableKey,
  {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  }
);

export default supabase;
