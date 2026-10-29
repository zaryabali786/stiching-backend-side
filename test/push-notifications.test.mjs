/**
 * Push notifications: who receives what. Runs the real notification / push / chat code against an in-memory database;
 * only the database, the socket and Firebase itself (the FCM send call, recorded here) are replaced.
 *   npm run test:unit
 */
import { test, mock, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeDb } from './fake-supabase.mjs';

process.env.FIREBASE_SERVICE_ACCOUNT_JSON = JSON.stringify({ project_id: 'test', client_email: 'x@test', private_key: 'x' });

// people
const ADMIN = 'admin-full';
const ADMIN_LIMITED = 'admin-customers-only';
const C1 = 'customer-1';
const C2 = 'customer-2';
const P1_OWNER = 'p1-owner';
const P1_MEMBER = 'p1-member-with-messages';
const P1_NO_MSG = 'p1-member-without-messages';
const P2_OWNER = 'p2-owner';
const P1 = 'partner-1';
const P2 = 'partner-2';
const ORDER = 'order-1'; // C1's order, assigned to partner 1

let db;
let sent; // every FCM multicast: { tokens, message }
let failTokens; // tokens FCM reports as dead

const tok = (user, n = 1) => `tok-${user}-${n}-${'x'.repeat(24)}`;
const dev = (user, app, n = 1) => ({ user_id: user, token: tok(user, n), platform: 'android', app });

const freshDb = () =>
  createFakeDb({
    profiles: [
      { id: ADMIN, role: 'admin', is_active: true, permissions: [] },
      { id: ADMIN_LIMITED, role: 'admin', is_active: true, permissions: ['admin.limited', 'admin.customers'] },
      { id: C1, role: 'customer', is_active: true, full_name: 'One' },
      { id: C2, role: 'customer', is_active: true, full_name: 'Two' },
      { id: P1_OWNER, role: 'partner_staff', partner_id: P1, partner_role: 'owner', is_active: true, permissions: [] },
      { id: P1_MEMBER, role: 'partner_staff', partner_id: P1, partner_role: 'member', is_active: true, permissions: ['messages.view'] },
      { id: P1_NO_MSG, role: 'partner_staff', partner_id: P1, partner_role: 'member', is_active: true, permissions: ['receiving.view'] },
      { id: P2_OWNER, role: 'partner_staff', partner_id: P2, partner_role: 'owner', is_active: true, permissions: [] },
    ],
    partners: [
      { id: P1, name: 'Partner One', status: 'active', permissions: ['messages.view', 'general_messages.view', 'receiving.view'] },
      { id: P2, name: 'Partner Two', status: 'active', permissions: ['messages.view', 'general_messages.view', 'receiving.view'] },
    ],
    orders: [{ id: ORDER, reference: 'STX-1', customer_id: C1, customer_name: 'One', partner_id: P1 }],
    push_devices: [
      dev(ADMIN, 'admin'),
      dev(ADMIN_LIMITED, 'admin'),
      dev(C1, 'client', 1),
      dev(C1, 'client', 2), // a second phone of the same customer
      dev(C2, 'client'),
      dev(P1_OWNER, 'admin'),
      dev(P1_MEMBER, 'admin'),
      dev(P1_NO_MSG, 'admin'),
      dev(P2_OWNER, 'admin'),
    ],
  });

const dbProxy = new Proxy({}, { get: (_, key) => db[key] });
const settle = () => new Promise((r) => setTimeout(r, 30)); // pushToUser is fire-and-forget

/** Who got a push (user ids, from the `userId` carried in the payload). */
const recipients = () => [...new Set(sent.map((s) => s.message.data.userId))].sort();

let notifications;
let push;

before(async () => {
  mock.module('../src/config/supabase.js', { namedExports: { supabaseAdmin: dbProxy, supabase: dbProxy } });
  mock.module('../src/realtime/io.js', { namedExports: { emitTo: () => {}, rooms: { user: (id) => `user:${id}`, admins: 'admins' } } });
  mock.module('firebase-admin/app', { namedExports: { initializeApp: () => ({}), cert: (c) => c, getApps: () => [] } });
  mock.module('firebase-admin/messaging', {
    namedExports: {
      getMessaging: () => ({
        sendEachForMulticast: async (message) => {
          sent.push(...message.tokens.map((t) => ({ token: t, message })));
          const responses = message.tokens.map((t) => (failTokens.has(t) ? { success: false, error: { code: 'messaging/registration-token-not-registered' } } : { success: true, messageId: `projects/test/messages/${t.slice(0, 12)}` }));
          return { responses, successCount: responses.filter((r) => r.success).length };
        },
      }),
    },
  });
  notifications = await import('../src/services/notification.service.js');
  push = await import('../src/services/push.service.js');
});

beforeEach(() => {
  db = freshDb();
  sent = [];
  failTokens = new Set();
});

const tokensOf = (...users) => users.flatMap((u) => db.table('push_devices').filter((d) => d.user_id === u).map((d) => d.token)).sort();

test('an order notification for a customer reaches only that customer, on all of their phones', async () => {
  await notifications.notifyUser(C1, { type: 'order', title: 'Shipped: STX-1', orderId: ORDER, link: `/app/orders/${ORDER}` });
  await settle();
  assert.deepEqual(recipients(), [C1]);
  assert.deepEqual(sent.map((s) => s.token).sort(), tokensOf(C1));
});

test('the payload names its recipient, order and link; every data value is a string', async () => {
  await notifications.notifyUser(C1, { type: 'order', title: 'Shipped: STX-1', body: 'On its way', orderId: ORDER, link: `/app/orders/${ORDER}` });
  await settle();
  const m = sent[0].message;
  assert.equal(m.notification.title, 'Shipped: STX-1');
  assert.equal(m.data.userId, C1);
  assert.equal(m.data.orderId, ORDER);
  assert.equal(m.data.link, `/app/orders/${ORDER}`);
  for (const v of Object.values(m.data)) assert.equal(typeof v, 'string');
  assert.equal(m.android.priority, 'high');
  assert.equal(m.android.notification.tag, m.data.notificationId, 'a retried send replaces the tray entry instead of stacking');
  assert.equal(m.apns.headers['apns-push-type'], 'alert');
  assert.equal(m.apns.payload.aps.sound, 'default');
});

test('the notification carries the Stitch&Ship mark: the small icon and colour on Android, the icon and badge in a browser', async () => {
  await notifications.notifyUser(C1, { type: 'order', title: 'Packed: STX-1', body: 'Soon on its way', orderId: ORDER });
  await settle();
  const m = sent[0].message;
  assert.equal(m.android.notification.icon, 'ic_stat_logo');
  assert.equal(m.android.notification.color, '#62003E');
  assert.match(m.webpush.notification.icon, /\/assets\/icon\/notification-192\.png$/);
  assert.match(m.webpush.notification.badge, /\/assets\/icon\/badge-96\.png$/);
});

test('a new order for admins reaches admins only: never customers or partners', async () => {
  await notifications.notifyAdmins({ type: 'alert', title: 'New order STX-1', orderId: ORDER, link: { admin: '/admin/orders?ref=STX-1' } });
  await settle();
  assert.deepEqual(recipients(), [ADMIN]); // the restricted admin has no Orders module
});

test('a restricted admin still gets what belongs to a module they can open', async () => {
  await notifications.notifyAdmins({ type: 'update', title: 'Customer changed', link: { admin: '/admin/customers' } });
  await settle();
  assert.deepEqual(recipients(), [ADMIN, ADMIN_LIMITED].sort());
});

test("an order's partner notification reaches only that partner's people who may see the module", async () => {
  await notifications.notifyPartner({ type: 'update', title: 'New message on STX-1', orderId: ORDER, link: { partner_staff: `/partner/messages/${ORDER}` } }, null, { module: 'messages' });
  await settle();
  assert.deepEqual(recipients(), [P1_MEMBER, P1_OWNER]); // not the member without Messages, not partner 2, not admins/customers
});

test('a notification without an order and partner reaches no partner at all', async () => {
  await notifications.notifyPartner({ type: 'update', title: 'No order given' });
  await settle();
  assert.deepEqual(recipients(), []);
});

test('customer message -> admins + that order\'s partner; admin reply -> only that customer', async () => {
  // what chat.service does on a customer message
  const note = { type: 'update', title: 'New message on STX-1', orderId: ORDER, partnerId: P1, link: { admin: `/admin/messages/${ORDER}`, partner_staff: `/partner/messages/${ORDER}` }, dedupe: true };
  await Promise.all([notifications.notifyAdmins(note), notifications.notifyPartner(note, null, { module: ['messages', 'general_messages'] })]);
  await settle();
  // the partner's member holds Messages but not General messages, so only the owner is told about a general chat
  assert.deepEqual(recipients(), [ADMIN, P1_OWNER].sort());
  sent = [];
  // the admin's reply
  await notifications.notifyUser(C1, { type: 'update', title: 'New message on STX-1', orderId: ORDER, link: `/app/orders/${ORDER}?chat=1` });
  await settle();
  assert.deepEqual(recipients(), [C1]);
});

test('a repeated chat event does not push the same unread notification twice', async () => {
  const note = { type: 'update', title: 'New message on STX-1', orderId: ORDER, link: { admin: `/admin/messages/${ORDER}` }, dedupe: true };
  await notifications.notifyAdmins(note);
  await settle();
  const first = sent.length;
  assert.ok(first > 0);
  await notifications.notifyAdmins(note); // same title, same order, still unread
  await settle();
  assert.equal(sent.length, first);
});

test('a device that switched accounts belongs to the new user only', async () => {
  const token = tok(C1, 1);
  await push.registerDevice(C2, { token, platform: 'android', app: 'client' }); // signs in on the same phone
  assert.equal(db.table('push_devices').filter((d) => d.token === token).length, 1);
  await notifications.notifyUser(C1, { type: 'update', title: 'For customer 1' });
  await settle();
  assert.ok(!sent.some((s) => s.token === token), 'the first customer\'s notification must not reach the phone that now belongs to customer 2');
  sent = [];
  await notifications.notifyUser(C2, { type: 'update', title: 'For customer 2' });
  await settle();
  assert.ok(sent.some((s) => s.token === token));
});

test('logging out removes only that user\'s own row for the token', async () => {
  const token = tok(C1, 1);
  await push.unregisterDevice(C2, token); // somebody else cannot remove it
  assert.equal(db.table('push_devices').filter((d) => d.token === token).length, 1);
  await push.unregisterDevice(C1, token);
  assert.equal(db.table('push_devices').filter((d) => d.token === token).length, 0);
});

test('a token Firebase reports as dead is deleted; the others keep working', async () => {
  const dead = tok(C1, 1);
  failTokens.add(dead);
  await notifications.notifyUser(C1, { type: 'update', title: 'Hello' });
  await settle();
  assert.deepEqual(tokensOf(C1), [tok(C1, 2)]);
});

test('a user without devices, or an unknown user, is skipped quietly', async () => {
  await notifications.notifyUser('nobody', { type: 'update', title: 'Hello' });
  await settle();
  assert.deepEqual(sent, []);
});

// ───────────── the Notification Center's "Mobile application" ─────────────

const MOBILE = { platforms: ['android', 'ios'] };

test('mobile push goes to Android and iPhone devices only: never to a browser, never to anybody else', async () => {
  const webToken = `web-${'w'.repeat(30)}`;
  const iosToken = `ios-${'i'.repeat(30)}`;
  db.table('push_devices').push({ user_id: C2, token: webToken, platform: 'web', app: 'client' }, { user_id: C2, token: iosToken, platform: 'ios', app: 'client' });
  const res = await push.pushToUserDetailed(C2, { id: 'n1', title: 'Hello', body: 'Body', type: 'broadcast' }, MOBILE);
  assert.deepEqual(sent.map((s) => s.token).sort(), [iosToken, tok(C2, 1)].sort());
  assert.ok(!sent.some((s) => s.token === webToken), 'the browser token is left alone');
  assert.equal(res.status, 'sent');
  assert.deepEqual(res.byPlatform, { android: 1, ios: 1 });
  assert.equal(res.messageIds.length, 2, 'Firebase receipts are returned');
  assert.deepEqual([...new Set(sent.map((s) => s.message.data.userId))], [C2]);
});

test('a person with only a browser registered has no mobile device: nothing is sent', async () => {
  db.table('push_devices').splice(0, db.table('push_devices').length, { user_id: C1, token: `web-${'w'.repeat(30)}`, platform: 'web', app: 'client' });
  const res = await push.pushToUserDetailed(C1, { id: 'n2', title: 'Hello' }, MOBILE);
  assert.equal(res.status, 'no_device');
  assert.deepEqual(sent, []);
});

test('without a platform limit every device is used, as before (order and chat pushes)', async () => {
  db.table('push_devices').push({ user_id: C2, token: `web-${'w'.repeat(30)}`, platform: 'web', app: 'client' });
  const res = await push.pushToUserDetailed(C2, { id: 'n3', title: 'Hello' });
  assert.equal(res.devices, 2);
});

test('a picture is sent only as a safe https address; anything else goes out as a plain notification', async () => {
  for (const bad of ['http://cdn.example.com/a.png', 'javascript:alert(1)', 'not a url', 'https://user:pw@cdn.example.com/a.png']) {
    sent = [];
    await push.pushToUserDetailed(C2, { id: 'n4', title: 'Hello', imageUrl: bad }, MOBILE);
    const m = sent[0].message;
    assert.equal(m.notification.imageUrl, undefined, bad);
    assert.equal(m.android.notification.imageUrl, undefined);
    assert.equal(m.apns.payload.aps['mutable-content'], undefined);
  }
  sent = [];
  await push.pushToUserDetailed(C2, { id: 'n5', title: 'Hello', imageUrl: 'https://cdn.example.com/a.png' }, MOBILE);
  const m = sent[0].message;
  assert.equal(m.notification.imageUrl, 'https://cdn.example.com/a.png');
  assert.equal(m.android.notification.imageUrl, 'https://cdn.example.com/a.png');
  assert.equal(m.apns.payload.aps['mutable-content'], 1, 'iOS runs the notification service extension');
  assert.equal(m.apns.fcmOptions.imageUrl, 'https://cdn.example.com/a.png');
});

test('the destination travels with the push: the notification id and the flag the app uses to ask the server where to go', async () => {
  await push.pushToUserDetailed(C2, { id: 'n6', title: 'Hello', type: 'broadcast', link: '/app/orders', hasDestination: true }, MOBILE);
  const m = sent[0].message;
  assert.equal(m.data.notificationId, 'n6');
  assert.equal(m.data.dest, '1');
  assert.equal(m.data.link, '/app/orders');
  await push.pushToUserDetailed(C2, { id: 'n7', title: 'Plain', type: 'broadcast' }, MOBILE);
  assert.equal(sent.at(-1).message.data.dest, '');
});
