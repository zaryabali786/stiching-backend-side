/**
 * Creates test accounts and starter configuration. Safe to run more than once.
 *
 *   node scripts/seed.mjs                 accounts + price list + shipping rates + starter team
 *   SEED_PASSWORD=MyPass123 node scripts/seed.mjs
 *
 * Everything created here can be edited or deleted from the admin / partner portals.
 */
import { supabaseAdmin } from '../src/config/supabase.js';
import UserModel from '../src/models/user.model.js';
import { ALL_PERMISSIONS } from '../src/config/permissions.js';

const PASSWORD = process.env.SEED_PASSWORD || 'Test@12345';

const ACCOUNTS = [
  { email: 'admin@v360.test', role: 'admin', profile: { full_name: 'Saad (Admin)', phone: '+92 300 0000001', country: 'Pakistan', city: 'Lahore', address: 'Head office' } },
  { email: 'partner@v360.test', role: 'partner_staff', profile: { full_name: 'Ishaal Receiving Desk', phone: '+92 300 0000002', country: 'Pakistan', city: 'Lahore', address: 'Ishaal Stitching' } },
  { email: 'customer@v360.test', role: 'customer', profile: { full_name: 'Test Customer', phone: '+44 7700 900000', country: 'United Kingdom', city: 'London', address: '1 Test Street, London' } },
];

// Stitching / lace style items are managed as Articles (Partner > Catalogue), so the price list starts empty.
// It is only for extra charges that are not an article.
const PRICE_ITEMS = [];

const SHIPPING_RATES = [
  { courier: 'DHL Express', zone: 'UK & Europe', countries: ['United Kingdom', 'UK', 'Ireland', 'Germany', 'France', 'Netherlands'], service: 'express', transit_time: '3–4 business days', max_weight_kg: 1.5, base_rate: 8500, per_extra_kg: 3500, ddp_available: true, ddp_fee: 3200 },
  { courier: 'DHL Express', zone: 'USA & Canada', countries: ['United States', 'USA', 'US', 'Canada'], service: 'express', transit_time: '4–5 business days', max_weight_kg: 1.5, base_rate: 10500, per_extra_kg: 4200, ddp_available: true, ddp_fee: 4100 },
  { courier: 'Aramex', zone: 'UAE & GCC', countries: ['United Arab Emirates', 'UAE', 'Saudi Arabia', 'Qatar', 'Oman', 'Bahrain', 'Kuwait'], service: 'express', transit_time: '3–5 business days', max_weight_kg: 1.5, base_rate: 6500, per_extra_kg: 2500, ddp_available: false, ddp_fee: 0 },
  { courier: 'Consolidated cargo', zone: 'UK & Europe', countries: ['United Kingdom', 'UK'], service: 'standard', transit_time: '7–10 business days', max_weight_kg: 1.5, base_rate: 4800, per_extra_kg: 2000, ddp_available: false, ddp_fee: 0 },
  { courier: 'TCS', zone: 'Pakistan (domestic)', countries: ['Pakistan'], service: 'express', transit_time: '1–2 business days', max_weight_kg: 1, base_rate: 550, per_extra_kg: 200, ddp_available: false, ddp_fee: 0 },
];

const TEAM = [
  { master: 'Master Akram', capacity: 8, tailors: [['Rashid', 5], ['Imran', 5], ['Saleem', 5]] },
  { master: 'Master Javed', capacity: 8, tailors: [['Naveed', 5], ['Kashif', 5], ['Bilal', 5]] },
];

const check = (res, what) => {
  if (res.error) throw new Error(`${what}: ${res.error.message}`);
  return res.data;
};

async function seedAccounts() {
  const { data: list } = await supabaseAdmin.auth.admin.listUsers({ perPage: 1000 });
  for (const acc of ACCOUNTS) {
    let user = list?.users?.find((u) => u.email === acc.email);
    if (!user) {
      user = await UserModel.create({ email: acc.email, password: PASSWORD, profile: acc.profile });
      console.log(`  created ${acc.email}`);
    } else {
      console.log(`  exists  ${acc.email}`);
    }
    if (acc.role === 'admin') await UserModel.setRole(user.id, 'admin');
    if (acc.role === 'partner_staff') await joinDefaultPartner(user.id);
  }
}

/** Partner logins always belong to a partner: the test partner account becomes the owner of the default partner. */
async function defaultPartner() {
  let partner = check(await supabaseAdmin.from('partners').select('*').eq('is_default', true).maybeSingle(), 'partners');
  if (!partner) partner = check(await supabaseAdmin.from('partners').insert({ name: 'Ishaal Stitching', permissions: ALL_PERMISSIONS, is_default: true }).select('*').single(), 'partners');
  return partner;
}

async function joinDefaultPartner(userId) {
  const partner = await defaultPartner();
  const owner = check(await supabaseAdmin.from('profiles').select('id').eq('partner_id', partner.id).eq('partner_role', 'owner').maybeSingle(), 'owner lookup');
  const isOwner = !owner || owner.id === userId;
  check(await supabaseAdmin.from('profiles').update({
    role: 'partner_staff', partner_id: partner.id, partner_role: isOwner ? 'owner' : 'member', permissions: isOwner ? [] : ALL_PERMISSIONS, requested_role: null,
  }).eq('id', userId), 'partner link');
}

async function seedTable(table, rows, keyFn) {
  const existing = check(await supabaseAdmin.from(table).select('*'), table);
  const missing = rows.filter((r) => !existing.some((e) => keyFn(e) === keyFn(r)));
  if (missing.length) check(await supabaseAdmin.from(table).insert(missing), table);
  console.log(`  ${table}: ${missing.length} added, ${rows.length - missing.length} already present`);
}

async function seedTeam() {
  const partner = await defaultPartner();
  const existing = check(await supabaseAdmin.from('team_members').select('*').eq('partner_id', partner.id), 'team_members');
  let added = 0;
  for (const t of TEAM) {
    let master = existing.find((m) => m.name === t.master && m.role === 'master');
    if (!master) {
      master = check(await supabaseAdmin.from('team_members').insert({ name: t.master, role: 'master', daily_capacity: t.capacity, partner_id: partner.id }).select('*').single(), 'master');
      added++;
    }
    for (const [name, cap] of t.tailors) {
      if (existing.some((m) => m.name === name && m.role === 'tailor')) continue;
      check(await supabaseAdmin.from('team_members').insert({ name, role: 'tailor', master_id: master.id, daily_capacity: cap, partner_id: partner.id }), 'tailor');
      added++;
    }
  }
  console.log(`  team_members: ${added} added`);
}

try {
  console.log('Accounts');
  await seedAccounts();
  console.log('Configuration');
  await seedTable('price_items', PRICE_ITEMS, (r) => `${r.category}|${r.name}`);
  await seedTable('shipping_rates', SHIPPING_RATES, (r) => `${r.courier}|${r.zone}|${r.service}`);
  await seedTeam();
  console.log(`\nDone. Log in with any of: ${ACCOUNTS.map((a) => a.email).join(', ')}  (password: ${PASSWORD})`);
  process.exit(0);
} catch (err) {
  console.error('\nSeed failed:', err.message);
  process.exit(1);
}
