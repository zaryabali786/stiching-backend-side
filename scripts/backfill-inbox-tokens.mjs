/** One-off: set every customer's inbound_email_token to their lower-cased customer code (same as migrations/0015). */
import 'dotenv/config';
import { supabaseAdmin } from '../src/config/supabase.js';

const { data, error } = await supabaseAdmin.from('profiles').select('id, customer_code, inbound_email_token').not('customer_code', 'is', null);
if (error) throw error;
let n = 0;
for (const p of data) {
  const token = p.customer_code.trim().toLowerCase();
  if (p.inbound_email_token === token) continue;
  const { error: e } = await supabaseAdmin.from('profiles').update({ inbound_email_token: token }).eq('id', p.id);
  if (e) console.error(p.customer_code, e.message);
  else n++;
}
console.log(`updated ${n} of ${data.length} profiles`);
