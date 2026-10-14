import { config } from '../config/env.js';
import { supabaseAdmin } from '../config/supabase.js';
import { registerCourierProvider, unregisterCourierProvider } from './courier-provider.service.js';

/**
 * PostEx (Pakistan) merchant API, written against PostEx's "Merchant API Integration Guide v4.1.9" (the official PDF).
 *  - Auth: the `token` header. Endpoints used: get-operational-city (v2), get-merchant-address (v1), create-order (v3), track-order/{cn} (v1),
 *    cancel-order (v1). The guide documents no webhooks, so tracking is polled. It also documents a PostEx loadsheet PDF
 *    (POST v2/generate-load-sheet) and an airway bill PDF (GET v1/get-invoice); the internal loadsheet is used instead.
 *  - create-order: pickupAddressCode / storeAddressCode are OPTIONAL. Without them PostEx uses the account's default pickup address. A code that is
 *    not one of the account's real address codes is refused by PostEx ("INVALID MERCHANT STORE ADDRESS CODE"), so Settings lists the real ones.
 *  - customerPhone must be 03xxxxxxxxx. Tracking history gives each step's message and code only (no time).
 *  - Fails closed: a booking counts only when PostEx answers 2xx with statusCode 200 and a tracking number; otherwise nothing is saved.
 */

/**
 * The PostEx settings: what the admin saved in Settings > PostEx wins over the POSTEX_* values of the server's .env. The token is kept in
 * platform_settings (readable only through the service role) and is never sent back to a screen: only its last 4 characters are.
 */
let saved = {};
const px = () => ({ ...config.postex, ...Object.fromEntries(Object.entries(saved).filter(([, v]) => v !== undefined && v !== null && v !== '')) });

const SETTINGS_KEY = 'postex';
const TEXT_FIELDS = ['token', 'baseUrl', 'pickupAddressCode', 'storeAddressCode', 'orderType'];

/** PostEx's API only: the token is sent to this host, so it must be a postex.pk address over https. */
export const assertPostexUrl = (value) => {
  let u;
  try { u = new URL(String(value)); } catch { throw new PostexError('The PostEx API address is not a valid URL.', { status: 400 }); }
  if (u.protocol !== 'https:' || !(u.hostname === 'postex.pk' || u.hostname.endsWith('.postex.pk'))) throw new PostexError('The PostEx API address must be an https address on postex.pk.', { status: 400 });
  return u.origin;
};

export const loadPostexSettings = async () => {
  const { data } = await supabaseAdmin.from('platform_settings').select('value').eq('key', SETTINGS_KEY).maybeSingle();
  saved = data?.value && typeof data.value === 'object' ? data.value : {};
  return saved;
};

/** The pickup / return addresses of the PostEx account with their codes (get-merchant-address), for choosing a valid code. */
export const listMerchantAddresses = async () => {
  const json = await getMerchantAddresses();
  const code = bodyStatus(json);
  if (code && code !== '200') throw new PostexError(String(json?.statusMessage || 'PostEx did not return the addresses.'), { status: 400, response: json });
  const list = Array.isArray(json?.dist) ? json.dist : [];
  return list.map((a) => ({ addressCode: String(a.addressCode ?? ''), type: String(a.addressType ?? ''), city: String(a.cityName ?? ''), address: String(a.address ?? ''), contact: String(a.contactPersonName ?? ''), phone: String(a.phone1 ?? '') })).filter((a) => a.addressCode);
};

/** What a screen may see: never the token itself. */
export const postexSettingsView = () => {
  const cur = px();
  return {
    configured: !!cur.token,
    source: saved.token ? 'settings' : config.postex.token ? 'env' : null,
    tokenHint: cur.token ? `••••${String(cur.token).slice(-4)}` : null,
    baseUrl: cur.baseUrl,
    pickupAddressCode: cur.pickupAddressCode || '',
    storeAddressCode: cur.storeAddressCode || '',
    orderType: cur.orderType,
    pollMinutes: Number(cur.pollMinutes) || 0,
  };
};

/**
 * Save the admin's PostEx settings. An empty token keeps the current one; `clearToken` removes the saved token (the .env value, if any, applies again).
 */
export const savePostexSettings = async (input, userId) => {
  const next = { ...saved };
  for (const k of TEXT_FIELDS) {
    if (input[k] === undefined) continue;
    const v = String(input[k] ?? '').trim().slice(0, 300);
    if (k === 'token') { if (v) next.token = v; continue; }
    if (k === 'baseUrl') { next.baseUrl = v ? assertPostexUrl(v) : undefined; continue; }
    next[k] = v || undefined;
  }
  if (input.clearToken === true) delete next.token;
  if (input.pollMinutes !== undefined) {
    const n = Number(input.pollMinutes);
    if (!Number.isInteger(n) || n < 0 || n > 1440) throw new PostexError('Tracking checks must be every 0 to 1440 minutes (0 = off).', { status: 400 });
    next.pollMinutes = n;
  }
  const value = Object.fromEntries(Object.entries(next).filter(([, v]) => v !== undefined));
  const { error } = await supabaseAdmin.from('platform_settings').upsert({ key: SETTINGS_KEY, value, updated_by: userId, updated_at: new Date().toISOString() });
  if (error) throw error;
  saved = value;
  applyPostexSettings();
  return postexSettingsView();
};

let onChange = null;
/** Called by the server to start / stop the tracking poll when the settings change. */
export const onPostexSettingsChange = (fn) => { onChange = fn; };

/** Switch API booking on or off to match the settings. */
export const applyPostexSettings = () => {
  if (postexConfigured()) registerPostex();
  else unregisterCourierProvider('PostEx');
  onChange?.();
};

export const postexConfigured = () => !!px().token;

export class PostexError extends Error {
  constructor(message, { status = 502, response = null, unknownOutcome = false } = {}) {
    super(message);
    this.name = 'PostexError';
    this.statusCode = status;
    this.response = response;
    // the request may have reached PostEx (timeout / network drop): do not retry blindly, check the PostEx portal
    this.unknownOutcome = unknownOutcome;
  }
}

// replaceable in tests (a recorded or fake transport); production uses the global fetch
let transport = (...args) => fetch(...args);
export const setPostexTransport = (fn) => { transport = fn ?? ((...a) => fetch(...a)); };

/** One call to the PostEx API with a timeout. Returns the parsed JSON (or the raw text under `raw`). */
const call = async (method, path, { query, body, retries = 0 } = {}) => {
  if (!postexConfigured()) throw new PostexError('PostEx is not configured: set POSTEX_API_TOKEN on the server.', { status: 503 });
  const url = new URL(`${px().baseUrl.replace(/\/+$/, '')}${path}`);
  for (const [k, v] of Object.entries(query || {})) if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
  let lastError;
  // only reads are retried: a create-order whose outcome is unknown must never be repeated automatically
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), px().timeoutMs);
    try {
      const res = await transport(url, {
        method,
        headers: { token: px().token, 'Content-Type': 'application/json', Accept: 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: ctrl.signal,
      });
      const text = await res.text();
      let json = null;
      try { json = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
      if (!res.ok) {
        const msg = json?.statusMessage || json?.message || `PostEx answered HTTP ${res.status}`;
        if (res.status >= 500 && attempt < retries) { lastError = new PostexError(msg, { status: 502, response: json ?? text }); continue; }
        throw new PostexError(msg, { status: res.status === 401 || res.status === 403 ? 502 : 400, response: json ?? text });
      }
      return json ?? { raw: text };
    } catch (e) {
      if (e instanceof PostexError) throw e;
      const timedOut = e?.name === 'AbortError';
      lastError = new PostexError(timedOut ? 'PostEx did not answer in time.' : `Could not reach PostEx: ${e?.message || e}`, { status: 504, unknownOutcome: method !== 'GET' });
      if (attempt >= retries) throw lastError;
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError;
};

const log = (...a) => console.log('[postex]', ...a);

// ───────────── requests (paths verified from the third-party client; see the header) ─────────────

const API = '/services/integration/api/order';

/** A binary GET (the airway bill PDF). Fails unless PostEx really sent a PDF; a JSON answer is its error message. */
const callPdf = async (path, search) => {
  if (!postexConfigured()) throw new PostexError('PostEx is not configured: set the PostEx token in Settings.', { status: 503 });
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), Math.max(px().timeoutMs, 30000));
  try {
    const res = await transport(`${px().baseUrl.replace(/\/+$/, '')}${path}${search}`, { method: 'GET', headers: { token: px().token, Accept: 'application/pdf' }, signal: ctrl.signal });
    const buf = Buffer.from(await res.arrayBuffer());
    if (res.ok && buf.subarray(0, 4).toString() === '%PDF') return buf;
    let msg = `PostEx did not send a PDF (HTTP ${res.status}).`;
    try { const j = JSON.parse(buf.toString('utf8')); msg = String(j?.statusMessage || j?.message || msg); } catch { /* not JSON */ }
    throw new PostexError(msg, { status: 400, response: null });
  } catch (e) {
    if (e instanceof PostexError) throw e;
    throw new PostexError(e?.name === 'AbortError' ? 'PostEx did not answer in time.' : `Could not reach PostEx: ${e?.message || e}`, { status: 504 });
  } finally {
    clearTimeout(timer);
  }
};

/** PostEx's own airway bill (the CN slip to stick on the parcel) for up to 10 tracking numbers: GET v1/get-invoice?trackingNumbers=CX-1,CX-2 (the guide's limit is 10). */
export const airwayBillPdf = async (cns) => {
  const list = [...new Set((cns || []).map((c) => String(c).trim()).filter(Boolean))];
  if (!list.length) throw new PostexError('No CN to print.', { status: 400 });
  if (list.length > 10) throw new PostexError('PostEx prints at most 10 CNs at a time.', { status: 400 });
  return callPdf(`${API}/v1/get-invoice`, `?trackingNumbers=${list.map(encodeURIComponent).join(',')}`);
};

export const getOperationalCities = () => call('GET', `${API}/v2/get-operational-city`, { retries: 1 });
export const getOrderStatuses = () => call('GET', `${API}/v1/get-order-status`, { retries: 1 });
export const getMerchantAddresses = (cityName) => call('GET', `${API}/v1/get-merchant-address`, { query: { cityName }, retries: 1 });
export const createOrderRaw = (payload) => call('POST', `${API}/v3/create-order`, { body: payload });
export const trackOrderRaw = (cn) => call('GET', `${API}/v1/track-order/${encodeURIComponent(cn)}`, { retries: 2 });
export const cancelOrderRaw = (cn) => call('PUT', `${API}/v1/cancel-order`, { body: { trackingNumber: cn } });

/** Does the body say it failed? PostEx puts a status code (and message) in the JSON; 200 means ok. Unknown shapes are not "ok". */
const bodyStatus = (json) => {
  const code = json?.statusCode ?? json?.status_code ?? json?.status;
  return code === undefined || code === null ? null : String(code);
};

const findCn = (json) => {
  const d = json?.dist ?? json?.data ?? json;
  const v = d?.trackingNumber ?? d?.tracking_number ?? d?.cn ?? json?.trackingNumber;
  return v === undefined || v === null ? '' : String(v).trim();
};

/**
 * The payload of a booking, from the order. The order is already paid online (its invoice is paid), so there is nothing to collect on
 * delivery: invoicePayment is 0. `pickupAddressCode` / `storeAddressCode` come from the merchant addresses saved in the PostEx account.
 */
/** PostEx wants 03xxxxxxxxx: "+92 300 1234567", "92300...", "0300-1234567" and "300 1234567" all become 03001234567. */
export const localPhone = (value) => {
  let d = String(value ?? '').replace(/\D/g, '');
  if (d.startsWith('0092')) d = d.slice(4);
  else if (d.startsWith('92') && d.length === 12) d = d.slice(2);
  if (d.length === 10 && d.startsWith('3')) d = `0${d}`;
  return d;
};

export const buildCreatePayload = ({ order, itemsCount, description, destination, refNumber, notes }) => {
  // a return is posted from the partner to the return address the customer gave, not to the order's own delivery address
  const to = destination || { name: order.customer_name, phone: order.destination_phone, address: order.destination_address, city: order.destination_city };
  const city = String(to.city || '').trim();
  const address = String(to.address || '').trim();
  const phone = localPhone(to.phone);
  const problems = [];
  if (!String(to.name || '').trim()) problems.push('the receiver name');
  if (!/^03\d{9}$/.test(phone)) problems.push('a Pakistani mobile number like 0300 1234567');
  if (address.length < 5) problems.push('the delivery address');
  if (!city) problems.push('the delivery city');
  if (problems.length) throw new PostexError(`PostEx needs ${problems.join(', ')}. Complete the order's delivery details first.`, { status: 400 });
  const payload = {
    cityName: city,
    customerName: String(to.name).trim(),
    customerPhone: phone,
    deliveryAddress: address,
    invoiceDivision: 1,
    invoicePayment: 0,
    items: Math.max(1, Number(itemsCount) || 1),
    orderDetail: String(description || `Order ${order.reference}`).slice(0, 200),
    orderRefNumber: refNumber || order.reference,
    orderType: px().orderType,
    transactionNotes: notes || `Order ${order.reference}`,
  };
  if (px().pickupAddressCode) payload.pickupAddressCode = px().pickupAddressCode;
  if (px().storeAddressCode) payload.storeAddressCode = px().storeAddressCode;
  return payload;
};

/** Book the parcel with PostEx. Throws unless PostEx really answered with a tracking number. */
export const bookParcel = async ({ order, itemsCount, description, destination, refNumber, notes }) => {
  const payload = buildCreatePayload({ order, itemsCount, description, destination, refNumber, notes });
  log('create-order', payload.orderRefNumber);
  const json = await createOrderRaw(payload);
  const code = bodyStatus(json);
  if (code && code !== '200') {
    const msg = String(json?.statusMessage || json?.message || `PostEx refused the booking (status ${code}).`);
    const hint = /ADDRESS CODE/i.test(msg) ? ' Open Settings > PostEx, press "Load my PostEx addresses" and choose a real pickup address code, or leave the code fields empty (PostEx then uses your default address).' : '';
    throw new PostexError(`${msg}.${hint}`.replace(/\.\./g, '.'), { status: 400, response: json });
  }
  const cn = findCn(json);
  if (!cn) throw new PostexError('PostEx answered, but the response has no tracking number. Nothing was saved as booked: check the PostEx portal before booking again.', { status: 502, response: json, unknownOutcome: true });
  return { cn, response: json };
};

// ───────────── tracking ─────────────

/**
 * PostEx's wording -> our dispatch statuses. Matched on the status TEXT, because the numeric ids are not verified. Unknown wording maps to
 * null: the event is stored but the parcel does not move. "Delivered" is the only text that delivers; a failed attempt is not a return.
 */
export const mapPostexStatus = (text, code) => {
  // the guide's message codes: 0001 At Merchant's Warehouse · 0002/0006/0007 Returned · 0003 At PostEx Warehouse · 0004 Package on Route ·
  // 0005 Delivered · 0008 Delivery Under Review · 0013 Attempt Made: <reason>
  const c = String(code ?? '').trim();
  if (c === '0005') return 'delivered';
  if (c === '0013') return 'failed_delivery';
  if (['0002', '0006', '0007'].includes(c)) return 'returning_to_partner';
  if (c === '0003' || c === '0004') return 'in_transit';
  if (c === '0001' || c === '0008') return null;
  const t = String(text ?? '').toLowerCase().replace(/[^a-z ]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!t) return null;
  if (/\b(not|un)\s?delivered\b|\bundelivered\b/.test(t)) return 'failed_delivery';
  if (/^delivered\b|\bdelivered to (customer|consignee|receiver)\b|\bsuccessfully delivered\b/.test(t)) return 'delivered';
  if (/\breturn(ed)?\b.*\b(shipper|merchant|origin|sender)\b|\brto\b|\breturn in transit\b|\breturned\b|\breturning\b/.test(t)) return 'returning_to_partner';
  if (/\battempt|\bdelivery failed\b|\bfailed\b|\brefused\b|\bnot available\b/.test(t)) return 'failed_delivery';
  if (/\bunder review\b|\bmerchant/.test(t)) return null;
  if (/\b(on route|on root|in transit|picked|dispatched|out for delivery|at .*warehouse|arrived|shipped|en route)\b/.test(t)) return 'in_transit';
  return null;
};

const eventTime = (e) => {
  const v = e?.updatedAt ?? e?.updated_at ?? e?.date ?? e?.time ?? e?.createdAt;
  const d = v ? new Date(v) : null;
  return d && !Number.isNaN(d.getTime()) ? d.toISOString() : null;
};

/**
 * Read a track-order response: the tracking history (oldest first) as { text, at, code }. Only a body that has a recognisable history or
 * a current status is accepted; otherwise it is an error rather than a guess.
 */
export const parseTracking = (json) => {
  const code = bodyStatus(json);
  if (code && code !== '200') throw new PostexError(String(json?.statusMessage || json?.message || `PostEx tracking failed (status ${code}).`), { status: 400, response: json });
  const d = json?.dist ?? json?.data ?? json;
  const historyKey = d && typeof d === 'object' ? Object.keys(d).find((k) => /history/i.test(k) && Array.isArray(d[k])) : null;
  const history = (historyKey ? d[historyKey] : []).map((e) => ({
    text: String(e?.transactionStatusMessage ?? e?.statusMessage ?? e?.status ?? e?.message ?? '').trim(),
    code: String(e?.transactionStatusMessageCode ?? e?.statusCode ?? e?.code ?? '').trim(),
    at: eventTime(e),
  })).filter((e) => e.text);
  const current = String(d?.transactionStatus ?? d?.orderStatus ?? d?.status ?? '').trim();
  if (!history.length && !current) throw new PostexError('PostEx tracking answered in a format this system does not recognise. Nothing was changed.', { status: 502, response: json });
  history.sort((a, b) => String(a.at || '').localeCompare(String(b.at || '')));
  return { current, history };
};

export const trackParcel = async (cn) => parseTracking(await trackOrderRaw(cn));

export const cancelParcel = async (cn) => {
  const json = await cancelOrderRaw(cn);
  const code = bodyStatus(json);
  if (code && code !== '200') throw new PostexError(String(json?.statusMessage || json?.message || `PostEx did not cancel the booking (status ${code}).`), { status: 400, response: json });
  return json;
};

/** Registers PostEx as the API provider of the courier named "PostEx" (Catalogue > Couriers) when a token is set. */
export const registerPostex = () => {
  if (!postexConfigured()) return false;
  unregisterCourierProvider('PostEx');
  registerCourierProvider('PostEx', {
    name: 'PostEx',
    book: async ({ parcel }) => bookParcel(parcel),
    cancel: async ({ cn }) => cancelParcel(cn),
  });
  log('PostEx API booking is on');
  return true;
};
