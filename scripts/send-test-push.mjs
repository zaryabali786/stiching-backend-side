/**
 * Send ONE test push to ONE person's own phones/browsers (the devices they are signed in on), through the same code the
 * API uses. Nothing is saved in their notification list and nobody else is touched.
 *
 *   node scripts/send-test-push.mjs <email> [title] [link]
 *   node scripts/send-test-push.mjs someone@example.com "Test push" /app/orders
 */
import { supabaseAdmin } from '../src/config/supabase.js';
import { pushToUser, pushEnabled } from '../src/services/push.service.js';

const [email, title = 'Test push', link = ''] = process.argv.slice(2);
if (!email) {
  console.error('Usage: node scripts/send-test-push.mjs <email> [title] [link]');
  process.exit(1);
}

if (!pushEnabled()) {
  console.error('Push is switched off: no Firebase service account is configured (FIREBASE_SERVICE_ACCOUNT_*).');
  process.exit(1);
}

const { data: profile } = await supabaseAdmin.from('profiles').select('id, email, role').ilike('email', email).maybeSingle();
if (!profile) {
  console.error(`No account with the email ${email}.`);
  process.exit(1);
}
const { data: devices } = await supabaseAdmin.from('push_devices').select('platform, app, last_seen_at').eq('user_id', profile.id);
console.log(`${profile.email} (${profile.role}) has ${devices?.length ?? 0} device(s):`, devices?.map((d) => `${d.platform}/${d.app}`).join(', ') || 'none');
if (!devices?.length) {
  console.error('Nothing to send to: sign in on the phone first (the app registers its token after login).');
  process.exit(1);
}

await pushToUser(profile.id, { title, body: 'Sent from the server to this account only.', link, type: 'update' });
console.log('Sent.');
process.exit(0);
