/**
 * Gives every partner its own copy of the standard article set (idempotent: it only adds what is missing).
 *   node scripts/copy-standard-catalogue.mjs
 */
import 'dotenv/config';
import { supabaseAdmin } from '../src/config/supabase.js';
import { copyStandardCatalogue } from '../src/services/catalogue-copy.service.js';

const { data: partners, error } = await supabaseAdmin.from('partners').select('id, name').order('created_at');
if (error) {
  console.error(error.message);
  process.exit(1);
}
for (const p of partners) {
  const r = await copyStandardCatalogue(p.id);
  console.log(`${p.name}: +${r.typesAdded} types, +${r.articlesAdded} articles`);
}
process.exit(0);
