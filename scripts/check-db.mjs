// Verifies the migrations were applied: node scripts/check-db.mjs
import { supabaseAdmin } from '../src/config/supabase.js';

const tables = [
  'profiles', 'size_charts', 'orders', 'order_units', 'order_events', 'team_members', 'job_cards', 'job_card_comments',
  'price_items', 'shipping_rates', 'invoices', 'invoice_lines', 'payments', 'transfers', 'shipments', 'notifications', 'unmatched_parcels',
  'order_imports', 'brands', 'couriers', 'article_types', 'articles', 'order_unit_articles', 'order_messages',
];
let ok = true;
for (const t of tables) {
  const { data, error } = await supabaseAdmin.from(t).select('*').limit(1);
  const count = error ? 0 : data.length;
  if (error) ok = false;
  console.log(`${error ? 'MISSING' : 'ok     '} ${t.padEnd(18)} ${error ? error.message : `reachable`}`);
}
// Columns added by 0002
const { error: colErr } = await supabaseAdmin.from('order_units').select('line_no, design, reference_images').limit(1);
console.log(colErr ? `MISSING 0002 columns: ${colErr.message}` : 'ok      0002 columns present');
// Columns added by 0003
const { error: col3Err } = await supabaseAdmin.from('orders').select('import_source, brand_invoice, brand_order_total').limit(1);
console.log(col3Err ? `MISSING 0003 columns: ${col3Err.message}` : 'ok      0003 columns present');
// Columns added by 0004
const { error: col4aErr } = await supabaseAdmin.from('orders').select('brand_id, courier_id, international_shipping, last_message_preview').limit(1);
const { error: col4bErr } = await supabaseAdmin.from('articles').select('customer_price, partner_cost').limit(1);
const col4Err = col4aErr || col4bErr;
// Added by 0005 (partners, permissions, tenant columns)
const col5Err = (await supabaseAdmin.from('partners').select('id').limit(1)).error || (await supabaseAdmin.from('profiles').select('partner_id, partner_role, permissions, must_change_password').limit(1)).error || (await supabaseAdmin.from('orders').select('partner_id').limit(1)).error;
console.log(col5Err ? `MISSING 0005 (partners / permissions): ${col5Err.message}` : 'ok      0005 partners and permissions present');
console.log(col4Err ? `MISSING 0004 columns: ${col4Err.message}` : 'ok      0004 columns present');
const { data: buckets } = await supabaseAdmin.storage.listBuckets();
for (const id of ['evidence', 'documents']) {
  const found = buckets?.some((b) => b.id === id);
  if (!found) ok = false;
  console.log(found ? `ok      storage bucket "${id}"` : `MISSING storage bucket "${id}"`);
}
console.log(ok && !colErr && !col3Err && !col4Err && !col5Err ? '\nDatabase is ready.' : '\nSome parts are missing — run backend/UPDATE_DATABASE_0005.sql (or SETUP_DATABASE.sql) in the Supabase SQL Editor.');
process.exit(0);
