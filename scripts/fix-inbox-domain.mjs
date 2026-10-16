/**
 * One-off: rewrite stored addresses  @mail.thesellsphere.com -> @thesellsphere.com
 * (inbox_emails.email_from / email_to, order_imports.email_from).
 * Run  node scripts/fix-inbox-domain.mjs        -> dry run (only counts)
 *      node scripts/fix-inbox-domain.mjs --apply -> writes the changes
 */
import 'dotenv/config';
import { supabaseAdmin } from '../src/config/supabase.js';

const APPLY = process.argv.includes('--apply');
const OLD = '@mail.thesellsphere.com';
const NEW = '@thesellsphere.com';
const TARGETS = [
  { table: 'inbox_emails', cols: ['email_from', 'email_to'] },
  { table: 'order_imports', cols: ['email_from'] },
];

for (const { table, cols } of TARGETS) {
  let found = 0;
  let changed = 0;
  for (const col of cols) {
    const { data, error } = await supabaseAdmin.from(table).select(`id, ${col}`).ilike(col, `%${OLD}%`);
    if (error) { console.error(table, col, error.message); continue; }
    found += data.length;
    if (!APPLY) continue;
    for (const row of data) {
      const value = row[col].replace(/@mail\.thesellsphere\.com/gi, NEW);
      const { error: e } = await supabaseAdmin.from(table).update({ [col]: value }).eq('id', row.id);
      if (e) console.error(table, row.id, e.message);
      else changed++;
    }
  }
  console.log(`${table}: ${found} values contain ${OLD}${APPLY ? `, updated ${changed}` : ' (dry run)'}`);
}
