/**
 * End-to-end test (HTTP) of the hierarchy Admin -> Partners -> partner users, and of the forward-only order status.
 * The backend must be running with migration 0005 applied (run backend/UPDATE_DATABASE_0005.sql first).
 * Uses the accounts from `npm run seed`. Everything it creates is named "E2E ..." and removed at the end.
 *
 *   npm run test:rbac
 */
import 'dotenv/config';
import { supabaseAdmin } from '../src/config/supabase.js';
import { ALL_PERMISSIONS } from '../src/config/permissions.js';

const ORIGIN = process.env.API_ORIGIN || 'http://localhost:5000';
const BASE = `${ORIGIN}/api`;
const PASSWORD = process.env.SEED_PASSWORD || 'Test@12345';
const NEW_PASSWORD = 'E2eRbac@12345';
const STAMP = Date.now().toString(36);

let failures = 0;
const ok = (m) => console.log(`  ✓ ${m}`);
const fail = (m) => {
  failures++;
  console.log(`  ✗ ${m}`);
};
const expect = (c, m) => (c ? ok(m) : fail(m));
const section = (t) => console.log(`\n${t}`);

async function call(token, method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token && { Authorization: `Bearer ${token}` }) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(`${method} ${path} → ${res.status}: ${json.message}`), { status: res.status, body: json });
  return json;
}
/** Expect the call to be rejected with one of the given statuses. */
const rejects = async (label, promise, statuses, re) => {
  const list = [].concat(statuses);
  try {
    await promise;
    fail(`${label}: should have been refused (${list.join('/')})`);
  } catch (e) {
    expect(list.includes(e.status) && (!re || re.test(e.message)), `${label} → ${e.status} ${(e.body?.message || e.message).slice(0, 80)}`);
  }
};
const login = async (email, password = PASSWORD) => (await call(null, 'POST', '/auth/login', { email, password })).data;

const created = { users: [], partners: [], orders: [] };

async function cleanup() {
  for (const id of created.orders) await supabaseAdmin.from('orders').delete().eq('id', id);
  for (const id of created.partners) await supabaseAdmin.from('team_members').delete().eq('partner_id', id);
  for (const id of created.users) await supabaseAdmin.auth.admin.deleteUser(id).catch(() => {});
  for (const id of created.partners) await supabaseAdmin.from('partners').delete().eq('id', id);
}

const newOrder = async (C, title) => {
  const brand = (await call(C, 'GET', '/client/brands?search=Sapphire')).data[0];
  const courier = (await call(C, 'GET', '/client/couriers?search=TCS')).data[0];
  const order = (await call(C, 'POST', '/client/orders', {
    brand_id: brand.id, courier_id: courier.id, tracking_number: `E2E-${STAMP}`, international_shipping: false,
    units: [{ unit_title: `E2E ${title}`, quantity: 1, article_ids: [] }],
  })).data;
  created.orders.push(order.id);
  return order;
};

async function main() {
  section('Preflight');
  const probe = await supabaseAdmin.from('partners').select('id').limit(1);
  if (probe.error) throw new Error(`The partners table is missing (${probe.error.message}). Run backend/UPDATE_DATABASE_0005.sql in the Supabase SQL Editor first.`);
  ok('migration 0005 is applied');

  const [admin, customer] = await Promise.all([login('admin@v360.test'), login('customer@v360.test')]);
  const A = admin.tokens.accessToken;
  const C = customer.tokens.accessToken;
  expect(admin.user.role === 'admin' && admin.user.permissions.length === ALL_PERMISSIONS.length, 'admin login carries every permission');
  const catalogue = (await call(A, 'GET', '/admin/permissions')).data.modules;
  const cataloguePerms = catalogue.flatMap((m) => m.actions.map((a) => `${m.id}.${a}`));
  expect(JSON.stringify(cataloguePerms) === JSON.stringify(ALL_PERMISSIONS), 'permission catalogue matches the code');

  // ───────────────────────── no public staff sign-up ─────────────────────────
  section('Staff sign-up is gone');
  await rejects('register as staff', call(null, 'POST', '/auth/register', {
    email: `e2e-staff-${STAMP}@v360.test`, password: PASSWORD, fullName: 'E2E Staff', phone: '+92 300 0000000', portal: 'staff', requestedRole: 'partner_staff',
  }), [400, 403]);
  const stray = await supabaseAdmin.from('profiles').select('id').eq('email', `e2e-staff-${STAMP}@v360.test`).maybeSingle();
  expect(!stray.data, 'no account was created');

  // ───────────────────────── admin creates partners ─────────────────────────
  section('Admin creates Partner A and Partner B');
  const permsA = ['overview.view', 'production.view', 'production.update', 'quality.view', 'messages.view', 'messages.update', 'users.view', 'users.create', 'users.update', 'teams.view', 'teams.update'];
  const permsB = ['production.view', 'receiving.view', 'receiving.update', 'users.view'];
  await rejects('unknown permission', call(A, 'POST', '/admin/partners', { name: `E2E Bad ${STAMP}`, permissions: ['orders.view'], owner: { email: `e2e-bad-${STAMP}@v360.test`, full_name: 'X' } }), 400);
  await rejects('no module at all', call(A, 'POST', '/admin/partners', { name: `E2E Empty ${STAMP}`, permissions: [], owner: { email: `e2e-empty-${STAMP}@v360.test`, full_name: 'X' } }), 400);
  const pa = (await call(A, 'POST', '/admin/partners', { name: `E2E Partner A ${STAMP}`, permissions: permsA, owner: { email: `e2e-a-${STAMP}@v360.test`, full_name: 'E2E Owner A' } })).data;
  const pb = (await call(A, 'POST', '/admin/partners', { name: `E2E Partner B ${STAMP}`, permissions: permsB, owner: { email: `e2e-b-${STAMP}@v360.test`, full_name: 'E2E Owner B' } })).data;
  created.partners.push(pa.partner.id, pb.partner.id);
  created.users.push(pa.owner.id, pb.owner.id);
  expect(pa.temporaryPassword?.length >= 8 && pa.owner.partner_role === 'owner' && pa.owner.must_change_password === true, 'owner created with a one-time temporary password');
  await rejects('duplicate partner name', call(A, 'POST', '/admin/partners', { name: `e2e partner a ${STAMP}`, permissions: permsA, owner: { email: `e2e-dup-${STAMP}@v360.test`, full_name: 'X' } }), 409);
  await rejects('owner email already used', call(A, 'POST', '/admin/partners', { name: `E2E Other ${STAMP}`, permissions: permsA, owner: { email: `e2e-a-${STAMP}@v360.test`, full_name: 'X' } }), 409);
  const none = await supabaseAdmin.from('partners').select('id').eq('name', `E2E Other ${STAMP}`).maybeSingle();
  expect(!none.data, 'a failed owner creation leaves no half-created partner behind');

  section('Owner logs in: temporary password must be replaced first');
  let ownerA = await login(`e2e-a-${STAMP}@v360.test`, pa.temporaryPassword);
  expect(ownerA.user.must_change_password === true && ownerA.user.role === 'partner_staff', 'login works, flagged for a password change');
  await rejects('partner pages before the change', call(ownerA.tokens.accessToken, 'GET', '/partner/overview'), 403, /password/i);
  await rejects('wrong current password', call(ownerA.tokens.accessToken, 'POST', '/auth/change-password', { currentPassword: 'nope-nope', newPassword: NEW_PASSWORD }), 400);
  await call(ownerA.tokens.accessToken, 'POST', '/auth/change-password', { currentPassword: pa.temporaryPassword, newPassword: NEW_PASSWORD });
  ownerA = await login(`e2e-a-${STAMP}@v360.test`, NEW_PASSWORD);
  let ownerB = await login(`e2e-b-${STAMP}@v360.test`, pb.temporaryPassword);
  await call(ownerB.tokens.accessToken, 'POST', '/auth/change-password', { currentPassword: pb.temporaryPassword, newPassword: NEW_PASSWORD });
  ownerB = await login(`e2e-b-${STAMP}@v360.test`, NEW_PASSWORD);
  const OA = ownerA.tokens.accessToken;
  const OB = ownerB.tokens.accessToken;
  expect(ownerA.user.must_change_password === false, 'after changing it the flag is cleared');
  expect(JSON.stringify([...ownerA.user.permissions].sort()) === JSON.stringify([...permsA].sort()), 'owner A sees exactly the modules the admin enabled');
  expect(ownerA.user.partner?.name === `E2E Partner A ${STAMP}`, 'login tells the app which partner this is');

  section('Modules the admin did not enable are refused by the API');
  await call(OA, 'GET', '/partner/overview');
  ok('Partner A: overview works');
  await rejects('Partner A: receiving (not enabled)', call(OA, 'GET', '/partner/receiving'), 403);
  await rejects('Partner A: warehouse (not enabled)', call(OA, 'GET', '/partner/warehouse'), 403);
  await rejects('Partner A: earnings (not enabled)', call(OA, 'GET', '/partner/earnings'), 403);
  await rejects('Partner A: catalogue (not enabled)', call(OA, 'GET', '/partner/brands'), 403);
  await rejects('Partner B: overview (not enabled)', call(OB, 'GET', '/partner/overview'), 403);
  await rejects('Partner B: messages (not enabled)', call(OB, 'GET', '/partner/conversations'), 403);
  await rejects('a partner cannot use admin APIs', call(OA, 'GET', '/admin/partners'), 403);
  await rejects('a customer cannot use partner APIs', call(C, 'GET', '/partner/overview'), 403);
  await rejects('no token', call(null, 'GET', '/partner/overview'), 401);

  // ───────────────────────── partner A creates its own users ─────────────────────────
  section('Partner A creates its own users');
  const master = (await call(OA, 'POST', '/partner/users', {
    email: `e2e-master-${STAMP}@v360.test`, full_name: 'E2E Master A1', job_title: 'Master Tailor', permissions: ['production.view', 'production.update'],
  })).data;
  created.users.push(master.user.id);
  expect(master.user.partner_id === pa.partner.id && master.user.partner_role === 'member', 'the user belongs to partner A (taken from the session)');
  const tailor = (await call(OA, 'POST', '/partner/users', {
    email: `e2e-tailor-${STAMP}@v360.test`, full_name: 'E2E Tailor A2', job_title: 'Tailor', permissions: ['production.view'],
  })).data;
  created.users.push(tailor.user.id);
  await rejects('grant a module partner A does not have', call(OA, 'POST', '/partner/users', {
    email: `e2e-x1-${STAMP}@v360.test`, full_name: 'X', permissions: ['warehouse.view'],
  }), 400);
  await rejects('grant an unknown permission', call(OA, 'POST', '/partner/users', {
    email: `e2e-x2-${STAMP}@v360.test`, full_name: 'X', permissions: ['everything'],
  }), 400);
  await rejects('same email twice', call(OA, 'POST', '/partner/users', {
    email: `e2e-master-${STAMP}@v360.test`, full_name: 'X', permissions: ['production.view'],
  }), 409);
  const tamper = (await call(OA, 'POST', '/partner/users', {
    email: `e2e-tamper-${STAMP}@v360.test`, full_name: 'E2E Tamper', permissions: ['production.view'], partner_id: pb.partner.id, role: 'admin', partner_role: 'owner',
  })).data;
  created.users.push(tamper.user.id);
  expect(tamper.user.partner_id === pa.partner.id && tamper.user.role === 'partner_staff' && tamper.user.partner_role === 'member', 'partner_id / role sent in the body are ignored');
  await call(OA, 'DELETE', `/partner/users/${tamper.user.id}`);

  const users = (await call(OA, 'GET', '/partner/users')).data;
  expect(users[0].is_owner && users.length === 4 && users.every((u) => u.partner_id === pa.partner.id), 'list shows only partner A\'s people (owner first)');
  const usersB = (await call(OB, 'GET', '/partner/users')).data;
  expect(usersB.length === 1 && usersB[0].partner_id === pb.partner.id, 'partner B only sees its own owner');
  await rejects('A edits B\'s owner', call(OA, 'PATCH', `/partner/users/${pb.owner.id}`, { full_name: 'Hacked' }), [403, 404]);
  await rejects('B creates a user (no users.create)', call(OB, 'POST', '/partner/users', { email: `e2e-b2-${STAMP}@v360.test`, full_name: 'X', permissions: ['production.view'] }), 403);

  section('A user logs in with only what partner A gave them');
  let masterLogin = await login(`e2e-master-${STAMP}@v360.test`, master.temporaryPassword);
  await call(masterLogin.tokens.accessToken, 'POST', '/auth/change-password', { currentPassword: master.temporaryPassword, newPassword: NEW_PASSWORD });
  masterLogin = await login(`e2e-master-${STAMP}@v360.test`, NEW_PASSWORD);
  const M = masterLogin.tokens.accessToken;
  expect(JSON.stringify([...masterLogin.user.permissions].sort()) === JSON.stringify(['production.update', 'production.view']), 'effective permissions: production.view + production.update');
  await call(M, 'GET', '/partner/production/board');
  ok('master: production board opens');
  await rejects('master: users module', call(M, 'GET', '/partner/users'), 403);
  await rejects('master: quality module', call(M, 'GET', '/partner/qc'), 403);
  await rejects('master: overview', call(M, 'GET', '/partner/overview'), 403);
  await rejects('master edits their own access', call(M, 'PATCH', `/partner/users/${master.user.id}`, { permissions: ['production.view', 'users.update'] }), 403);
  const tailorLogin = await login(`e2e-tailor-${STAMP}@v360.test`, tailor.temporaryPassword);
  await rejects('tailor: still has a temporary password', call(tailorLogin.tokens.accessToken, 'GET', '/partner/production/board'), 403, /password/i);

  // ───────────────────────── data isolation ─────────────────────────
  section('Data isolation: two orders, one per partner');
  const o1 = await newOrder(C, 'for A');
  const o2 = await newOrder(C, 'for B');
  await call(A, 'POST', `/admin/orders/${o1.id}/partner`, { partner_id: pa.partner.id });
  await call(A, 'POST', `/admin/orders/${o2.id}/partner`, { partner_id: pb.partner.id });
  await rejects('assign to a partner that does not exist', call(A, 'POST', `/admin/orders/${o1.id}/partner`, { partner_id: '00000000-0000-0000-0000-000000000000' }), 404);
  await rejects('a partner cannot reassign orders', call(OA, 'POST', `/admin/orders/${o2.id}/partner`, { partner_id: pa.partner.id }), 403);
  // an admin receives both parcels so each order gets its production ticket
  await call(A, 'POST', `/partner/receiving/orders/${o1.id}/receive-all`);
  await call(A, 'POST', `/partner/receiving/orders/${o2.id}/receive-all`);
  const cardsOf = async (orderId) => (await supabaseAdmin.from('job_cards').select('id, partner_id').eq('order_id', orderId)).data;
  const [cardA] = await cardsOf(o1.id);
  const [cardB] = await cardsOf(o2.id);
  expect(cardA?.partner_id === pa.partner.id && cardB?.partner_id === pb.partner.id, 'each ticket belongs to the partner of its order');

  const board = async (token) => (await call(token, 'GET', '/partner/production/board?limit=50')).data.columns.flatMap((c) => c.items.map((i) => i.id));
  const idsA = await board(OA);
  const idsB = await board(OB);
  expect(idsA.includes(cardA.id) && !idsA.includes(cardB.id), 'Partner A\'s board shows only its own ticket');
  expect(idsB.includes(cardB.id) && !idsB.includes(cardA.id), 'Partner B\'s board shows only its own ticket');
  expect((await board(M)).includes(cardA.id) && !(await board(M)).includes(cardB.id), 'the master of A sees the same board as A');
  const adminIds = await board(A);
  expect(adminIds.includes(cardA.id) && adminIds.includes(cardB.id), 'the admin sees every partner\'s tickets');

  await rejects('A opens B\'s ticket', call(OA, 'GET', `/partner/production/cards/${cardB.id}`), 403);
  await rejects('A moves B\'s ticket', call(OA, 'PUT', `/partner/production/cards/${cardB.id}/move`, { stage: 'cutting' }), 403);
  await rejects('master of A moves B\'s ticket', call(M, 'PUT', `/partner/production/cards/${cardB.id}/move`, { stage: 'cutting' }), 403);
  await rejects('A comments on B\'s ticket', call(OA, 'POST', `/partner/production/cards/${cardB.id}/comments`, { body: 'hi' }), 403);
  await rejects('A reads B\'s conversation', call(OA, 'GET', `/partner/orders/${o2.id}/conversation`), 403);
  await rejects('A messages B\'s customer', call(OA, 'POST', `/partner/orders/${o2.id}/messages`, { kind: 'text', body: 'hello' }), 403);
  await rejects('B opens A\'s ticket', call(OB, 'GET', `/partner/production/cards/${cardA.id}`), 403);
  await rejects('a made-up ticket id', call(OA, 'GET', '/partner/production/cards/00000000-0000-0000-0000-000000000000'), 404);
  await rejects('a malformed id', call(OA, 'GET', '/partner/production/cards/not-a-uuid'), 404);
  const boardSearch = (await call(OA, 'GET', `/partner/production/board?search=${o2.reference}&limit=50`)).data.columns.flatMap((c) => c.items);
  expect(boardSearch.length === 0, 'searching for B\'s order reference finds nothing on A\'s board');
  const scan = (await call(OA, 'GET', `/partner/production/scan?code=${o2.reference}`)).data;
  expect(scan.length === 0, 'scanning B\'s order code finds nothing for A');
  const filterTamper = (await call(OA, 'GET', `/partner/production/board?scopePartner=${pb.partner.id}&partnerId=${pb.partner.id}&limit=50`)).data.columns.flatMap((c) => c.items.map((i) => i.id));
  expect(!filterTamper.includes(cardB.id), 'extra query parameters cannot widen the partner scope');

  const moved = (await call(M, 'PUT', `/partner/production/cards/${cardA.id}/move`, { stage: 'cutting', prevId: cardB.id })).data;
  expect(moved.card.stage === 'cutting', 'master of A can move A\'s ticket (production.update)');

  section('Team members stay inside their partner');
  const tm = (await call(OA, 'POST', '/partner/teams/members', { name: `E2E Master ${STAMP}`, role: 'master', daily_capacity: 5, partner_id: pb.partner.id })).data;
  expect(tm.partner_id === pa.partner.id, 'a partner_id in the body is ignored: the member belongs to partner A');
  const teamA = (await call(OA, 'GET', '/partner/teams')).data.members.map((m) => m.id);
  const teamB = (await call(OB, 'GET', '/partner/teams')).data.members.map((m) => m.id);
  expect(teamA.includes(tm.id), 'partner A lists its new member');
  expect(!teamB.includes(tm.id), 'partner B (which may read the team for assignments) does not see the other partner\'s people');
  await rejects('A assigns B\'s ticket to its master', call(OA, 'POST', `/partner/production/cards/${cardB.id}/assign`, { master_id: tm.id }), 403);
  const foreignMaster = (await supabaseAdmin.from('team_members').insert({ name: `E2E Foreign ${STAMP}`, role: 'master', daily_capacity: 5, partner_id: pb.partner.id }).select('id').single()).data;
  await rejects('A gives its ticket to B\'s master', call(OA, 'POST', `/partner/production/cards/${cardA.id}/assign`, { master_id: foreignMaster.id }), 403);
  await rejects('A edits B\'s team member', call(OA, 'PATCH', `/partner/teams/members/${foreignMaster.id}`, { name: 'Hacked' }), 403);

  section('Admin changes access: the effect is immediate');
  await call(A, 'PATCH', `/admin/partners/${pa.partner.id}`, { permissions: permsA.filter((p) => p !== 'production.update') });
  await rejects('master lost production.update', call(M, 'PUT', `/partner/production/cards/${cardA.id}/move`, { stage: 'stitching' }), 403);
  await call(M, 'GET', '/partner/production/board');
  ok('...but can still view the board');
  const me = (await call(M, 'GET', '/auth/me')).data.user;
  expect(!me.permissions.includes('production.update') && me.permissions.includes('production.view'), 'the app gets the shrunk permission list from /auth/me');
  const stored = (await supabaseAdmin.from('profiles').select('permissions').eq('id', master.user.id).single()).data.permissions;
  expect(!stored.includes('production.update'), 'a module taken from the partner is also removed from its users (it does not come back by itself)');
  await call(A, 'PATCH', `/admin/partners/${pa.partner.id}`, { status: 'inactive' });
  await rejects('partner switched off: owner is refused', call(OA, 'GET', '/partner/overview'), 403);
  await rejects('partner switched off: master is refused', call(M, 'GET', '/partner/production/board'), 403);
  await rejects('partner switched off: sign-in is refused', call(null, 'POST', '/auth/login', { email: `e2e-a-${STAMP}@v360.test`, password: NEW_PASSWORD }), 403);
  await call(A, 'PATCH', `/admin/partners/${pa.partner.id}`, { status: 'active' });
  await call(OA, 'GET', '/partner/overview');
  ok('switched back on: access returns');

  section('Users can be switched off and get a new temporary password');
  await call(OA, 'DELETE', `/partner/users/${tailor.user.id}`);
  await rejects('switched-off user signs in', call(null, 'POST', '/auth/login', { email: `e2e-tailor-${STAMP}@v360.test`, password: tailor.temporaryPassword }), [401, 403]);
  const reset = (await call(OA, 'POST', `/partner/users/${master.user.id}/reset-password`)).data;
  await rejects('old password after a reset', call(null, 'POST', '/auth/login', { email: `e2e-master-${STAMP}@v360.test`, password: NEW_PASSWORD }), [400, 401]);
  const again = await login(`e2e-master-${STAMP}@v360.test`, reset.temporaryPassword);
  expect(again.user.must_change_password === true, 'the new temporary password must be replaced at next sign-in');

  // ───────────────────────── order status is forward-only ─────────────────────────
  section('Order status can never go backwards once paid');
  const set = (id, status) => call(A, 'PATCH', `/admin/orders/${id}`, { status, notifyCustomer: false });
  const o3 = await newOrder(C, 'status');
  await set(o3.id, 'packed');
  await set(o3.id, 'stitching');
  ok('before payment an order can still move back (rework)');
  await set(o3.id, 'packed');
  await set(o3.id, 'paid');
  await rejects('paid -> packed', set(o3.id, 'packed'), 409);
  await set(o3.id, 'shipped');
  await rejects('shipped -> packed', set(o3.id, 'packed'), 409, /shipped/i);
  await rejects('shipped -> paid', set(o3.id, 'paid'), 409);
  await rejects('shipped -> cancelled', set(o3.id, 'cancelled'), 409);
  await set(o3.id, 'delivered');
  await rejects('delivered -> shipped', set(o3.id, 'shipped'), 409);
  const final = (await call(A, 'GET', `/admin/orders/${o3.id}`)).data;
  expect(final.status === 'delivered' && final.status_label === 'Delivered', 'the persisted status is Delivered');
  const direct = await supabaseAdmin.from('orders').update({ status: 'packed' }).eq('id', o3.id);
  expect(!!direct.error, `the database itself refuses it too (${(direct.error?.message || '').slice(0, 60)})`);
  const events = final.events.map((e) => e.status);
  expect(events.indexOf('delivered') > events.indexOf('shipped') && !events.slice(events.indexOf('shipped')).includes('packed'), 'the timeline never shows "packed" after "shipped"');

  section('Articles of a delivered order do not read "Packed"');
  const o4 = await newOrder(C, 'articles');
  await call(A, 'POST', `/partner/receiving/orders/${o4.id}/receive-all`);
  const [card4] = await cardsOf(o4.id);
  await supabaseAdmin.from('job_cards').update({ stage: 'packed', qc_passed: true, packed_at: new Date().toISOString() }).eq('id', card4.id);
  await set(o4.id, 'packed');
  await set(o4.id, 'paid');
  await set(o4.id, 'shipped');
  await set(o4.id, 'delivered');
  const detail = (await call(A, 'GET', `/admin/orders/${o4.id}`)).data;
  const c4 = detail.cards.find((c) => c.id === card4.id);
  expect(c4.stage === 'packed' && c4.display_status === 'delivered' && c4.display_label === 'Delivered', `admin sees the article as "${c4.display_label}" (raw stage stays "${c4.stage}")`);
  const custView = (await call(C, 'GET', `/client/orders/${o4.id}`)).data;
  const steps = custView.units[0].timeline.map((t) => t.status);
  expect(steps.at(-1) === 'delivered' && steps.includes('shipped'), `the customer's article timeline ends with "${steps.at(-1)}"`);
}

try {
  await main();
} catch (err) {
  failures++;
  console.log(`\n  ✗ ${err.message}`);
} finally {
  section('Cleaning up');
  await cleanup().catch((e) => console.log('  cleanup problem:', e.message));
}
console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll checks passed');
process.exit(failures ? 1 : 0);
