/**
 * Notification Center (broadcast.service) with an in-memory database: the three admin audiences, a partner reaching only its own
 * staff, the permission checks, scheduling that never delivers twice, and web / push failing independently.
 *   npm run test:unit
 */
import { test, mock, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeDb } from './fake-supabase.mjs';

let db;
let svc;
let pushLog;
let pushImpl;
let emitted;
const dbProxy = new Proxy({}, { get: (_, key) => db[key] });

before(async () => {
  mock.module('../src/config/supabase.js', { namedExports: { supabaseAdmin: dbProxy, supabase: dbProxy } });
  mock.module('../src/realtime/io.js', {
    namedExports: {
      emitTo: (room, event, payload) => emitted.push({ room, event, payload }),
      getIO: () => null,
      setIO: () => {},
      rooms: { user: (id) => `user:${id}`, order: (id) => `order:${id}`, admins: 'admins', partner: (id) => `partner:${id}`, production: (id) => `production:${id}` },
    },
  });
  mock.module('../src/services/push.service.js', {
    namedExports: {
      pushToUserDetailed: async (userId, n, options) => {
        pushLog.push({ userId, n, options });
        return pushImpl(userId, n);
      },
      pushToUser: async () => {},
      pushEnabled: () => true,
      registerDevice: async () => {},
      unregisterDevice: async () => {},
    },
  });
  mock.module('../src/services/storage.service.js', {
    namedExports: { uploadDataUrls: async (folder) => [{ url: `https://files.test/${folder}/pic.png`, path: `${folder}/pic.png`, type: 'image', name: 'pic.png' }] },
  });
  svc = await import('../src/services/broadcast.service.js');
});

const P1 = '11111111-1111-4111-8111-111111111111';
const P2 = '22222222-2222-4222-8222-222222222222';
const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const ADMIN = id(900);
const C1 = id(1), C2 = id(2), C3 = id(3), C4 = id(4);
const O1 = id(11), O2 = id(12);
const S1M = id(21), S1T = id(22), S1G = id(23), S2M = id(24);
const RA = id(31); // a restricted admin (staff on the admin side)

beforeEach(() => {
  emitted = [];
  pushLog = [];
  pushImpl = async () => ({ status: 'sent', devices: 1, delivered: 1, error: null });
  db = createFakeDb({
    partners: [{ id: P1, name: 'Partner One', status: 'active' }, { id: P2, name: 'Partner Two', status: 'active' }],
    profiles: [
      { id: ADMIN, role: 'admin', is_active: true, full_name: 'Admin', email: 'a@t.dev' },
      { id: RA, role: 'admin', is_active: true, full_name: 'Office', email: 'ra@t.dev', permissions: ['admin.limited', 'admin.notification_center.view'] },
      ...[C1, C2, C3].map((x, i) => ({ id: x, role: 'customer', is_active: true, full_name: `Client ${i + 1}`, email: `c${i + 1}@t.dev` })),
      { id: C4, role: 'customer', is_active: false, full_name: 'Gone', email: 'c4@t.dev' },
      { id: O1, role: 'partner_staff', partner_id: P1, partner_role: 'owner', is_active: true, full_name: 'Owner One', email: 'o1@t.dev' },
      { id: O2, role: 'partner_staff', partner_id: P2, partner_role: 'owner', is_active: true, full_name: 'Owner Two', email: 'o2@t.dev' },
      { id: S1M, role: 'partner_staff', partner_id: P1, partner_role: 'member', staff_type: 'master', is_active: true, full_name: 'Master P1', email: 's1m@t.dev' },
      { id: S1T, role: 'partner_staff', partner_id: P1, partner_role: 'member', staff_type: 'tailor', is_active: true, full_name: 'Tailor P1', email: 's1t@t.dev' },
      { id: S1G, role: 'partner_staff', partner_id: P1, partner_role: 'member', staff_type: 'staff', is_active: true, full_name: 'Office P1', email: 's1g@t.dev' },
      { id: S2M, role: 'partner_staff', partner_id: P2, partner_role: 'member', staff_type: 'master', is_active: true, full_name: 'Master P2', email: 's2m@t.dev' },
    ],
    broadcasts: [],
    broadcast_deliveries: [],
    notifications: [],
    push_devices: [],
  });
});

const everything = () => true;
const admin = { kind: 'admin', userId: ADMIN, partnerId: null, can: everything };
const partnerOne = (denied = []) => ({ kind: 'partner', userId: O1, partnerId: P1, can: (a) => !denied.includes(a) });
const form = (over = {}) => ({ title: 'Hello', body: 'A message', channels: ['web'], audience: { category: 'clients', mode: 'all' }, ...over });
const received = (userId) => db.table('notifications').filter((n) => n.user_id === userId);
const everyone = () => [...new Set(db.table('notifications').map((n) => n.user_id))].sort();

/** Create and deliver at once, the way the controller does. */
const send = async (actor, input) => {
  const { broadcast, dispatchNow } = await svc.createBroadcast(actor, input);
  assert.equal(dispatchNow, true);
  return svc.sendNow(broadcast);
};

test('admin → all clients: every active client gets it, nobody else', async () => {
  const done = await send(admin, form());
  assert.equal(done.status, 'sent');
  assert.deepEqual(everyone(), [C1, C2, C3].sort());
  assert.equal(received(C4).length, 0, 'an inactive client is not eligible');
  assert.equal(received(O1).length + received(S1M).length, 0, 'staff and partners are not reached');
  assert.equal(done.recipient_count, 3);
  assert.equal(received(C1)[0].type, 'broadcast');
  assert.equal(emitted.filter((e) => e.event === 'notification:new').length, 3, 'live event for each');
});

test('admin → selected clients with a picture: only those, and the picture comes with the notification', async () => {
  const done = await send(admin, form({ audience: { category: 'clients', mode: 'selected', ids: [C1, C3] }, image: { name: 'a.png', dataUrl: 'data:image/png;base64,AAAA' } }));
  assert.equal(done.status, 'sent');
  assert.deepEqual(everyone(), [C1, C3].sort());
  assert.match(received(C1)[0].image_url, /pic\.png$/);
});

test('admin cannot select an account that is not a client for the clients audience', async () => {
  await assert.rejects(() => svc.createBroadcast(admin, form({ audience: { category: 'clients', mode: 'selected', ids: [C1, O1] } })), /not available/i);
});

test('admin → staff of one partner by department, with and without subordinates', async () => {
  const masters = await send(admin, form({ audience: { category: 'staff', mode: 'filter', partner_ids: [P1], staff_types: ['master'] } }));
  assert.equal(masters.status, 'sent');
  assert.deepEqual(everyone(), [S1M]);

  db.table('notifications').length = 0;
  db.table('broadcast_deliveries').length = 0;
  const withBelow = await send(admin, form({ audience: { category: 'staff', mode: 'filter', partner_ids: [P1], staff_types: ['master'], include_subordinates: true } }));
  assert.equal(withBelow.status, 'sent');
  assert.deepEqual(everyone(), [S1M, S1T].sort(), 'a master with subordinates also reaches the tailors');

  db.table('notifications').length = 0;
  db.table('broadcast_deliveries').length = 0;
  await send(admin, form({ audience: { category: 'staff', mode: 'filter', partner_ids: [P1], staff_types: ['staff'], include_subordinates: true } }));
  assert.deepEqual(everyone(), [S1M, S1T, S1G].sort(), 'office staff with subordinates reaches the whole floor of that partner');
  assert.ok(!everyone().includes(S2M), 'never another partner');
  assert.ok(!everyone().includes(O1), 'a partner owner is the partner account, not staff');
});

test('admin → individual staff members', async () => {
  await send(admin, form({ audience: { category: 'staff', mode: 'selected', ids: [S1T, S2M] } }));
  assert.deepEqual(everyone(), [S1T, S2M].sort());
});

test('admin → selected partners reaches only those partner accounts, not their staff', async () => {
  const done = await send(admin, form({ audience: { category: 'partners', mode: 'selected', ids: [P1, P2] } }));
  assert.equal(done.status, 'sent');
  assert.deepEqual(everyone(), [O1, O2].sort());
  const one = await send(admin, form({ title: 'Only P2', audience: { category: 'partners', mode: 'selected', ids: [P2] } }));
  assert.equal(one.recipient_count, 1);
  assert.equal(received(O2).filter((n) => n.title === 'Only P2').length, 1);
  assert.equal(received(O1).filter((n) => n.title === 'Only P2').length, 0);
  await assert.rejects(() => svc.createBroadcast(admin, form({ audience: { category: 'partners', mode: 'selected', ids: [id(777)] } })), /not available/i);
});

test('partner → only its own staff; every other target is refused by the server', async () => {
  const mine = await send(partnerOne(), form({ audience: { category: 'staff', mode: 'all' } }));
  assert.equal(mine.status, 'sent');
  assert.deepEqual(everyone(), [S1M, S1T, S1G].sort(), 'its own members only (not the owner, not partner two)');
  assert.equal(mine.partner_id, P1);

  // another partner's staff id, sent by hand
  await assert.rejects(() => svc.createBroadcast(partnerOne(), form({ audience: { category: 'staff', mode: 'selected', ids: [S1M, S2M] } })), /not available/i);
  // clients and partners, and a body that names another partner
  await assert.rejects(() => svc.createBroadcast(partnerOne(), form({ audience: { category: 'clients', mode: 'all' } })), /your own staff/i);
  await assert.rejects(() => svc.createBroadcast(partnerOne(), form({ audience: { category: 'partners', mode: 'all' } })), /your own staff/i);
  const forged = await send(partnerOne(), form({ title: 'Forged', audience: { category: 'staff', mode: 'all', partner_ids: [P2] } }));
  assert.equal(received(S2M).filter((n) => n.title === 'Forged').length, 0, 'a partner_ids field in the body is ignored for a partner');
  assert.equal(forged.partner_id, P1);
  // the owner and an admin account are not selectable either
  await assert.rejects(() => svc.createBroadcast(partnerOne(), form({ audience: { category: 'staff', mode: 'selected', ids: [O1] } })), /not available/i);
  await assert.rejects(() => svc.createBroadcast(partnerOne(), form({ audience: { category: 'staff', mode: 'selected', ids: [ADMIN] } })), /not available/i);
});

test('partner picker lists only its own staff', async () => {
  const { items } = await svc.searchRecipients(partnerOne(), { category: 'clients' });
  assert.deepEqual(items.map((i) => i.id).sort(), [S1M, S1T, S1G].sort(), 'asking for clients still returns own staff only');
});

test('partner permissions: create, send, schedule, urgent and image are each checked on the server', async () => {
  const base = form({ audience: { category: 'staff', mode: 'all' } });
  await assert.rejects(() => svc.createBroadcast(partnerOne(['create']), base), /not allowed to create/i);
  await assert.rejects(() => svc.createBroadcast(partnerOne(['send']), base), /not allowed to send/i);
  const at = new Date(Date.now() + 3600_000).toISOString();
  await assert.rejects(() => svc.createBroadcast(partnerOne(['schedule']), { ...base, schedule: { at } }), /not allowed to schedule/i);
  await assert.rejects(() => svc.createBroadcast(partnerOne(['urgent']), { ...base, priority: 'urgent' }), /urgent/i);
  await assert.rejects(() => svc.createBroadcast(partnerOne(['image']), { ...base, image: { dataUrl: 'data:image/png;base64,AAAA' } }), /attach images/i);
  await assert.rejects(() => svc.listBroadcasts(partnerOne(['history']), {}), /history/i);
  assert.equal(db.table('broadcasts').length, 0, 'nothing was saved by the refused requests');
});

test('a partner sees only its own history, and cannot read or change another sender’s notification', async () => {
  const adminOne = await send(admin, form());
  const mine = await send(partnerOne(), form({ title: 'Mine', audience: { category: 'staff', mode: 'all' } }));
  const list = await svc.listBroadcasts(partnerOne(), {});
  assert.deepEqual(list.items.map((i) => i.id), [mine.id]);
  await assert.rejects(() => svc.getBroadcast(partnerOne(), adminOne.id), /not found/i);
  await assert.rejects(() => svc.cancelBroadcast(partnerOne(), adminOne.id), /not found/i);
  const all = await svc.listBroadcasts(admin, {});
  assert.equal(all.items.length, 2, 'the admin sees both');
});

test('urgent is stored, shown on the notification and sent with the push', async () => {
  const done = await send(admin, form({ title: 'Stop', priority: 'urgent', channels: ['web', 'push'] }));
  assert.equal(done.status, 'sent');
  assert.equal(done.priority, 'urgent');
  assert.equal(received(C1)[0].priority, 'urgent');
  assert.ok(pushLog.every((p) => p.n.priority === 'urgent'));
});

test('"Mobile application" (the push channel) asks for Android and iPhone devices only; web-only sends no push at all', async () => {
  await send(admin, form({ title: 'Mobile', channels: ['push'] }));
  assert.ok(pushLog.length > 0);
  assert.ok(pushLog.every((p) => JSON.stringify(p.options?.platforms) === JSON.stringify(['android', 'ios'])));
  pushLog.length = 0;
  await send(admin, form({ title: 'Web only', channels: ['web'] }));
  assert.equal(pushLog.length, 0);
});

test('scheduled: stays pending, is not sent early, goes out once when due, and cannot be sent twice', async () => {
  const at = new Date(Date.now() + 3600_000).toISOString();
  const { broadcast, dispatchNow } = await svc.createBroadcast(admin, form({ schedule: { at, timezone: 'Asia/Karachi' }, priority: 'urgent' }));
  assert.equal(dispatchNow, false);
  assert.equal(broadcast.status, 'scheduled');
  assert.equal(broadcast.timezone, 'Asia/Karachi');
  assert.equal(await svc.processDueBroadcasts(), 0, 'not due yet: nothing is sent');
  assert.equal(db.table('notifications').length, 0);

  db.table('broadcasts')[0].send_at = new Date(Date.now() - 1000).toISOString(); // time passes
  assert.equal(await svc.processDueBroadcasts(), 1);
  assert.equal(db.table('broadcasts')[0].status, 'sent');
  assert.equal(db.table('notifications').length, 3);

  // a second tick, a second worker, a restart: still three
  assert.equal(await svc.processDueBroadcasts(), 0);
  assert.equal(await svc.claimBroadcast(broadcast.id), null, 'it can no longer be claimed');
  const both = await Promise.all([svc.processDueBroadcasts(), svc.processDueBroadcasts()]);
  assert.equal(both[0] + both[1], 0);
  assert.equal(db.table('notifications').length, 3);
});

test('two workers racing for one due notification: only one delivers it', async () => {
  const { broadcast } = await svc.createBroadcast(admin, form({ schedule: { at: new Date(Date.now() + 3600_000).toISOString() } }));
  db.table('broadcasts')[0].send_at = new Date(Date.now() - 1000).toISOString();
  const [a, b] = await Promise.all([svc.claimBroadcast(broadcast.id), svc.claimBroadcast(broadcast.id)]);
  assert.equal([a, b].filter(Boolean).length, 1);
});

test('a restart that left it half-way: it is handed back and the people who already got it are not sent a copy', async () => {
  const { broadcast } = await svc.createBroadcast(admin, form({ schedule: { at: new Date(Date.now() + 3600_000).toISOString() } }));
  db.table('broadcasts')[0].send_at = new Date(Date.now() - 1000).toISOString();
  const claimed = await svc.claimBroadcast(broadcast.id);
  // the worker saved C1's notification and its delivery, then died
  const n = db.table('notifications');
  n.push({ id: id(5001), user_id: C1, type: 'broadcast', broadcast_id: broadcast.id, title: 'Hello' });
  db.table('broadcast_deliveries').push({ id: id(6001), broadcast_id: broadcast.id, user_id: C1, web_status: 'sent', notification_id: id(5001) });
  assert.ok(claimed);
  db.table('broadcasts')[0].claimed_at = new Date(Date.now() - 20 * 60_000).toISOString(); // stuck for 20 minutes
  assert.equal(await svc.processDueBroadcasts(), 1);
  assert.equal(db.table('broadcasts')[0].status, 'sent');
  assert.equal(db.table('notifications').filter((x) => x.user_id === C1).length, 1, 'C1 got exactly one');
  assert.equal(db.table('notifications').length, 3);
});

test('scheduling rules: the time must be in the future, and a cancelled notification is never sent', async () => {
  await assert.rejects(() => svc.createBroadcast(admin, form({ schedule: { at: new Date(Date.now() - 60_000).toISOString() } })), /future/i);
  await assert.rejects(() => svc.createBroadcast(admin, form({ schedule: { at: 'not a date' } })), /valid date/i);
  await assert.rejects(() => svc.createBroadcast(admin, form({ schedule: { at: new Date(Date.now() + 3600_000).toISOString(), timezone: 'Mars/Base' } })), /time zone/i);

  const { broadcast } = await svc.createBroadcast(admin, form({ schedule: { at: new Date(Date.now() + 3600_000).toISOString() } }));
  const edited = await svc.updateBroadcast(admin, broadcast.id, { title: 'New title', priority: 'urgent' });
  assert.equal(edited.title, 'New title');
  const cancelled = await svc.cancelBroadcast(admin, broadcast.id);
  assert.equal(cancelled.status, 'cancelled');
  db.table('broadcasts')[0].send_at = new Date(Date.now() - 1000).toISOString();
  assert.equal(await svc.processDueBroadcasts(), 0);
  assert.equal(db.table('notifications').length, 0);
  await assert.rejects(() => svc.updateBroadcast(admin, broadcast.id, { title: 'x' }), /still waiting/i);
  await assert.rejects(() => svc.cancelBroadcast(admin, broadcast.id), /still waiting/i);
});

test('an immediate notification cannot be edited or cancelled afterwards', async () => {
  const done = await send(admin, form());
  await assert.rejects(() => svc.updateBroadcast(admin, done.id, { title: 'x' }), /still waiting/i);
  await assert.rejects(() => svc.cancelBroadcast(admin, done.id), /still waiting/i);
});

test('web and push are independent: a push failure leaves the web notification, and a retry only repeats what failed', async () => {
  pushImpl = async (userId) => (userId === C2 ? { status: 'failed', devices: 1, delivered: 0, error: 'messaging/third-party-auth-error' } : userId === C3 ? { status: 'no_device', devices: 0, delivered: 0, error: null } : { status: 'sent', devices: 2, delivered: 2, error: null });
  const done = await send(admin, form({ channels: ['web', 'push'] }));
  assert.equal(done.status, 'partial');
  assert.equal(done.web_sent, 3, 'web reached everybody even though one push failed');
  assert.equal(done.push_sent, 1);
  assert.equal(done.push_failed, 1);
  assert.equal(done.push_no_device, 1, 'a person without a device is not an error');
  const failed = db.table('broadcast_deliveries').find((d) => d.user_id === C2);
  assert.match(failed.error, /Push: messaging/);
  assert.equal(received(C2).length, 1);

  pushLog.length = 0;
  pushImpl = async () => ({ status: 'sent', devices: 1, delivered: 1, error: null });
  const { broadcast, resolve } = await svc.retryBroadcast(admin, done.id);
  assert.equal(resolve, false);
  const again = await svc.dispatchBroadcast(broadcast, { resolve });
  assert.equal(again.status, 'sent');
  assert.deepEqual(pushLog.map((p) => p.userId), [C2], 'only the failed push is repeated');
  assert.equal(db.table('notifications').length, 3, 'no second web notification for anybody');
});

test('the other way round: web fails, push still goes out', async () => {
  const realInsert = db.from;
  db = { ...db, from: (name) => (name === 'notifications' ? { insert: () => ({ select: async () => ({ data: null, error: { message: 'db down' } }) }), select: () => ({ eq: () => ({ in: async () => ({ data: [] }) }) }) } : realInsert(name)) };
  const done = await send(admin, form({ channels: ['web', 'push'] }));
  assert.equal(done.status, 'partial');
  assert.equal(done.web_failed, 3);
  assert.equal(done.push_sent, 3, 'push does not wait for the web notification');
});

test('permissions of a restricted admin follow the role they hold', async () => {
  const roleActor = (...actions) => ({ kind: 'admin', userId: RA, partnerId: null, can: (a) => actions.includes(a) });
  await assert.rejects(() => svc.createBroadcast(roleActor('view'), form()), /not allowed to create/i);
  await assert.rejects(() => svc.createBroadcast(roleActor('create'), form()), /not allowed to send/i);
  const ok = await svc.createBroadcast(roleActor('create', 'send'), form());
  assert.equal(ok.dispatchNow, true);
  await assert.rejects(() => svc.createBroadcast(roleActor('create', 'send'), form({ priority: 'urgent' })), /urgent/i);
  await assert.rejects(() => svc.listBroadcasts(roleActor('create', 'send'), {}), /history/i);
  const seen = await svc.getBroadcast(roleActor('history'), ok.broadcast.id);
  assert.equal(seen.deliveries, undefined, 'without the delivery status permission the per-person results are not shown');
});

test('validation: title, message, channels, picture type', async () => {
  await assert.rejects(() => svc.createBroadcast(admin, form({ title: '  ' })), /title is required/i);
  await assert.rejects(() => svc.createBroadcast(admin, form({ body: 'x'.repeat(1001) })), /too long/i);
  await assert.rejects(() => svc.createBroadcast(admin, form({ channels: [] })), /web, push or both/i);
  await assert.rejects(() => svc.createBroadcast(admin, form({ channels: ['sms'] })), /web, push or both/i);
  await assert.rejects(() => svc.createBroadcast(admin, form({ image: { dataUrl: 'data:application/pdf;base64,AAAA' } })), /PNG, JPG or WebP/i);
  await assert.rejects(() => svc.createBroadcast(admin, form({ audience: { category: 'everyone', mode: 'all' } })), /who to notify/i);
  assert.equal(db.table('broadcasts').length, 0);
});

test('history is paged and can be filtered', async () => {
  for (let i = 0; i < 3; i += 1) await send(admin, form({ title: `N${i}`, priority: i === 0 ? 'urgent' : 'normal' }));
  const urgent = await svc.listBroadcasts(admin, { priority: 'urgent' });
  assert.equal(urgent.items.length, 1);
  const first = await svc.listBroadcasts(admin, { limit: '2' });
  assert.equal(first.meta.limit, 2);
});
