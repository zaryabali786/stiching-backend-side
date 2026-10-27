/**
 * Voice messages in the customer <-> team chat: a recording can only be attached by the person who uploaded it to this chat, it must be long
 * enough and really stored, and the message goes out with a link to play it (never the storage path). The database, the file store, the
 * notifications and the live socket are all faked.
 */
import { test, mock, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeDb } from './fake-supabase.mjs';

let db;
let svc;
let stored;
let sent;
const dbProxy = new Proxy({}, { get: (_, key) => db[key] });
const CUSTOMER = '11111111-1111-4111-8111-111111111111';
const ADMIN = '22222222-2222-4222-8222-222222222222';
const customer = { id: CUSTOMER, role: 'customer', full_name: 'Ali' };
const admin = { id: ADMIN, role: 'admin', full_name: 'Team' };
const goodPath = (who) => `voice/support/${CUSTOMER}/${who}/abc.m4a`;

before(async () => {
  mock.module('../src/config/supabase.js', { namedExports: { supabaseAdmin: dbProxy, supabase: dbProxy } });
  mock.module('../src/services/notification.service.js', { namedExports: { notifyAdmins: async () => {}, notifyUser: async () => {} } });
  mock.module('../src/realtime/io.js', { namedExports: { emitTo: (room, event, payload) => sent.push({ room, event, payload }), rooms: { user: (id) => `user:${id}`, admins: 'admins' } } });
  mock.module('../src/services/storage.service.js', {
    namedExports: {
      documentExists: async (p) => stored.has(p),
      signedDocumentUrl: async (p) => `https://files.test/${p}?sig=1`,
      uploadAudio: async (folder) => ({ path: `${folder}/new.m4a`, mime: 'audio/mp4', size: 4000 }),
    },
  });
  svc = await import('../src/services/support-chat.service.js');
});

beforeEach(() => {
  db = createFakeDb({ support_messages: [] });
  stored = new Set([goodPath(CUSTOMER)]);
  sent = [];
});

test('a text message still works and has no audio', async () => {
  const { message } = await svc.sendSupportMessage({ customerId: CUSTOMER, profile: customer, body: ' hello ' });
  assert.equal(message.kind, 'text');
  assert.equal(message.body, 'hello');
  assert.equal(message.audio, null);
});

test('a voice message is saved with a link to play it, and the stored path is not shown', async () => {
  const { message } = await svc.sendSupportMessage({ customerId: CUSTOMER, profile: customer, kind: 'voice', audio: { path: goodPath(CUSTOMER), duration: 4.26, mime: 'audio/mp4', size: 3000 } });
  assert.equal(message.kind, 'voice');
  assert.equal(message.body, null);
  assert.equal(message.audio.duration, 4.3);
  assert.equal(message.audio.url, `https://files.test/${goodPath(CUSTOMER)}?sig=1`);
  assert.equal('path' in message.audio, false);
  const live = sent.find((e) => e.event === 'support:new');
  assert.equal(live.payload.audio.url, message.audio.url, 'the team sees it live, with the same link');
});

test("someone else's recording, a path outside this chat, or a path with .. is refused", async () => {
  for (const path of [goodPath(ADMIN), `voice/support/${ADMIN}/${CUSTOMER}/x.m4a`, `voice/other/${CUSTOMER}/x.m4a`, `voice/support/${CUSTOMER}/${CUSTOMER}/../../etc.m4a`]) {
    await assert.rejects(svc.sendSupportMessage({ customerId: CUSTOMER, profile: customer, kind: 'voice', audio: { path, duration: 3 } }), /not valid/, path);
  }
});

test('a recording that is too short, too long or was never uploaded is refused', async () => {
  const base = { customerId: CUSTOMER, profile: customer, kind: 'voice' };
  await assert.rejects(svc.sendSupportMessage({ ...base, audio: { path: goodPath(CUSTOMER), duration: 0.1 } }), /too short/);
  await assert.rejects(svc.sendSupportMessage({ ...base, audio: { path: goodPath(CUSTOMER), duration: 9999 } }), /at most/);
  stored.clear();
  await assert.rejects(svc.sendSupportMessage({ ...base, audio: { path: goodPath(CUSTOMER), duration: 3 } }), /not uploaded/);
});

test('the team can answer by voice; an unknown kind is refused', async () => {
  stored.add(goodPath(ADMIN));
  const { message } = await svc.sendSupportMessage({ customerId: CUSTOMER, profile: admin, kind: 'voice', audio: { path: goodPath(ADMIN), duration: 5 } });
  assert.equal(message.sender_role, 'admin');
  assert.equal(message.kind, 'voice');
  await assert.rejects(svc.sendSupportMessage({ customerId: CUSTOMER, profile: customer, kind: 'video', body: 'x' }), /kind/);
});

test('the upload goes under this chat and this sender, and comes back with a link', async () => {
  const up = await svc.uploadSupportVoice({ customerId: CUSTOMER, profile: customer, audio: { dataUrl: 'data:audio/mp4;base64,AAAA', duration: 3 } });
  assert.equal(up.path, `voice/support/${CUSTOMER}/${CUSTOMER}/new.m4a`);
  assert.match(up.url, /^https:\/\/files\.test\//);
  await assert.rejects(svc.uploadSupportVoice({ customerId: CUSTOMER, profile: customer, audio: { dataUrl: 'data:audio/mp4;base64,AAAA', duration: 0.1 } }), /too short/);
  await assert.rejects(svc.uploadSupportVoice({ customerId: CUSTOMER, profile: customer, audio: {} }), /Record/);
});
