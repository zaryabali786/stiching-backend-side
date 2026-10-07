/**
 * End-to-end test (HTTP + real websockets) of order messages and live notifications:
 *  - a partner only ever sees the chats of its OWN orders;
 *  - General chats (about the order itself, not one article) are admin-only until the admin enables "General messages";
 *  - sockets are re-checked per person: no events for another partner, for a partner without the permission, or after
 *    a permission is taken away;
 *  - notifications reach the open app over the websocket with the notification itself.
 * Runs the API in this process (port 5057) against the real database. Everything created is removed at the end.
 *
 *   node scripts/e2e-messages-realtime.mjs
 */
import 'dotenv/config';
import http from 'node:http';
import { io as connect } from 'socket.io-client';

const { default: app } = await import('../src/app.js');
const { initSocket } = await import('../src/realtime/socket.js');
const { supabaseAdmin: db } = await import('../src/config/supabase.js');
const server = http.createServer(app);
initSocket(server);
await new Promise((r) => server.listen(5057, r));
const ORIGIN = 'http://localhost:5057';
const BASE = `${ORIGIN}/api`;
const PASSWORD = process.env.SEED_PASSWORD || 'Test@12345';
const STAMP = Date.now().toString(36);

let failures = 0;
const ok = (m) => console.log(`  ✓ ${m}`);
const bad = (m) => { failures++; console.log(`  ✗ ${m}`); };
const expect = (c, m) => (c ? ok(m) : bad(m));
const section = (t) => console.log(`\n${t}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const call = async (method, path, token, body) => {
  const res = await fetch(`${BASE}${path}`, { method, headers: { 'Content-Type': 'application/json', ...(token && { Authorization: `Bearer ${token}` }) }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json().catch(() => ({})) };
};
const login = async (email, password = PASSWORD) => {
  const r = await call('POST', '/auth/login', null, { email, password });
  if (r.status !== 200) throw new Error(`login ${email}: ${r.status} ${r.body.message}`);
  return { token: r.body.data.tokens.accessToken, user: r.body.data.user };
};

/** A websocket that records what it receives. */
const listen = async (token) => {
  const events = { 'message:new': [], 'inbox:update': [], 'notification:new': [], 'message:read': [] };
  const socket = connect(ORIGIN, { auth: { token }, transports: ['websocket'], reconnection: false });
  for (const name of Object.keys(events)) socket.on(name, (p) => events[name].push(p));
  await new Promise((resolve, reject) => { socket.on('connect', resolve); socket.on('connect_error', reject); });
  const join = (orderId) => new Promise((resolve) => socket.emit('conversation:join', { orderId }, resolve));
  return { socket, events, join, clear: () => Object.values(events).forEach((l) => (l.length = 0)) };
};

const cleanup = { orders: [], users: [], partners: [], sockets: [] };
let restorePartner = null;

try {
  const admin = await login('admin@v360.test');
  const ownerA = await login('partner@v360.test'); // owner of the default partner A
  const customer = await login('customer@v360.test');
  const partnerA = ownerA.user.partner_id;
  restorePartner = { id: partnerA, permissions: (await db.from('partners').select('permissions').eq('id', partnerA).single()).data.permissions };

  // partner A must hold the messages module (the test does not depend on what it had before)
  const withMessages = [...new Set([...restorePartner.permissions.filter((p) => p !== 'general_messages.view' && p !== 'general_messages.update'), 'messages.view', 'messages.update'])];
  await call('PATCH', `/admin/partners/${partnerA}`, admin.token, { permissions: withMessages });

  // partner B with its own owner
  const bEmail = `e2e-b-${STAMP}@v360.test`;
  const created = await call('POST', '/admin/partners', admin.token, {
    name: `E2E Partner B ${STAMP}`, permissions: ['messages.view', 'messages.update', 'general_messages.view', 'general_messages.update', 'overview.view'],
    owner: { email: bEmail, full_name: 'E2E Owner B', password: 'E2eMsg@12345' },
  });
  expect(created.status === 201, `partner B created (${created.status} ${created.body.message || ''})`);
  const partnerB = created.body.data.partner.id;
  cleanup.partners.push(partnerB);
  cleanup.users.push(created.body.data.owner?.id || created.body.data.user?.id);
  const ownerB = await login(bEmail, 'E2eMsg@12345');
  // B's owner must replace the temporary password before the staff API opens
  await call('POST', '/auth/change-password', ownerB.token, { currentPassword: 'E2eMsg@12345', newPassword: 'E2eMsg@67890' });
  const ownerB2 = await login(bEmail, 'E2eMsg@67890');

  // an order of A with one article, an order of B
  const cust = (await db.from('profiles').select('id, full_name, customer_code').eq('email', 'customer@v360.test').single()).data;
  const mkOrder = async (partner_id, label) => {
    const o = (await db.from('orders').insert({ customer_id: cust.id, customer_name: cust.full_name, customer_code: cust.customer_code, brand: 'E2E', status: 'submitted', partner_id, destination_country: 'Pakistan' }).select('*').single()).data;
    cleanup.orders.push(o.id);
    const u = (await db.from('order_units').insert({ order_id: o.id, unit_title: `E2E ${label} piece`, line_no: 1, status: 'pending' }).select('*').single()).data;
    return { order: o, unit: u };
  };
  const A = await mkOrder(partnerA, 'A');
  const B = await mkOrder(partnerB, 'B');

  section('Realtime: sockets connected');
  const sCustomer = await listen(customer.token);
  const sAdmin = await listen(admin.token);
  const sA = await listen(ownerA.token);
  const sB = await listen(ownerB2.token);
  cleanup.sockets.push(sCustomer, sAdmin, sA, sB);
  const joinA = await sA.join(A.order.id);
  const joinB = await sB.join(A.order.id);
  await sCustomer.join(A.order.id);
  await sAdmin.join(A.order.id);
  await sB.join(B.order.id);
  expect(joinA.ok === true, 'partner A joins its own order conversation');
  expect(joinB.ok === false, 'partner B cannot join partner A\'s order conversation');

  const send = (orderId, unit_id, text) => call('POST', `/client/orders/${orderId}/messages`, customer.token, { kind: 'text', body: text, ...(unit_id ? { unit_id } : {}) });

  section('Article chat: only the order\'s own partner sees it');
  sCustomer.clear(); sAdmin.clear(); sA.clear(); sB.clear();
  const m1 = await send(A.order.id, A.unit.id, `E2E article question ${STAMP}`);
  await sleep(900);
  expect(m1.status === 201, 'customer writes about the article');
  expect(sA.events['message:new'].some((m) => m.body?.includes('article question')), 'partner A receives it live');
  expect(sAdmin.events['message:new'].length === 1, 'admin receives it live');
  expect(sB.events['message:new'].length === 0 && sB.events['inbox:update'].length === 0, 'partner B receives nothing (neither the message nor an inbox update)');
  expect(sA.events['notification:new'].some((e) => e.notification?.title?.includes(A.order.reference)), 'partner A gets the notification over the websocket, with the notification itself');
  expect(sAdmin.events['notification:new'].some((e) => e.notification?.title?.includes(A.order.reference)), 'the admin gets it too');
  expect(sB.events['notification:new'].length === 0, 'partner B gets no notification about it');

  section('General chat: admin only until enabled');
  sCustomer.clear(); sAdmin.clear(); sA.clear(); sB.clear();
  const g1 = await send(A.order.id, null, `E2E general question ${STAMP}`);
  await sleep(900);
  expect(g1.status === 201, 'customer writes a general message');
  expect(sAdmin.events['message:new'].some((m) => m.unit_id === null), 'admin receives it live');
  expect(sA.events['message:new'].length === 0 && sA.events['inbox:update'].length === 0, 'partner A (no General permission) receives nothing live');
  expect(sA.events['notification:new'].length === 0, '...and no notification');
  expect(sB.events['message:new'].length === 0, 'partner B receives nothing');

  const listA = (await call('GET', `/partner/orders/${A.order.id}/messages?limit=50`, ownerA.token)).body.data || [];
  expect(listA.length === 1 && listA[0].unit_id === A.unit.id, 'partner A\'s history has the article message only, not the general one');
  expect((await call('GET', `/partner/orders/${A.order.id}/messages?unit_id=general`, ownerA.token)).status === 403, 'asking for the general chat directly is refused (403)');
  const scopesA = (await call('GET', `/partner/orders/${A.order.id}/conversation`, ownerA.token)).body.data;
  expect(!scopesA.scopes.some((s) => s.unit_id === null) && scopesA.scopes.length === 1, 'General is not offered as a chat to partner A');
  expect((await call('POST', `/partner/orders/${A.order.id}/messages`, ownerA.token, { kind: 'text', body: 'general reply' })).status === 403, 'partner A cannot write a general message');
  expect((await call('POST', `/partner/orders/${A.order.id}/messages/read`, ownerA.token, { unit_id: 'general' })).status === 403, 'nor mark it read');
  const inboxA = (await call('GET', '/partner/conversations?limit=50', ownerA.token)).body;
  const rowA = (inboxA.data || []).find((r) => r.order_id === A.order.id);
  expect(rowA && rowA.chats.length === 1 && !JSON.stringify(rowA).includes('general question'), 'the inbox shows the article chat only and never the general text');
  expect(rowA && rowA.unread === 1, 'unread counts ignore the general message (1, not 2)');
  const adminScopes = (await call('GET', `/partner/orders/${A.order.id}/conversation`, admin.token)).body.data;
  expect(adminScopes.scopes.some((s) => s.unit_id === null), 'the admin sees the General chat');
  const adminList = (await call('GET', `/partner/orders/${A.order.id}/messages?limit=50`, admin.token)).body.data || [];
  expect(adminList.length === 2, 'the admin sees both messages');

  section('Another partner never sees it');
  expect((await call('GET', `/partner/orders/${A.order.id}/messages`, ownerB2.token)).status === 403, 'partner B reading A\'s order chat: refused');
  expect((await call('POST', `/partner/orders/${A.order.id}/messages`, ownerB2.token, { kind: 'text', body: 'x', unit_id: A.unit.id })).status === 403, 'partner B writing in A\'s order chat: refused');
  const inboxB = (await call('GET', '/partner/conversations?limit=50', ownerB2.token)).body.data || [];
  expect(!inboxB.some((r) => r.order_id === A.order.id), 'A\'s order is not in B\'s inbox');

  section('Admin enables General messages for partner A');
  const enable = await call('PATCH', `/admin/partners/${partnerA}`, admin.token, { permissions: [...withMessages, 'general_messages.view', 'general_messages.update'] });
  expect(enable.status === 200, 'admin turns the module on');
  await sleep(16_000); // partner / profile caches (15 s / 30 s TTL) are short-lived; the module list is re-read per request
  sCustomer.clear(); sAdmin.clear(); sA.clear(); sB.clear();
  const g2 = await send(A.order.id, null, `E2E second general ${STAMP}`);
  await sleep(900);
  expect(g2.status === 201, 'customer writes another general message');
  expect(sA.events['message:new'].some((m) => m.unit_id === null), 'partner A now receives general messages live');
  expect(sA.events['notification:new'].length >= 1, '...with a notification');
  expect(sB.events['message:new'].length === 0, 'partner B still receives nothing');
  const listA2 = (await call('GET', `/partner/orders/${A.order.id}/messages?limit=50`, ownerA.token)).body.data || [];
  expect(listA2.length === 3, 'partner A now sees the general messages in its history too');
  expect((await call('GET', `/partner/orders/${A.order.id}/conversation`, ownerA.token)).body.data.scopes.some((s) => s.unit_id === null), 'and General is offered as a chat');
  expect((await call('POST', `/partner/orders/${A.order.id}/messages`, ownerA.token, { kind: 'text', body: 'general reply' })).status === 201, 'partner A can answer in General');

  section('Permission taken away while connected');
  await call('PATCH', `/admin/partners/${partnerA}`, admin.token, { permissions: withMessages.filter((p) => !p.startsWith('messages.')) });
  await sleep(16_000);
  sCustomer.clear(); sA.clear();
  await send(A.order.id, A.unit.id, `E2E after revoke ${STAMP}`);
  await sleep(900);
  expect(sA.events['message:new'].length === 0 && sA.events['inbox:update'].length === 0, 'partner A, still connected, receives nothing once messages are switched off');
  expect((await call('GET', `/partner/orders/${A.order.id}/messages`, ownerA.token)).status === 403, 'and the API refuses it');
} catch (err) {
  bad(`unexpected error: ${err.stack || err.message}`);
} finally {
  section('Cleaning up');
  for (const s of cleanup.sockets) s.socket.disconnect();
  for (const id of cleanup.orders) {
    await db.from('notifications').delete().eq('order_id', id);
    await db.from('orders').delete().eq('id', id);
  }
  for (const id of cleanup.users.filter(Boolean)) await db.auth.admin.deleteUser(id).catch(() => {});
  for (const id of cleanup.partners) {
    const owners = (await db.from('profiles').select('id').eq('partner_id', id)).data || [];
    for (const o of owners) await db.auth.admin.deleteUser(o.id).catch(() => {});
    await db.from('partners').delete().eq('id', id);
  }
  if (restorePartner) await db.from('partners').update({ permissions: restorePartner.permissions }).eq('id', restorePartner.id);
  server.close();
  console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll checks passed');
  process.exit(failures ? 1 : 0);
}
