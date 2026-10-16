import { supabaseAdmin } from '../config/supabase.js';
import { BadRequestError, NotFoundError } from '../utils/error.helper.js';

/**
 * Exchange rates for the invoice form. The base currency is PKR; a rate is "PKR per 1 unit of the foreign currency" (what an invoice stores
 * as fx_rate: total_foreign = total_pkr / fx_rate).
 *
 * Providers (free, no key, so there is nothing to leak), tried in order:
 *   1. open.er-api.com     the day's rates (updated once a day); the date is its own "last update"
 *   2. jsDelivr currency-api   daily rates with their date
 * One answer holds every currency, so it is kept in memory for an hour and the last good table is also saved (platform_settings 'fx_rates')
 * so that, when both providers are down, the newest rate we have is still offered and clearly flagged as `stale` with its real date.
 * Nothing here ever invents a rate: with no provider and no saved table the call fails and the screen shows a retry.
 */
const BASE = 'PKR';
const MEMORY_TTL_MS = 60 * 60 * 1000;
const TIMEOUT_MS = 12_000;
const SETTINGS_KEY = 'fx_rates';

const PROVIDERS = [
  {
    name: 'open.er-api.com',
    url: `https://open.er-api.com/v6/latest/${BASE}`,
    parse: (j) => {
      if (j?.result !== 'success' || !j.rates || !j.time_last_update_unix) throw new Error('unexpected answer');
      return { date: new Date(j.time_last_update_unix * 1000).toISOString().slice(0, 10), perPkr: j.rates };
    },
  },
  {
    name: 'currency-api',
    url: `https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/${BASE.toLowerCase()}.json`,
    parse: (j) => {
      const table = j?.[BASE.toLowerCase()];
      if (!table || !/^\d{4}-\d{2}-\d{2}$/.test(String(j.date))) throw new Error('unexpected answer');
      return { date: j.date, perPkr: Object.fromEntries(Object.entries(table).map(([k, v]) => [k.toUpperCase(), v])) };
    },
  },
];

let memory = null; // { date, source, fetched_at, perPkr, at }
let inflight = null;

const fetchJson = async (url) => {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
};

const loadFromProviders = async () => {
  const failures = [];
  for (const p of PROVIDERS) {
    try {
      const { date, perPkr } = p.parse(await fetchJson(p.url));
      return { date, source: p.name, fetched_at: new Date().toISOString(), perPkr };
    } catch (e) {
      failures.push(`${p.name}: ${e?.message || 'failed'}`);
    }
  }
  console.warn('[fx] no provider answered:', failures.join(' | '));
  return null;
};

const saved = async () => {
  const { data } = await supabaseAdmin.from('platform_settings').select('value').eq('key', SETTINGS_KEY).maybeSingle();
  const v = data?.value;
  return v?.perPkr && v?.date ? v : null;
};

const save = async (table) => {
  // a table dated earlier than the one already saved never replaces it
  const current = await saved();
  if (current && current.date > table.date) return;
  await supabaseAdmin.from('platform_settings').upsert({ key: SETTINGS_KEY, value: table, updated_at: new Date().toISOString() }).then(({ error }) => {
    if (error) console.warn('[fx] could not save the rate table:', error.message);
  });
};

/** The newest table: memory (fresh), else the providers, else the last saved one (stale). */
const table = async ({ force = false } = {}) => {
  if (!force && memory && Date.now() - memory.at < MEMORY_TTL_MS) return { ...memory, stale: false };
  if (!inflight) {
    inflight = (async () => {
      const fresh = await loadFromProviders();
      if (fresh) {
        memory = { ...fresh, at: Date.now() };
        await save(fresh);
        return { ...memory, stale: false };
      }
      const old = memory ?? (await saved());
      if (old) return { ...old, stale: true };
      return null;
    })().finally(() => {
      inflight = null;
    });
  }
  return inflight;
};

const round4 = (n) => Math.round(n * 10000) / 10000;

/**
 * The rate of one currency.
 * @returns {{ currency: string, base: string, rate: number, rate_date: string, is_today: boolean, stale: boolean, source: string, fetched_at: string }}
 */
export const getFxRate = async (currency, { force = false } = {}) => {
  const code = String(currency || '').trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(code)) throw new BadRequestError('Choose a currency (a 3-letter code such as USD).');
  const today = new Date().toISOString().slice(0, 10);
  if (code === BASE) return { currency: code, base: BASE, rate: 1, rate_date: today, is_today: true, stale: false, source: 'base currency', fetched_at: new Date().toISOString() };

  const t = await table({ force });
  if (!t) throw Object.assign(new Error('Exchange rates are not available right now. Check the connection and try again.'), { statusCode: 502 });
  const perPkr = Number(t.perPkr[code]);
  if (!(perPkr > 0)) throw new NotFoundError(`No exchange rate is available for ${code}.`);
  return { currency: code, base: BASE, rate: round4(1 / perPkr), rate_date: t.date, is_today: t.date === today, stale: !!t.stale, source: t.source, fetched_at: t.fetched_at };
};

/** The rate date and source saved with an invoice (platform_settings, one row per invoice, so a later change never touches it). */
const invoiceKey = (invoiceId) => `invoice_fx:${invoiceId}`;

export const saveInvoiceFx = async (invoiceId, { rate_date, source }, userId) => {
  const value = { rate_date: rate_date ?? null, source: source === 'manual' ? 'manual' : 'live' };
  const { error } = await supabaseAdmin.from('platform_settings').upsert({ key: invoiceKey(invoiceId), value, updated_by: userId ?? null, updated_at: new Date().toISOString() });
  if (error) throw error;
  return value;
};

export const loadInvoiceFx = async (invoiceId) => {
  if (!invoiceId) return null;
  const { data } = await supabaseAdmin.from('platform_settings').select('value').eq('key', invoiceKey(invoiceId)).maybeSingle();
  return data?.value ?? null;
};

export const DATE = /^\d{4}-\d{2}-\d{2}$/;
