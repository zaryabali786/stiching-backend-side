/**
 * Sign-in with a one-time code at the API: the answer never reveals which emails have an account, only customers can use it, and a
 * code works once. The database, Supabase sessions and email are faked.
 */
import { test, mock, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeDb } from './fake-supabase.mjs';

let db;
let ctl;
let sent;
let profiles;
const dbProxy = new Proxy({}, { get: (_, key) => db[key] });
let ipCounter = 0;

before(async () => {
  process.env.LOGIN_CODE_SECRET = 'test-login-secret';
  mock.module('../src/config/supabase.js', { namedExports: { supabaseAdmin: dbProxy, supabase: dbProxy } });
  mock.module('../src/services/transactional-email.service.js', {
    namedExports: {
      renderEmail: (c) => ({ text: [c.heading, ...(c.paragraphs || [])].join('\n'), html: '' }),
      sendTransactionalEmail: async (m) => (sent.push(m), { sent: true }),
      transactionalEnabled: () => true,
      transactionalFrom: () => 'noreply@example.test',
    },
  });
  mock.module('../src/models/user.model.js', {
    defaultExport: {
      findProfileByEmail: async (email) => profiles.find((p) => p.email === email) || null,
      signInVerifiedEmail: async (email) => ({ user: { id: 'x', email }, session: { access_token: `at_${email}`, refresh_token: 'rt', expires_in: 3600, expires_at: 1 } }),
      getProfile: async () => null,
      create: async () => ({}),
      authenticate: async () => ({}),
      signOut: async () => {},
    },
  });
  // the real access module, with only "who is this person" faked (the controller needs the other exports too)
  const realAccess = await import('../src/services/access.service.js');
  mock.module('../src/services/access.service.js', {
    namedExports: { ...realAccess, resolveAccess: async () => ({}), accessPayload: () => ({ permissions: [] }) },
  });
  ctl = await import('../src/controllers/auth.controller.js');
});

beforeEach(() => {
  sent = [];
  db = createFakeDb({ login_codes: [] });
  profiles = [
    { id: 'c1', email: 'ali@example.com', role: 'customer', is_active: true, customer_code: 'STX-10001', full_name: 'Ali' },
    { id: 'a1', email: 'boss@example.com', role: 'admin', is_active: true },
    { id: 'p1', email: 'pending@example.com', role: 'customer', requested_role: 'partner_staff', is_active: true },
    { id: 'd1', email: 'off@example.com', role: 'customer', is_active: false },
  ];
});

const call = async (handler, body) => {
  const res = { code: 200, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } };
  let error = null;
  // a fresh address each time so the small in-memory limit does not interfere
  handler({ body, ip: `10.0.0.${++ipCounter}` }, res, (e) => (error = e));
  for (let i = 0; i < 10 && !res.body && !error; i++) await new Promise((r) => setImmediate(r));
  return { res, error };
};

const codeFromMail = () => /\b(\d{6})\b/.exec(sent.at(-1)?.text || '')?.[1];

test('asking for a code gives the same answer for every email and only mails a real customer', async () => {
  const known = await call(ctl.requestLoginCode, { email: 'ali@example.com' });
  const unknown = await call(ctl.requestLoginCode, { email: 'nobody@example.com' });
  const staff = await call(ctl.requestLoginCode, { email: 'boss@example.com' });
  const pending = await call(ctl.requestLoginCode, { email: 'pending@example.com' });
  const off = await call(ctl.requestLoginCode, { email: 'off@example.com' });
  for (const r of [known, unknown, staff, pending, off]) assert.equal(r.res.body.message, known.res.body.message, 'the answer does not depend on the email');
  assert.deepEqual(sent.map((m) => m.to), ['ali@example.com'], 'only the active customer is mailed');
  assert.match(sent[0].subject, /sign-in code/);
  assert.match(codeFromMail(), /^\d{6}$/);
});

test('a bad email is refused', async () => {
  assert.ok((await call(ctl.requestLoginCode, { email: 'nope' })).error);
  assert.ok((await call(ctl.verifyLoginCode, { email: 'nope', code: '123456' })).error);
});

test('the right code signs the customer in once', async () => {
  await call(ctl.requestLoginCode, { email: 'ali@example.com' });
  const code = codeFromMail();
  const ok = await call(ctl.verifyLoginCode, { email: 'ali@example.com', code });
  assert.equal(ok.error, null);
  assert.equal(ok.res.body.data.tokens.accessToken, 'at_ali@example.com');
  assert.equal(ok.res.body.data.user.email, 'ali@example.com');
  assert.equal('inbound_email_token' in ok.res.body.data.user, false);
  const again = await call(ctl.verifyLoginCode, { email: 'ali@example.com', code });
  assert.ok(again.error, 'the same code does not work twice');
});

test('a wrong code, another email\'s code or a made-up token does not sign anyone in', async () => {
  await call(ctl.requestLoginCode, { email: 'ali@example.com' });
  const code = codeFromMail();
  assert.ok((await call(ctl.verifyLoginCode, { email: 'ali@example.com', code: code === '000000' ? '111111' : '000000' })).error);
  assert.ok((await call(ctl.verifyLoginCode, { email: 'off@example.com', code })).error);
  assert.ok((await call(ctl.verifyLoginCode, { email: 'ali@example.com', token: 'f'.repeat(48) })).error);
  assert.equal((await call(ctl.verifyLoginCode, { email: 'ali@example.com', code })).error, null, 'the right code still works after wrong tries');
});

test('staff, pending-staff and deactivated accounts cannot sign in with a code even with a valid one', async () => {
  const { issueLoginCode } = await import('../src/services/login-code.service.js');
  for (const email of ['boss@example.com', 'pending@example.com', 'off@example.com']) {
    const code = await issueLoginCode(email);
    assert.ok((await call(ctl.verifyLoginCode, { email, code })).error, email);
  }
});

test('the button in the email (a token) signs the customer in once', async () => {
  const { issueLoginCode } = await import('../src/services/login-code.service.js');
  const token = await issueLoginCode('ali@example.com', { kind: 'link' });
  const ok = await call(ctl.verifyLoginCode, { email: 'ali@example.com', token });
  assert.equal(ok.error, null);
  assert.ok((await call(ctl.verifyLoginCode, { email: 'ali@example.com', token })).error);
});
