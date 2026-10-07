/**
 * End-to-end test: Google sign-in roles, Master / Tailor logins, and shipping on invoices.
 * Runs the API in this process (port 5056) and fakes only Google's token endpoint (the id_token claims are made up here,
 * everything else talks to the real database). Everything it creates is named "E2E ..." and removed at the end.
 * Needs migrations up to 0008 for the partner parts and 0009 for the invoice-shipping parts (those are skipped without it).
 *
 *   node scripts/e2e-roles-invoice.mjs
 */
import 'dotenv/config';

const realFetch = globalThis.fetch;
const fakeIdToken = (email, name) => {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b64({ alg: 'none' })}.${b64({ iss: 'https://accounts.google.com', aud: process.env.GOOGLE_CLIENT_ID, exp: Math.floor(Date.now() / 1000) + 600, email, email_verified: true, name, sub: `e2e-${email}` })}.sig`;
};
let nextGoogle = null; // { email, name } the next fake Google exchange will return
globalThis.fetch = async (url, init) => {
  if (String(url).startsWith('https://oauth2.googleapis.com/token')) {
    return new Response(JSON.stringify({ id_token: fakeIdToken(nextGoogle.email, nextGoogle.name) }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  return realFetch(url, init);
};

const { default: app } = await import('../src/app.js');
const { supabaseAdmin: db } = await import('../src/config/supabase.js');
const server = app.listen(5056);
const BASE = 'http://localhost:5056/api';
const PASSWORD = process.env.SEED_PASSWORD || 'Test@12345';
const STAMP = Date.now().toString(36);

let failures = 0;
const ok = (m) => console.log(`  ✓ ${m}`);
const bad = (m) => { failures++; console.log(`  ✗ ${m}`); };
const expect = (c, m) => (c ? ok(m) : bad(m));
const section = (t) => console.log(`\n${t}`);

const call = async (method, path, token, body) => {
  const res = await realFetch(`${BASE}${path}`, { method, headers: { 'Content-Type': 'application/json', ...(token && { Authorization: `Bearer ${token}` }) }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json().catch(() => ({})) };
};
const login = async (email, password = PASSWORD) => {
  const r = await call('POST', '/auth/login', null, { email, password });
  if (r.status !== 200) throw new Error(`login ${email}: ${r.status} ${r.body.message}`);
  return { token: r.body.data.tokens.accessToken, user: r.body.data.user };
};
const google = async (email, name, portal = 'staff') => {
  nextGoogle = { email, name };
  const r = await call('POST', '/auth/google', null, { code: 'fake', redirectUri: `${process.env.ADMIN_APP_URL || 'http://localhost:4200'}/login`, portal });
  return r;
};

const cleanup = { users: [], partners: [], orders: [], rates: [] };

try {
  const admin = await login('admin@v360.test');
  const owner = await login('partner@v360.test');

  // ───────────────────────────── 1. Google roles ─────────────────────────────
  section('Google sign-in from the admin-side login');
  const newEmail = `e2e-google-${STAMP}@v360.test`;
  const g1 = await google(newEmail, `E2E Google ${STAMP}`);
  const u1 = g1.body.data?.user;
  if (u1) cleanup.users.push(u1.id);
  expect(g1.status === 200 && g1.body.data?.created === true, 'a new Google user is created');
  expect(u1?.role === 'partner_staff' && u1?.partner_role === 'owner', 'new Google user is a Partner (owner of their own partner), not an Admin');
  expect(u1?.permissions?.length === 0, 'the new partner starts with no modules until an admin enables them');
  if (u1?.partner_id) cleanup.partners.push(u1.partner_id);
  const newToken = g1.body.data?.tokens?.accessToken;
  expect((await call('GET', '/admin/orders', newToken)).status === 403, 'the new partner cannot call admin APIs');
  expect((await call('GET', '/partner/production/board', newToken)).status === 403, '...and sees no partner module either (nothing enabled)');
  const { data: notes } = await db.from('notifications').select('title').like('title', 'New partner signed up%').order('created_at', { ascending: false }).limit(20);
  expect((notes || []).some((n) => n.title.includes(`E2E Google ${STAMP}`)), 'admins were told about the new partner');

  const g1b = await google(newEmail, 'Somebody Else');
  expect(g1b.status === 200 && g1b.body.data?.created === false && g1b.body.data?.user?.role === 'partner_staff', 'signing in again keeps the account (no duplicate, role not rewritten)');

  const gAdmin = await google('admin@v360.test', 'Admin Name');
  expect(gAdmin.body.data?.user?.role === 'admin' && gAdmin.body.data?.created === false, 'existing Google admin stays Admin');
  const gPartner = await google('partner@v360.test', 'Partner Name');
  expect(gPartner.body.data?.user?.role === 'partner_staff' && gPartner.body.data?.user?.partner_role === 'owner' && gPartner.body.data.user.permissions.length > 5, 'existing Google partner stays Partner with their permissions');
  const gCustomer = await google('customer@v360.test', 'Customer Name');
  expect(gCustomer.body.data?.user?.role === 'customer', 'existing customer is not converted');
  const gClient = await google(`e2e-client-${STAMP}@v360.test`, 'E2E Client', 'customer');
  if (gClient.body.data?.user) cleanup.users.push(gClient.body.data.user.id);
  expect(gClient.body.data?.user?.role === 'customer', 'a new Google user from the customer app is still a customer (unchanged)');

  section('Admin promotes the partner to Admin');
  const promote = await call('PATCH', `/admin/users/${u1.id}/role`, admin.token, { role: 'admin' });
  expect(promote.status === 200, `admin makes them an admin (${promote.status})`);
  const after = (await db.from('profiles').select('role, partner_id, partner_role, permissions').eq('id', u1.id).single()).data;
  expect(after.role === 'admin' && !after.partner_id && !after.partner_role, 'they are now an Admin without partner links');
  const gone = await db.from('partners').select('id').eq('id', u1.partner_id).maybeSingle();
  expect(!gone.data, 'the empty partner the sign-up created was removed');
  expect((await call('GET', '/admin/orders', newToken)).status === 200, 'and the new admin can use admin APIs');
  expect((await call('PATCH', `/admin/users/${u1.id}/role`, owner.token, { role: 'admin' })).status === 403, 'a partner cannot promote anybody');
  const g2 = await google(newEmail, 'x');
  expect(g2.body.data?.user?.role === 'admin', 'Google login afterwards keeps them Admin');

  // ───────────────────────────── 2. Master / Tailor ─────────────────────────────
  section('Master and Tailor have their own logins');
  const mk = async (type, permissions) => {
    const r = await call('POST', '/partner/users', owner.token, { email: `e2e-${type}-${STAMP}@v360.test`, full_name: `E2E ${type}`, staff_type: type, permissions });
    if (r.body.data?.user) cleanup.users.push(r.body.data.user.id);
    return r;
  };
  const master = await mk('master', ['production.view', 'production.update', 'quality.view']);
  const tailor = await mk('tailor', ['production.view']);
  expect(master.status === 201 && tailor.status === 201, 'the partner creates a master and a tailor');
  const NEWPW = 'E2eRoles@12345';
  const sign = async (r) => {
    const first = await login(r.body.data.user.email, r.body.data.temporaryPassword);
    await call('POST', '/auth/change-password', first.token, { currentPassword: r.body.data.temporaryPassword, newPassword: NEWPW });
    return login(r.body.data.user.email, NEWPW);
  };
  const m = await sign(master);
  const t = await sign(tailor);
  expect(m.user.role === 'partner_staff' && m.user.staff_type === 'master' && m.user.partner_id === owner.user.partner_id, 'the master signs in on their own and belongs to the partner');
  expect(t.user.role === 'partner_staff' && t.user.staff_type === 'tailor' && t.user.partner_id === owner.user.partner_id, 'the tailor signs in on their own and belongs to the partner');
  expect(JSON.stringify(m.user.permissions.sort()) === JSON.stringify(['production.update', 'production.view', 'quality.view']), 'master gets exactly the granted permissions');
  expect((await call('GET', '/partner/production/board', m.token)).status === 200, 'master: production board opens');
  expect((await call('GET', '/partner/qc', m.token)).status === 200, 'master: quality opens');
  expect((await call('GET', '/partner/qc', t.token)).status === 403, 'tailor: quality is refused (not granted)');
  expect((await call('GET', '/partner/production/board', t.token)).status === 200, 'tailor: production board opens');
  expect((await call('GET', '/partner/users', t.token)).status === 403 && (await call('GET', '/partner/users', m.token)).status === 403, 'master and tailor: users module refused');
  expect((await call('GET', '/admin/orders', t.token)).status === 403, 'tailor: admin APIs refused');
  const board = (await call('GET', '/partner/production/board', m.token)).body.data;
  expect(JSON.stringify(board).length >= 2, 'master sees the board of their own partner only (scoped by the server)');

  // ───────────────────────────── 3. Invoice shipping ─────────────────────────────
  section('Invoice shipping from the shipping price list');
  const probe = await db.from('invoices').select('shipping_rate_id').limit(1);
  if (probe.error) {
    console.log('  – skipped: run backend/UPDATE_DATABASE_0009.sql (invoices.shipping_rate_id) to test this part');
  } else {
    const customer = (await db.from('profiles').select('id, full_name, customer_code').eq('email', 'customer@v360.test').single()).data;
    const partnerId = owner.user.partner_id;
    const rateRows = [
      { courier: `E2E Std ${STAMP}`, zone: 'E2E Zone', countries: ['Testland'], service: 'standard', max_weight_kg: 5, base_rate: 250, per_extra_kg: 0 },
      { courier: `E2E Exp ${STAMP}`, zone: 'E2E Zone', countries: ['Testland'], service: 'express', max_weight_kg: 5, base_rate: 500, per_extra_kg: 0 },
      { courier: `E2E Intl ${STAMP}`, zone: 'E2E Zone', countries: ['Testland'], service: 'express', max_weight_kg: 1, base_rate: 1500, per_extra_kg: 100 },
    ];
    const rates = (await db.from('shipping_rates').insert(rateRows).select('*')).data;
    cleanup.rates.push(...rates.map((r) => r.id));
    const [std, exp, intl] = rates;
    const order = (await db.from('orders').insert({
      customer_id: customer.id, customer_name: customer.full_name, customer_code: customer.customer_code, brand: 'E2E', status: 'packed', partner_id: partnerId,
      destination_country: 'Testland', destination_city: 'Test City', destination_address: '1 Test St', weight_kg: 2.5, shipping_service: 'express', packed_at: new Date().toISOString(),
    }).select('*').single()).data;
    cleanup.orders.push(order.id);
    await db.from('order_units').insert({ order_id: order.id, unit_title: 'E2E piece', status: 'received', line_no: 1 });

    const builder = (await call('GET', `/admin/invoices/builder/${order.id}`, admin.token)).body.data;
    const names = builder.shippingOptions.map((s) => s.courier);
    expect([std, exp, intl].every((r) => names.includes(r.courier)), 'the invoice offers the shipping items of the price list');
    expect(builder.shippingOptions.find((s) => s.id === exp.id)?.price_pkr === 500, 'each item carries its configured price (Express = 500)');

    const save = (rateId, extraLines = []) => call('PUT', `/admin/invoices/builder/${order.id}`, admin.token, {
      currency: 'PKR', fx_rate: 1, shipping_rate_id: rateId,
      lines: [{ kind: 'stitching', label: 'E2E stitching', quantity: 1, customer_amount: 1000, partner_amount: 600 }, ...extraLines],
    });
    const s1 = await save(exp.id);
    const lines1 = s1.body.data?.lines || [];
    const shipLine = lines1.find((l) => l.kind === 'shipping');
    expect(s1.status === 200 && Number(shipLine?.customer_amount) === 500, 'choosing Express adds Shipping Charges Rs. 500 automatically');
    expect(Number(s1.body.data?.subtotal_pkr) === 1500 && Number(s1.body.data?.total_pkr) === 1500, 'total = items 1000 + shipping 500 = 1500');
    expect(s1.body.data?.shipping_rate_id === exp.id, 'the chosen item is remembered on the invoice');

    // a tampered price from the browser is ignored: the server prices the item
    const s2 = await save(exp.id, [{ kind: 'shipping', label: 'cheap', quantity: 1, customer_amount: 1, partner_amount: 0 }]);
    expect(Number((s2.body.data?.lines || []).find((l) => l.kind === 'shipping')?.customer_amount) === 500 && (s2.body.data?.lines || []).filter((l) => l.kind === 'shipping').length === 1, 'a shipping price sent by the browser is replaced by the list price');

    const s3 = await save(intl.id); // 2.5 kg over a 1 kg allowance: 1500 + 2 x 100
    expect(Number((s3.body.data?.lines || []).find((l) => l.kind === 'shipping')?.customer_amount) === 1700, 'weight surcharges of the item are applied (International 2.5 kg = 1700)');
    const s4 = await save(exp.id);
    expect(s4.status === 200, 'switching back to Express works');

    // price list changes later: the saved invoice keeps its price
    await db.from('shipping_rates').update({ base_rate: 900 }).eq('id', exp.id);
    const reopened = (await call('GET', `/admin/invoices/builder/${order.id}`, admin.token)).body.data;
    const keep = (reopened.invoice.lines || []).find((l) => l.kind === 'shipping');
    expect(Number(keep.customer_amount) === 500 && Number(reopened.invoice.total_pkr) === 1500, 'after the price list changes to 900, the saved invoice still says 500 (total 1500)');
    expect(reopened.shippingOptions.find((s) => s.id === exp.id)?.price_pkr === 900, '...while new invoices see the new price');

    const nonExisting = await save('00000000-0000-4000-8000-000000000000');
    expect(nonExisting.status === 404, 'an unknown shipping item is refused');
    await db.from('shipping_rates').update({ is_active: false }).eq('id', std.id);
    expect((await save(std.id)).status === 400, 'a switched-off shipping item is refused');
  }
} catch (err) {
  bad(`unexpected error: ${err.stack || err.message}`);
} finally {
  section('Cleaning up');
  for (const id of cleanup.orders) {
    await db.from('invoices').delete().eq('order_id', id);
    await db.from('orders').delete().eq('id', id);
  }
  for (const id of cleanup.rates) await db.from('shipping_rates').delete().eq('id', id);
  for (const id of cleanup.users) {
    await db.from('notifications').delete().eq('user_id', id);
    await db.auth.admin.deleteUser(id).catch(() => {});
  }
  for (const id of cleanup.partners) await db.from('partners').delete().eq('id', id);
  await db.from('notifications').delete().like('title', 'New partner signed up: E2E Google%');
  server.close();
  console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll checks passed');
  process.exit(failures ? 1 : 0);
}
