/** Exchange rates for the invoice form: the latest available rate with its day, a fallback, a stale answer, and the rate saved with the invoice. */
import { test, mock, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeDb } from './fake-supabase.mjs';

let db;
let fx;
let fin;
const dbProxy = new Proxy({}, { get: (_, key) => db[key] });
const noop = async () => {};
const realFetch = globalThis.fetch;

const today = new Date().toISOString().slice(0, 10);
const unix = (iso) => Math.floor(Date.parse(`${iso}T00:00:00Z`) / 1000);
// 1 PKR = 0.0036 USD => 277.7778 PKR per USD; 1 PKR = 0.0027 GBP => 370.3704 PKR per GBP
const providerA = (date = today) => new Response(JSON.stringify({ result: 'success', time_last_update_unix: unix(date), rates: { PKR: 1, USD: 0.0036, GBP: 0.0027 } }));
const providerB = (date = '2026-01-02') => new Response(JSON.stringify({ date, pkr: { usd: 0.004, gbp: 0.003 } }));

let calls;
const network = (handler) => {
  calls = [];
  globalThis.fetch = async (url, opts) => {
    calls.push(String(url));
    return handler(String(url), opts);
  };
};

before(async () => {
  mock.module('../src/config/supabase.js', { namedExports: { supabaseAdmin: dbProxy, supabase: dbProxy } });
  mock.module('../src/services/notification.service.js', { namedExports: { notifyAdmins: noop, notifyPartner: noop, notifyUser: noop, notifyStaff: noop, partnerRecipients: async () => [] } });
  fin = await import('../src/controllers/finance.controller.js');
});

beforeEach(async () => {
  db = createFakeDb({
    platform_settings: [], invoices: [], invoice_lines: [], order_events: [], shipping_rates: [], price_items: [],
    orders: [{ id: 'o1', reference: 'SA-1', status: 'packed', order_kind: 'order', destination_country: 'United Kingdom', weight_kg: 1 }],
    order_units: [{ id: 'u1', order_id: 'o1', line_no: 1, unit_title: 'Lawn', weight_kg: 1 }],
  });
  // a fresh copy of the service every test: its memory cache starts empty
  fx = await import(`../src/services/fx-rate.service.js?t=${Math.random()}`);
});

const hand = () => { globalThis.fetch = realFetch; };

test('the rate is "PKR per 1 unit" of the chosen currency, with the day it is for', async () => {
  network(() => providerA());
  const usd = await fx.getFxRate('usd');
  assert.equal(usd.currency, 'USD');
  assert.equal(usd.rate, 277.7778);
  assert.equal(usd.rate_date, today);
  assert.equal(usd.is_today, true);
  assert.equal(usd.stale, false);
  const gbp = await fx.getFxRate('GBP');
  assert.equal(gbp.rate, 370.3704, 'any currency, nothing is hard-coded to one');
  hand();
});

test('one download answers every currency for an hour (cached); refresh asks again', async () => {
  network(() => providerA());
  await fx.getFxRate('USD');
  await fx.getFxRate('GBP');
  await fx.getFxRate('USD');
  assert.equal(calls.length, 1);
  await fx.getFxRate('USD', { force: true });
  assert.equal(calls.length, 2);
  hand();
});

test('PKR is 1 and needs no provider; bad input is refused; an unknown currency is reported', async () => {
  network(() => { throw new Error('must not be called'); });
  assert.equal((await fx.getFxRate('PKR')).rate, 1);
  assert.equal(calls.length, 0);
  await assert.rejects(() => fx.getFxRate(''), /currency/i);
  await assert.rejects(() => fx.getFxRate('US'), /3-letter/);
  network(() => providerA());
  await assert.rejects(() => fx.getFxRate('ZZZ'), /No exchange rate/);
  hand();
});

test('no rate for today (weekend / holiday): the latest available rate is returned with its real, older date', async () => {
  network(() => providerA('2020-01-05'));
  const r = await fx.getFxRate('USD');
  assert.equal(r.rate_date, '2020-01-05');
  assert.equal(r.is_today, false);
  hand();
});

test('the first provider is down: the second one answers and its date is used', async () => {
  network((url) => (url.includes('open.er-api.com') ? Promise.reject(new Error('down')) : providerB('2026-01-02')));
  const r = await fx.getFxRate('USD');
  assert.equal(r.rate, 250);
  assert.equal(r.rate_date, '2026-01-02');
  assert.equal(r.source, 'currency-api');
  hand();
});

test('both providers down: the newest saved rate is offered but flagged stale; with nothing saved the call fails (no guessed rate)', async () => {
  network(() => providerA('2026-03-03'));
  await fx.getFxRate('USD'); // saves the table
  const saved = db.table('platform_settings').find((r) => r.key === 'fx_rates');
  assert.ok(saved, 'the last good table is saved');

  const later = await import(`../src/services/fx-rate.service.js?t=${Math.random()}`); // new process: empty memory
  network(() => Promise.reject(new Error('offline')));
  const stale = await later.getFxRate('USD');
  assert.equal(stale.stale, true);
  assert.equal(stale.rate_date, '2026-03-03');
  assert.equal(stale.rate, 277.7778);

  db.table('platform_settings').length = 0;
  const empty = await import(`../src/services/fx-rate.service.js?t=${Math.random()}`);
  await assert.rejects(() => empty.getFxRate('USD'), /not available right now/);
  hand();
});

test('an older table never replaces a newer saved one', async () => {
  network(() => providerA('2026-05-05'));
  await fx.getFxRate('USD');
  const older = await import(`../src/services/fx-rate.service.js?t=${Math.random()}`);
  network(() => providerA('2026-04-04'));
  await older.getFxRate('USD');
  assert.equal(db.table('platform_settings').find((r) => r.key === 'fx_rates').value.date, '2026-05-05');
  hand();
});

const call = (fn, req) => new Promise((resolve) => {
  const res = { status() { return this; }, json(body) { resolve({ body }); return this; }, setHeader() {} };
  fn(req, res, (err) => resolve({ err }));
});
const save = (body) => call(fin.saveInvoiceDraft, { params: { orderId: 'o1' }, body: { notes: null, lines: [{ kind: 'other', label: 'Stitching', customer_amount: 5555 }], ...body }, userId: 'admin-1', access: { isAdmin: true, permissions: new Set() } });

test('the invoice keeps its currency, rate and the rate day; totals use that rate; a later rate change never touches it', async () => {
  const ok = await save({ currency: 'GBP', fx_rate: 370.3704, fx_source: 'live', fx_rate_date: '2026-10-14' });
  assert.equal(ok.err, undefined, ok.err?.message);
  const inv = db.table('invoices')[0];
  assert.equal(inv.currency, 'GBP');
  assert.equal(Number(inv.fx_rate), 370.3704);
  assert.equal(inv.total_pkr, 5555);
  assert.equal(inv.total_foreign, 15, '5555 / 370.3704 = 15.00');
  const stored = db.table('platform_settings').find((r) => r.key === `invoice_fx:${inv.id}`);
  assert.deepEqual(stored.value, { rate_date: '2026-10-14', source: 'live' });

  // the market moves: saving a draft again with the same rate still records the same day; a new rate gets its own day
  const again = await save({ currency: 'GBP', fx_rate: 380, fx_source: 'live', fx_rate_date: '2026-10-15' });
  assert.equal(again.err, undefined);
  assert.equal(db.table('platform_settings').find((r) => r.key === `invoice_fx:${inv.id}`).value.rate_date, '2026-10-15');
  assert.equal(Number(db.table('invoices')[0].fx_rate), 380);
});

test('a rate typed by hand is saved as manual, without a live rate day; a bad day is refused; PKR needs no rate', async () => {
  const manual = await save({ currency: 'USD', fx_rate: 281.5, fx_source: 'manual', fx_rate_date: '2026-10-14' });
  assert.equal(manual.err, undefined, manual.err?.message);
  const inv = db.table('invoices')[0];
  assert.deepEqual(db.table('platform_settings').find((r) => r.key === `invoice_fx:${inv.id}`).value, { rate_date: null, source: 'manual' });

  const bad = await save({ currency: 'USD', fx_rate: 281.5, fx_source: 'live', fx_rate_date: 'yesterday' });
  assert.match(bad.err?.message || '', /date is not valid/i);
  const none = await save({ currency: 'USD', fx_source: 'live' });
  assert.match(none.err?.message || '', /exchange rate/i, 'a foreign invoice cannot be saved without a rate');

  const pkr = await save({ currency: 'PKR' });
  assert.equal(pkr.err, undefined, pkr.err?.message);
  assert.equal(Number(db.table('invoices')[0].fx_rate), 1);
});
