/** The partner sidebar counts: Production shows the articles waiting in "To assign", only for people who may see Production. */
import { test, mock, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeDb } from './fake-supabase.mjs';

let db;
let partner;
const dbProxy = new Proxy({}, { get: (_, key) => db[key] });

before(async () => {
  mock.module('../src/config/supabase.js', { namedExports: { supabaseAdmin: dbProxy, supabase: dbProxy } });
  partner = await import('../src/controllers/partner.controller.js');
});

beforeEach(() => {
  db = createFakeDb({
    orders: [],
    transfers: [],
    job_cards: [
      { id: 'j1', stage: 'to_assign', partner_id: 'p1' },
      { id: 'j2', stage: 'to_assign', partner_id: 'p1' },
      { id: 'j3', stage: 'cutting', partner_id: 'p1' },
      { id: 'j4', stage: 'to_assign', partner_id: 'p2' }, // another partner's article
    ],
  });
});

const badges = (permissions) =>
  new Promise((resolve, reject) => {
    const res = { status() { return this; }, json(b) { resolve(b.data); return this; } };
    partner.getPartnerBadges({ access: { isAdmin: false, partnerId: 'p1', permissions: new Set(permissions) } }, res, reject);
  });

test('Production counts the partner\'s own articles in To assign', async () => {
  assert.equal((await badges(['production.view'])).production, 2);
});

test('a person without Production access gets 0, not the count', async () => {
  assert.equal((await badges(['receiving.view'])).production, 0);
});
