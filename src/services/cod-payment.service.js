import { supabaseAdmin } from '../config/supabase.js';
import { config } from '../config/env.js';
import { round2 } from '../utils/db.js';
import { BadRequestError, ConflictError, ForbiddenError } from '../utils/error.helper.js';
import { addEvent, STATUS_LABELS } from './order.service.js';
import { isCod } from './email-order-match.service.js';
import { notifyUser, notifyAdmins } from './notification.service.js';
import { emitTo, rooms } from '../realtime/io.js';
import { cancelPaymentIntent, createCheckoutSession, createCodPaymentIntent, expireCheckoutSession, isStripeEnabled, retrieveCheckoutSession, retrievePaymentIntent, toMinorUnits } from './stripe.service.js';

/**
 * Cash on delivery (COD) for orders that came from an email.
 *
 * The customer (or authorised staff) marks an email order COD or NON_COD. NON_COD changes nothing: the order follows the normal
 * workflow. COD: the order total is read from the original email, saved on the order, and the customer pays it with Stripe
 * Checkout (Pay Now) before the order can be edited. Payment is only ever marked PAID by a server-side check with Stripe (the
 * webhook, or the confirm call that asks Stripe itself), never because the customer came back to a success page.
 *
 * Orders that never went through this choice have `payment_type = NULL` and behave exactly as before.
 */

export const COD_LOCK_MESSAGE = 'This is a cash on delivery order. Pay the total first; the order can be edited once the payment is confirmed.';
export const COD_CHOOSE_MESSAGE = 'Choose COD or Non-COD for this order first.';
export const COD_MIGRATION_MESSAGE = 'Cash on delivery needs the database update 0041 (npm run migrate).';

const AMOUNT_OK = ['extracted', 'verified', 'corrected'];

/** Rows that are not PAID yet (a NULL status counts as not paid; plain "<> 'PAID'" would skip NULLs). */
const notPaid = (query) => query.or('cod_payment_status.is.null,cod_payment_status.neq.PAID');

export const isEmailOrder = (order) => order?.order_source === 'email' || order?.import_source === 'email';

/** COD and not paid yet: editing stays blocked until Stripe confirms the payment. */
export const isCodLocked = (order) => order?.payment_type === 'COD' && order?.cod_payment_status !== 'PAID';

export const COD_RECEIVE_MESSAGE = 'Payment is required before receiving this order. The client has to pay the order total first.';

/**
 * The backend rule behind the Received button: a COD order is not received until its payment is confirmed by Stripe. This is checked on
 * the server for every receiving call (the app only mirrors it by disabling the button).
 */
export const assertReceivable = (order) => {
  if (isCodLocked(order)) throw new ConflictError(COD_RECEIVE_MESSAGE);
};

/** Same rule for a caller that only has the order's id (receiving). Orders from before the COD feature have no payment type and pass. */
export const assertReceivableById = async (orderId) => {
  const { data, error } = await supabaseAdmin.from('orders').select('id, payment_type, cod_payment_status').eq('id', orderId).maybeSingle();
  // the columns do not exist before database update 0041: then nothing is COD and receiving is not restricted
  if (error || !data) return;
  assertReceivable(data);
};

/** Tell everyone who watches this order that its payment state changed (customer app, admins, the partner's receiving people). */
export const emitPaymentUpdate = (order) => {
  const payload = { orderId: order.id, reference: order.reference, unitId: null, orderStatus: order.status, status: order.status, status_label: STATUS_LABELS[order.status], payment: true, at: new Date().toISOString() };
  emitTo(rooms.user(order.customer_id), 'order:update', payload);
  emitTo(rooms.user(order.customer_id), 'unit:update', payload);
  emitTo(rooms.admins, 'unit:update', payload);
  if (order.partner_id) emitTo(rooms.production(order.partner_id), 'unit:update', payload);
};

/** The backend rule behind the Edit button (the app hides it too, but this is what counts). */
export const assertCodEditable = (order) => {
  if (isCodLocked(order)) throw new ForbiddenError(COD_LOCK_MESSAGE);
  // A draft made from an email is created only after the payment type is chosen: Non-COD, or COD once it is paid. Choosing unlocks it.
  if (order?.status === 'draft' && !order.payment_type) throw new BadRequestError(COD_CHOOSE_MESSAGE);
};

/** What the apps show: type, verified total, currency and payment status (never Stripe ids). */
export const codView = (order) => {
  const type = order.payment_type ?? null;
  const status = type === 'COD' ? order.cod_payment_status || 'UNPAID' : order.cod_payment_status ?? null;
  const amountOk = AMOUNT_OK.includes(order.cod_amount_status) && Number(order.cod_amount) > 0 && !!order.cod_currency;
  const needsVerification = type === 'COD' && !amountOk && status !== 'PAID';
  const locked = isCodLocked(order);
  // one readable payment state for the apps, kept apart from the order's workflow status
  const paymentState = type !== 'COD' ? 'not_required' : status === 'PAID' ? 'paid' : needsVerification ? 'verification_pending' : status === 'PENDING' ? 'processing' : 'payment_required';
  return {
    payment_type: type,
    source: order.external_source === 'shopify' ? 'shopify' : isEmailOrder(order) ? 'email' : 'manual',
    payment_state: paymentState,
    receive_blocked: locked,
    receive_block_reason: locked ? COD_RECEIVE_MESSAGE : null,
    shopify: order.shopify_financial_status
      ? { financial_status: order.shopify_financial_status, amount_paid: order.shopify_amount_paid == null ? null : Number(order.shopify_amount_paid), outstanding: order.shopify_outstanding == null ? null : Number(order.shopify_outstanding) }
      : null,
    email_order: isEmailOrder(order),
    email_says_cod: isCod(order.brand_payment_method),
    // the two options are shown while nothing was chosen on an email order that is still open
    can_choose: !type && isEmailOrder(order) && ['draft', 'submitted'].includes(order.status),
    amount: order.cod_amount == null ? null : Number(order.cod_amount),
    currency: order.cod_currency ?? null,
    amount_status: order.cod_amount_status ?? null,
    amount_note: order.cod_amount_note ?? null,
    payment_status: status,
    needs_verification: needsVerification,
    can_pay: type === 'COD' && amountOk && status !== 'PAID',
    locked,
    paid_at: order.cod_paid_at ?? null,
  };
};

/** The new columns are missing until migration 0041 is applied: say so instead of a raw database error. */
const dbError = (error, what) => {
  if (!error) return;
  if (/could not find the '(payment_type|payment_type_set_by|payment_type_set_at|cod_\w+)' column|column [^ ]*(payment_type|cod_\w+)[^ ]* does not exist|cod_amount_audit[^.]*(does not exist|schema cache)/i.test(error.message || '')) {
    throw new ConflictError(COD_MIGRATION_MESSAGE);
  }
  throw new Error(`${what}: ${error.message}`);
};

// ───────────── reading the total from the email ─────────────

const CURRENCY_WORDS = 'PKR|USD|AED|GBP|EUR|SAR|CAD|AUD|QAR|KWD|OMR|BHD|CHF|JPY|CNY|INR|MYR|SGD|NZD|TRY';
const MARKER = `(?:${CURRENCY_WORDS}|Rs\\.?|₨|\\$|£|€)`;
const MONEY = new RegExp(`(?:(${MARKER})\\s*)?(\\d{1,3}(?:,\\d{3})+(?:\\.\\d{1,2})?|\\d+(?:[.,]\\d{1,2})?)(?:\\s*(${CURRENCY_WORDS})\\b)?`, 'gi');

const STRONG_LABEL = /\b(grand\s*total|order\s*total|total\s*(payable|amount|due|price)|amount\s*(payable|due)|total\s*to\s*pay|you\s*pay|balance\s*due|total\s*charged|net\s*payable)\b/i;
const ANY_TOTAL = /\btotal\b/i;
const NOT_A_TOTAL = /(sub\s*-?\s*total|shipping|delivery\s*(charge|fee|cost)?|handling|\btax(es)?\b|\bvat\b|\bgst\b|discount|saving|coupon|voucher|total\s*(items?|qty|quantity|units|weight|savings)|items?\s*total|refund|reward|points|cod\s*(fee|charge)|cash\s*on\s*delivery\s*(fee|charge))/i;

/** An ISO code from a code or symbol. A bare "$" or "kr" names no single currency, so it returns null (staff must confirm). */
export const normaliseCurrency = (value) => {
  const s = String(value ?? '').trim().toUpperCase();
  if (!s) return null;
  if (/^[A-Z]{3}$/.test(s)) return s;
  if (['RS', 'RS.', '₨', 'RUPEES', 'PAKISTANI RUPEE', 'PAKISTANI RUPEES'].includes(s)) return 'PKR';
  if (s === '£') return 'GBP';
  if (s === '€') return 'EUR';
  return null;
};

/** "4,500.00", "4500", "1.234,50" -> a number (two decimals), or null. */
export const parseAmount = (raw) => {
  let s = String(raw ?? '').replace(/[^\d.,]/g, '');
  if (!s) return null;
  const dot = s.lastIndexOf('.');
  const comma = s.lastIndexOf(',');
  if (dot >= 0 && comma >= 0) {
    s = dot > comma ? s.replace(/,/g, '') : s.replace(/\./g, '').replace(',', '.');
  } else if (comma >= 0) {
    s = /,\d{1,2}$/.test(s) && (s.match(/,/g) || []).length === 1 ? s.replace(',', '.') : s.replace(/,/g, '');
  } else if ((s.match(/\./g) || []).length > 1) {
    s = s.replace(/\./g, '');
  }
  const n = Number(s);
  return Number.isFinite(n) ? round2(n) : null;
};

const plainLines = (text) =>
  String(text ?? '')
    .replace(/<\s*(br|\/p|\/div|\/tr|\/li|\/h\d)\b[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .split(/\r?\n/)
    .map((l) => l.replace(/[ \t]+/g, ' ').trim())
    .filter(Boolean);

/** The amount on one line (after the label): the last amount that carries a currency or looks like money, else the last number. */
const amountOnLine = (rest) => {
  const found = [];
  for (const m of rest.matchAll(MONEY)) {
    const value = parseAmount(m[2]);
    if (value == null || value <= 0) continue;
    const marker = m[1] || m[3] || null;
    const looksLikeMoney = !!marker || /[.,]/.test(m[2]);
    found.push({ value, currency: normaliseCurrency(marker), marker: !!marker, money: looksLikeMoney });
  }
  return found.filter((f) => f.marker).at(-1) ?? found.filter((f) => f.money).at(-1) ?? found.at(-1) ?? null;
};

/** The labelled totals of an email: [{ value, currency, strong }]. Sub-totals, shipping, tax, discounts and item counts never count. */
export const findTotalsInText = (text) => {
  const lines = plainLines(text);
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const original = lines[i];
    if (!ANY_TOTAL.test(original) && !STRONG_LABEL.test(original)) continue;
    // "(incl. tax)", "(3 items)" and "incl. VAT" describe the total, they are not another line
    const probe = original.replace(/\([^)]*\)/g, ' ').replace(/\b(incl(uding|usive of)?\.?|inc\.)\s+(tax(es)?|vat|gst)\b/gi, ' ');
    if (NOT_A_TOTAL.test(probe)) continue;
    const strong = STRONG_LABEL.test(probe);
    const label = (strong ? probe.match(STRONG_LABEL) : probe.match(ANY_TOTAL))[0];
    let hit = amountOnLine(probe.slice(probe.toLowerCase().indexOf(label.toLowerCase()) + label.length));
    // the amount can sit on the next line ("Total" / "Rs. 4,500")
    if (!hit && lines[i + 1] && lines[i + 1].length <= 24) hit = amountOnLine(lines[i + 1]);
    if (hit) out.push({ value: hit.value, currency: hit.currency, strong });
  }
  return out;
};

/**
 * The order's total payable amount and currency. The order reader already saved a total on the order (`brand_order_total`);
 * it is cross-checked against the labelled totals in the original email text. Anything missing, ambiguous or contradictory
 * is NOT guessed: it comes back as needs_verification with the reason, and staff enter the amount.
 * @returns {{ amount: number|null, currency: string|null, status: 'extracted'|'needs_verification', source: string|null, note: string|null }}
 */
export const readCodAmount = ({ order, emailText = '' }) => {
  const ai = Number(order?.brand_order_total);
  const aiAmount = Number.isFinite(ai) && ai > 0 ? round2(ai) : null;
  const aiCurrency = normaliseCurrency(order?.brand_order_currency);
  const found = findTotalsInText(emailText);
  const strong = [...new Set(found.filter((f) => f.strong).map((f) => f.value))];
  const weak = [...new Set(found.filter((f) => !f.strong).map((f) => f.value))];
  const ambiguous = strong.length > 1 || (!strong.length && weak.length > 1);
  const textValue = ambiguous ? null : strong.length ? strong[0] : weak.length ? weak[0] : null;
  const textCurrencies = [...new Set(found.filter((f) => f.value === textValue && f.currency).map((f) => f.currency))];
  const textCurrency = textCurrencies.length === 1 ? textCurrencies[0] : null;
  const fail = (note) => ({ amount: null, currency: null, status: 'needs_verification', source: null, note });

  if (ambiguous) return fail(`The email shows several different totals (${[...strong, ...weak].join(', ')}). Check the original email and enter the total payable.`);
  if (aiAmount != null && textValue != null && Math.abs(aiAmount - textValue) > 0.005) {
    return fail(`The total read from the order (${aiAmount}) differs from the total in the email text (${textValue}). Check the original email and enter the total payable.`);
  }
  const amount = aiAmount ?? textValue;
  if (amount == null) return fail('No total could be found in the email. Check the original email and enter the total payable.');
  if (aiCurrency && textCurrency && aiCurrency !== textCurrency) return fail(`The currency is unclear (${aiCurrency} or ${textCurrency}). Check the original email and enter the currency.`);
  const currency = aiCurrency || textCurrency;
  if (!currency) return fail(`The total (${amount}) was found but its currency is not clear. Check the original email and enter the currency.`);
  return { amount, currency, status: 'extracted', source: aiAmount != null ? 'email_ai' : 'email_text', note: null };
};

/** The original email of an email order (the stored copy in the customer's inbox), or null. */
export const loadOrderEmail = async (order) => {
  if (!order?.import_id) return null;
  const { data } = await supabaseAdmin.from('inbox_emails').select('id, body_text, body_html').eq('import_id', order.import_id).limit(1).maybeSingle();
  if (!data) return null;
  return { id: data.id, text: data.body_text || data.body_html || '' };
};

// ───────────── choosing COD or NON_COD ─────────────

const reload = async (orderId) => {
  const { data, error } = await supabaseAdmin.from('orders').select('*').eq('id', orderId).maybeSingle();
  if (error) dbError(error, 'load the order');
  return data;
};

const retireSession = async (order) => {
  if (!isStripeEnabled()) return;
  if (order.cod_stripe_session_id) await expireCheckoutSession(order.cod_stripe_session_id);
  if (order.cod_stripe_payment_intent && order.cod_payment_status !== 'PAID') await cancelPaymentIntent(order.cod_stripe_payment_intent);
};

/** The payment history of COD orders (table cod_payments, migration 0044). Never throws: the payment itself must not depend on it. */
const ledger = async (orderId, ref, patch, { insert = null } = {}) => {
  try {
    if (!ref) return;
    if (insert) await supabaseAdmin.from('cod_payments').upsert({ order_id: orderId, provider: 'stripe', provider_ref: ref, ...insert }, { onConflict: 'provider_ref', ignoreDuplicates: true });
    if (patch) await supabaseAdmin.from('cod_payments').update({ ...patch, updated_at: new Date().toISOString() }).eq('provider_ref', ref);
  } catch (err) {
    console.warn('[COD] could not write the payment history:', err.message);
  }
};

/** The order is discarded or cancelled: a Stripe page that is still open must not be payable any more. Never throws. */
export const retireCodCheckout = async (order) => {
  try {
    if (order?.payment_type === 'COD' && order.cod_payment_status === 'PENDING') await retireSession(order);
  } catch {
    /* best effort */
  }
};

/**
 * Save COD or NON_COD on an email order. A customer may choose while the order is still open and nothing was chosen (or move
 * from Non-COD to COD); only staff move an order away from COD, and a customer cannot pick Non-COD when the email states COD.
 * @param {{ order: object, type: 'COD'|'NON_COD', actor: { id: string, role: 'customer'|'staff' } }} args
 */
export const setPaymentType = async ({ order, type, actor }) => {
  if (!['COD', 'NON_COD'].includes(type)) throw new BadRequestError('Choose COD or Non-COD.');
  if (!isEmailOrder(order)) throw new BadRequestError('COD / Non-COD applies to orders that came from an email.');
  if (order.status === 'cancelled') throw new BadRequestError('This order is cancelled.');
  if (order.payment_type === type) return { order, changed: false };
  // a Shopify order Shopify itself reports as fully paid has nothing left to collect: never ask for the same money twice
  if (type === 'COD' && order.external_source === 'shopify' && String(order.shopify_financial_status || '').toLowerCase() === 'paid' && !(Number(order.shopify_outstanding) > 0)) {
    throw new ConflictError('Shopify shows this order as fully paid, so there is nothing to collect.');
  }
  if (order.payment_type === 'COD' && order.cod_payment_status === 'PAID') throw new ConflictError('This COD order is already paid; its payment type cannot be changed.');

  // moving an unpaid COD order to Non-COD would skip the payment: only an admin may (for example a misread email), never the partner's people
  if (actor.role === 'staff' && !actor.admin && order.payment_type === 'COD' && type === 'NON_COD') {
    throw new ForbiddenError('Only an admin can change an unpaid COD order to Non-COD. The customer has to pay first.');
  }
  if (actor.role === 'customer') {
    if (!['draft', 'submitted'].includes(order.status)) throw new ForbiddenError('The payment type can be chosen only while the order is open. Ask our team to change it.');
    if (order.payment_type === 'COD') throw new ForbiddenError('Only our team can change a COD order to Non-COD.');
    if (type === 'NON_COD' && isCod(order.brand_payment_method)) throw new ConflictError('The email says cash on delivery, so this order is COD. If that is wrong, ask our team to change it.');
  }

  const now = new Date().toISOString();
  const patch = { payment_type: type, payment_type_set_by: actor.id, payment_type_set_at: now, updated_at: now };

  if (type === 'COD') {
    // keep an amount staff already confirmed; otherwise read it from the original email now
    const confirmed = AMOUNT_OK.includes(order.cod_amount_status) && Number(order.cod_amount) > 0 && order.cod_currency;
    if (!confirmed && order.external_source === 'shopify' && Number(order.shopify_outstanding) > 0 && order.brand_order_currency) {
      // the amount Shopify says is still owed (not the whole order when part of it was paid)
      Object.assign(patch, { cod_amount: Number(order.shopify_outstanding), cod_currency: normaliseCurrency(order.brand_order_currency), cod_amount_status: 'verified', cod_amount_source: 'shopify', cod_amount_note: 'The amount Shopify reports as outstanding.' });
    } else if (!confirmed) {
      const email = await loadOrderEmail(order);
      const read = readCodAmount({ order, emailText: email?.text || '' });
      Object.assign(patch, {
        cod_amount: read.amount,
        cod_currency: read.currency,
        cod_amount_status: read.status,
        cod_amount_source: read.source,
        cod_amount_note: read.note,
        cod_email_ref: email?.id ?? null,
      });
    }
    if (order.cod_payment_status !== 'PENDING') patch.cod_payment_status = 'UNPAID';
  } else {
    // Non-COD: the old workflow, no Stripe step. A payment page that was opened is closed.
    await retireSession(order);
    // the last session id stays: it keeps a later retry from getting that expired session back from Stripe's idempotency
    Object.assign(patch, { cod_payment_status: null });
  }

  const { data, error } = await supabaseAdmin.from('orders').update(patch).eq('id', order.id).select('*').maybeSingle();
  if (error) dbError(error, 'save the payment type');
  await addEvent(order.id, order.status, type === 'COD' ? 'Marked as cash on delivery (COD)' : 'Marked as Non-COD', actor.id);
  const saved = data || { ...order, ...patch };
  // staff marked it COD: the customer is told that payment is needed, and every open screen refreshes
  if (type === 'COD' && actor.role === 'staff') {
    await notifyUser(order.customer_id, { type: 'invoice', title: `Payment required: ${order.reference}`, body: 'Please pay the order total in the app. Your parcel is received after the payment is confirmed.', link: `/app/orders/${order.id}`, orderId: order.id }).catch(() => undefined);
  }
  emitPaymentUpdate(saved);
  return { order: saved, changed: true };
};

// ───────────── staff confirm or correct the total ─────────────

/** Authorised staff enter the verified total (needed when the email gave none or an unclear one), or correct it. Always audited. */
export const verifyCodAmount = async ({ order, amount, currency, reason, actor }) => {
  if (order.payment_type !== 'COD') throw new BadRequestError('This order is not marked as COD.');
  if (order.cod_payment_status === 'PAID') throw new ConflictError('This order is already paid; the amount can no longer be changed.');
  const value = parseAmount(amount);
  const iso = normaliseCurrency(currency);
  if (value == null || value <= 0 || value > 10_000_000) throw new BadRequestError('Enter the total payable as a number above zero.');
  if (!iso) throw new BadRequestError('Enter the currency as a 3-letter code, for example PKR or USD.');
  const why = String(reason ?? '').trim();
  if (why.length < 3) throw new BadRequestError('Write a short reason (where the total comes from, or why it changed).');

  // the values as they were before this change (for the audit entry)
  const before = { amount: order.cod_amount ?? null, currency: order.cod_currency ?? null };
  const hadAmount = AMOUNT_OK.includes(order.cod_amount_status) && Number(order.cod_amount) > 0;
  const same = hadAmount && Math.abs(Number(order.cod_amount) - value) < 0.005 && order.cod_currency === iso;
  const status = hadAmount && !same ? 'corrected' : 'verified';
  const now = new Date().toISOString();

  // a payment page that was opened for the old amount must not stay usable
  if (!same) {
    await retireSession(order);
  }
  const patch = {
    cod_amount: value,
    cod_currency: iso,
    cod_amount_status: status,
    cod_amount_source: 'manual',
    cod_amount_note: null,
    cod_payment_status: same ? order.cod_payment_status || 'UNPAID' : 'UNPAID',
    updated_at: now,
  };
  const { data, error } = await notPaid(supabaseAdmin.from('orders').update(patch).eq('id', order.id)).select('*').maybeSingle();
  if (error) dbError(error, 'save the amount');
  if (!data) throw new ConflictError('This order was just paid; the amount can no longer be changed.');
  const audit = await supabaseAdmin.from('cod_amount_audit').insert({
    order_id: order.id,
    old_amount: before.amount,
    old_currency: before.currency,
    new_amount: value,
    new_currency: iso,
    reason: why.slice(0, 500),
    changed_by: actor.id,
  });
  if (audit.error) dbError(audit.error, 'record the audit entry');
  await addEvent(order.id, order.status, `COD total ${status === 'corrected' ? 'corrected' : 'verified'} by our team: ${iso} ${value}`, actor.id);
  return { order: data, status };
};

/** The amount changes made by staff, newest first. */
export const codAmountHistory = async (orderId) => {
  const { data, error } = await supabaseAdmin.from('cod_amount_audit').select('id, old_amount, old_currency, new_amount, new_currency, reason, changed_by, created_at').eq('order_id', orderId).order('created_at', { ascending: false }).limit(50);
  if (error) return [];
  return data || [];
};

// ───────────── Pay Now: Stripe Checkout ─────────────

/**
 * A Stripe Checkout page for this COD order. The amount is the verified total in the database. An open session for the same
 * amount is reused, so reopening the page or clicking Pay Now twice never makes a second payable session.
 */
export const createCodCheckout = async ({ order, customer }) => {
  if (!isStripeEnabled()) throw new BadRequestError('Card payments are not available yet.');
  const view = codView(order);
  if (order.payment_type !== 'COD') throw new BadRequestError('This is not a cash on delivery order.');
  if (view.payment_status === 'PAID') throw new ConflictError('This order is already paid.');
  if (view.needs_verification || !view.can_pay) throw new ConflictError('Our team is still confirming the total of this order. You can pay once it is confirmed.');
  const { amount, currency } = view;
  const minor = toMinorUnits(amount, currency);

  if (order.cod_stripe_session_id) {
    try {
      const existing = await retrieveCheckoutSession(order.cod_stripe_session_id);
      if (existing.payment_status === 'paid') {
        await settleCodSession(existing);
        throw new ConflictError('This order is already paid.');
      }
      if (existing.status === 'open' && existing.url && existing.amount_total === minor && existing.currency === String(currency).toLowerCase()) {
        return { url: existing.url, sessionId: existing.id, amount, currency, reused: true };
      }
      if (existing.status === 'open') await expireCheckoutSession(existing.id);
    } catch (err) {
      if (err instanceof ConflictError) throw err;
      // a session Stripe no longer knows is simply replaced below
    }
  }

  const base = String(config.urls.clientApp || '').replace(/\/$/, '');
  const { session } = await createCheckoutSession({
    order,
    customer,
    amount,
    currency,
    successUrl: `${base}/pay-return?result=success&order=${order.id}`,
    cancelUrl: `${base}/pay-return?result=cancel&order=${order.id}`,
    // the previous session id is part of the key: two clicks from the same state get the same session, a retry after expiry gets a new one
    // (Stripe returns the first answer for a repeated key, so a key must never be reused for a retry)
    idempotencyKey: `cod:${order.id}:${minor}:${String(currency).toLowerCase()}:${order.cod_stripe_session_id || 'first'}`,
  });
  const { data, error } = await notPaid(
    supabaseAdmin.from('orders').update({ cod_stripe_session_id: session.id, cod_payment_status: 'PENDING', updated_at: new Date().toISOString() }).eq('id', order.id)
  )
    .select('id')
    .maybeSingle();
  if (error) dbError(error, 'save the payment session');
  if (!data) {
    await expireCheckoutSession(session.id);
    throw new ConflictError('This order was just paid.');
  }
  return { url: session.url, sessionId: session.id, amount, currency, reused: false };
};

/**
 * The PaymentIntent the app's Payment Element pays, for this COD order. The amount is the verified total in the database. An open intent for
 * the same amount is reused, so reopening the sheet or clicking twice never creates a second payable intent.
 */
export const startCodPayment = async ({ order, customer }) => {
  if (!isStripeEnabled()) throw new BadRequestError('Card payments are not available yet.');
  const view = codView(order);
  if (order.payment_type !== 'COD') throw new BadRequestError('This is not a cash on delivery order.');
  if (view.payment_status === 'PAID') throw new ConflictError('This order is already paid.');
  if (view.needs_verification || !view.can_pay) throw new ConflictError('Our team is still confirming the total of this order. You can pay once it is confirmed.');
  const { amount, currency } = view;
  const minor = toMinorUnits(amount, currency);
  const currencyLow = String(currency).toLowerCase();

  if (order.cod_stripe_payment_intent) {
    try {
      const existing = await retrievePaymentIntent(order.cod_stripe_payment_intent);
      if (existing.status === 'succeeded') {
        await settleCodIntent(existing);
        throw new ConflictError('This order is already paid.');
      }
      if (['requires_payment_method', 'requires_confirmation', 'requires_action'].includes(existing.status) && existing.amount === minor && existing.currency === currencyLow) {
        return { clientSecret: existing.client_secret, paymentIntentId: existing.id, amount, currency, reference: order.reference, publishableKey: config.stripe.publishableKey, reused: true };
      }
      if (existing.status === 'processing') throw new ConflictError('A payment for this order is still being processed. Use "Check payment again" in a moment.');
      await cancelPaymentIntent(existing.id);
      await ledger(order.id, existing.id, { status: 'canceled' });
    } catch (err) {
      if (err instanceof ConflictError) throw err;
      // an intent Stripe no longer knows is simply replaced below
    }
  }
  // a Stripe Checkout page opened by an older version of the app must not stay payable next to the new intent
  if (order.cod_stripe_session_id) await expireCheckoutSession(order.cod_stripe_session_id);

  const { intent } = await createCodPaymentIntent({
    order,
    customer,
    amount,
    currency,
    // the previous intent id is part of the key: two clicks from the same state get the same intent, a retry after cancel gets a new one
    idempotencyKey: `codpi:${order.id}:${minor}:${currencyLow}:${order.cod_stripe_payment_intent || 'first'}`,
  });
  const { data, error } = await notPaid(
    supabaseAdmin.from('orders').update({ cod_stripe_payment_intent: intent.id, cod_payment_status: 'PENDING', updated_at: new Date().toISOString() }).eq('id', order.id)
  )
    .select('id')
    .maybeSingle();
  if (error) dbError(error, 'save the payment');
  if (!data) {
    await cancelPaymentIntent(intent.id);
    throw new ConflictError('This order was just paid.');
  }
  await ledger(order.id, intent.id, null, { insert: { amount, currency: String(currency).toUpperCase(), status: 'pending', created_by: order.customer_id } });
  emitPaymentUpdate({ ...order, cod_payment_status: 'PENDING' });
  return { clientSecret: intent.client_secret, paymentIntentId: intent.id, amount, currency, reference: order.reference, publishableKey: config.stripe.publishableKey, reused: false };
};

const alertAdmins = (order, body) =>
  notifyAdmins({ type: 'alert', title: `Check payment for ${order.reference}`, body, link: `/admin/orders?ref=${order.reference}`, orderId: order.id });

/** Everyone who needs to know that a COD order was paid: the order's history, the customer, the admins, and every open screen. */
const announcePaid = async (order) => {
  await addEvent(order.id, order.status, `Cash on delivery payment received · ${order.cod_currency} ${round2(order.cod_amount)} (Stripe)`, order.customer_id);
  await notifyUser(order.customer_id, { type: 'invoice', title: `Payment confirmed: ${order.reference}`, body: 'Thank you! Your payment is confirmed. Your parcel can now be received.', link: `/app/orders/${order.id}`, orderId: order.id });
  await notifyAdmins({ type: 'invoice', title: `COD payment received: ${order.reference}`, body: `${order.cod_currency} ${round2(order.cod_amount)} · ${order.customer_name || ''}`.trim(), link: `/admin/orders?ref=${order.reference}`, orderId: order.id });
  emitPaymentUpdate({ ...order, cod_payment_status: 'PAID' });
};

/**
 * Turn a paid Stripe Checkout Session into PAID. Safe to run any number of times and from several places (webhook and the
 * customer's confirm call): only the first caller flips the order. The session must be this order's current session and the
 * money must match the verified total, otherwise nothing is marked paid and an administrator is told.
 */
export const settleCodSession = async (session) => {
  if (session?.metadata?.kind !== 'cod') return { settled: false, reason: 'not a cash on delivery payment' };
  if (session.payment_status !== 'paid') return { settled: false, reason: 'not paid yet' };
  const orderId = session.metadata.order_id || session.client_reference_id;
  const order = orderId ? await reload(orderId) : null;
  if (!order) return { settled: false, reason: 'order not found' };
  if (order.cod_payment_status === 'PAID') return { settled: false, reason: 'already paid' };

  const expectedMinor = order.cod_amount != null && order.cod_currency ? toMinorUnits(order.cod_amount, order.cod_currency) : null;
  const matches =
    order.payment_type === 'COD' &&
    order.cod_stripe_session_id === session.id &&
    expectedMinor != null &&
    session.amount_total === expectedMinor &&
    String(session.currency).toLowerCase() === String(order.cod_currency).toLowerCase();
  if (!matches) {
    // money arrived but it does not match the order as it stands now: a person must look
    await alertAdmins(order, `Stripe received ${String(session.currency).toUpperCase()} ${((session.amount_total ?? 0) / 100).toFixed(2)} (${session.payment_intent || session.id}) but the order expects ${order.cod_currency || '-'} ${order.cod_amount ?? '-'} (${order.payment_type || 'no payment type'}).`);
    return { settled: false, reason: 'amount or order state mismatch' };
  }

  const now = new Date().toISOString();
  const { data: flipped, error } = await notPaid(
    supabaseAdmin
      .from('orders')
      .update({ cod_payment_status: 'PAID', cod_paid_at: now, cod_paid_minor: session.amount_total, cod_stripe_payment_intent: typeof session.payment_intent === 'string' ? session.payment_intent : session.payment_intent?.id ?? null, updated_at: now })
      .eq('id', order.id)
  )
    .select('id')
    .maybeSingle();
  if (error) dbError(error, 'mark the order paid');
  if (!flipped) return { settled: false, reason: 'already paid' };

  await announcePaid(order);
  return { settled: true };
};

/**
 * Turn a succeeded PaymentIntent (the in-app Payment Element) into PAID. Safe to run any number of times and from several places (the
 * webhook and the customer's "check payment" call): only the first caller flips the order. It must be this order's current intent and the
 * money must match the verified total, otherwise nothing is marked paid and an administrator is told.
 */
export const settleCodIntent = async (intent) => {
  if (intent?.metadata?.kind !== 'cod') return { settled: false, reason: 'not a cash on delivery payment' };
  if (intent.status !== 'succeeded') return { settled: false, reason: 'not paid yet' };
  const order = intent.metadata.order_id ? await reload(intent.metadata.order_id) : null;
  if (!order) return { settled: false, reason: 'order not found' };
  if (order.cod_payment_status === 'PAID') return { settled: false, reason: 'already paid' };

  const paidMinor = intent.amount_received ?? intent.amount;
  const expectedMinor = order.cod_amount != null && order.cod_currency ? toMinorUnits(order.cod_amount, order.cod_currency) : null;
  const matches =
    order.payment_type === 'COD' &&
    order.cod_stripe_payment_intent === intent.id &&
    expectedMinor != null &&
    paidMinor === expectedMinor &&
    String(intent.currency).toLowerCase() === String(order.cod_currency).toLowerCase();
  if (!matches) {
    await alertAdmins(order, `Stripe received ${String(intent.currency).toUpperCase()} ${((paidMinor ?? 0) / 100).toFixed(2)} (${intent.id}) but the order expects ${order.cod_currency || '-'} ${order.cod_amount ?? '-'} (${order.payment_type || 'no payment type'}).`);
    return { settled: false, reason: 'amount or order state mismatch' };
  }

  const now = new Date().toISOString();
  const { data: flipped, error } = await notPaid(
    supabaseAdmin.from('orders').update({ cod_payment_status: 'PAID', cod_paid_at: now, cod_paid_minor: paidMinor, cod_stripe_payment_intent: intent.id, updated_at: now }).eq('id', order.id)
  )
    .select('id')
    .maybeSingle();
  if (error) dbError(error, 'mark the order paid');
  if (!flipped) return { settled: false, reason: 'already paid' };
  await ledger(order.id, intent.id, { status: 'succeeded', failure_message: null });
  await announcePaid(order);
  return { settled: true };
};

/**
 * Shopify itself now reports the brand order as fully paid (the customer paid the brand after all): there is nothing to collect, so a COD
 * order that has not been paid here becomes Non-COD, its open payment is closed, and receiving is no longer blocked. A COD order the
 * customer already paid here keeps its payment (that money is on our ledger; it is never silently dropped).
 */
export const markPaidAtShopify = async (order) => {
  if (order.payment_type !== 'COD' || order.cod_payment_status === 'PAID') return { changed: false };
  await retireSession(order);
  const now = new Date().toISOString();
  const { data, error } = await notPaid(
    supabaseAdmin.from('orders').update({ payment_type: 'NON_COD', payment_type_set_at: now, cod_payment_status: null, updated_at: now }).eq('id', order.id).eq('payment_type', 'COD')
  )
    .select('id')
    .maybeSingle();
  if (error) dbError(error, 'update the payment type');
  if (!data) return { changed: false };
  await addEvent(order.id, order.status, 'Shopify reports the brand order as fully paid: nothing to collect, the order is Non-COD', null);
  emitPaymentUpdate({ ...order, payment_type: 'NON_COD', cod_payment_status: null });
  return { changed: true };
};

/** The card was declined or the intent was cancelled: the order stays Unpaid (and blocked) and the customer can try again. */
export const releaseCodIntent = async (intent) => {
  if (intent?.metadata?.kind !== 'cod' || !intent.metadata.order_id) return { released: false };
  const failure = intent.last_payment_error?.message || (intent.status === 'canceled' ? 'The payment was cancelled.' : null);
  await ledger(intent.metadata.order_id, intent.id, { status: intent.status === 'canceled' ? 'canceled' : 'failed', failure_message: failure });
  // a decline leaves the same intent usable (the customer retries with another card): the order only drops back to Unpaid when the intent is cancelled
  if (intent.status !== 'canceled') return { released: false };
  const { data, error } = await notPaid(
    supabaseAdmin.from('orders').update({ cod_payment_status: 'UNPAID', updated_at: new Date().toISOString() }).eq('id', intent.metadata.order_id).eq('cod_stripe_payment_intent', intent.id)
  )
    .select('id, reference, customer_id, partner_id, status')
    .maybeSingle();
  if (error) dbError(error, 'release the payment');
  if (data) emitPaymentUpdate(data);
  return { released: !!data };
};

/** A session that expired, or whose delayed payment failed: the order is Unpaid again and the customer can retry. */
export const releaseCodSession = async (session) => {
  if (session?.metadata?.kind !== 'cod') return { released: false };
  const orderId = session.metadata.order_id || session.client_reference_id;
  if (!orderId) return { released: false };
  const { data, error } = await notPaid(
    supabaseAdmin.from('orders').update({ cod_payment_status: 'UNPAID', updated_at: new Date().toISOString() }).eq('id', orderId).eq('cod_stripe_session_id', session.id)
  )
    .select('id, reference, customer_id')
    .maybeSingle();
  if (error) dbError(error, 'release the payment session');
  if (data) emitTo(rooms.user(data.customer_id), 'order:update', { orderId: data.id });
  return { released: !!data };
};

/**
 * The app asks "was I paid?" after the customer came back from Stripe. The server asks Stripe about THIS order's own session
 * (never a reference sent by the app) and settles only if Stripe says it is paid.
 */
export const confirmCodPayment = async (order) => {
  if (order.cod_payment_status === 'PAID') return { paid: true, status: 'PAID' };
  if (order.cod_stripe_payment_intent && isStripeEnabled()) {
    let intent = null;
    try {
      intent = await retrievePaymentIntent(order.cod_stripe_payment_intent);
    } catch {
      /* Stripe cannot be reached: the order keeps its state and the check can be repeated */
    }
    if (intent) {
      if (intent.status === 'succeeded') {
        await settleCodIntent(intent);
        const fresh = await reload(order.id);
        return { paid: fresh?.cod_payment_status === 'PAID', status: fresh?.cod_payment_status || 'UNPAID' };
      }
      if (intent.status === 'canceled') {
        await releaseCodIntent(intent);
        return { paid: false, status: 'UNPAID' };
      }
      return { paid: false, status: order.cod_payment_status || 'PENDING', stripe_status: intent.status };
    }
    return { paid: false, status: order.cod_payment_status || 'PENDING' };
  }
  if (!order.cod_stripe_session_id || !isStripeEnabled()) return { paid: false, status: order.cod_payment_status || 'UNPAID' };
  let session;
  try {
    session = await retrieveCheckoutSession(order.cod_stripe_session_id);
  } catch {
    return { paid: false, status: order.cod_payment_status || 'UNPAID' };
  }
  if (session.payment_status === 'paid') {
    await settleCodSession(session);
    const fresh = await reload(order.id);
    return { paid: fresh?.cod_payment_status === 'PAID', status: fresh?.cod_payment_status || 'UNPAID' };
  }
  if (session.status === 'expired') {
    await releaseCodSession(session);
    return { paid: false, status: 'UNPAID' };
  }
  return { paid: false, status: order.cod_payment_status || 'PENDING' };
};

/**
 * The COD state of each order of a list page (type, payment status, total), so receiving staff and admins see at a glance whether a
 * COD order was paid. One query for the whole page; if the columns do not exist yet (database update 0041) the rows stay as they are.
 */
export const attachCodSummary = async (rows) => {
  try {
    const ids = [...new Set((rows || []).map((r) => r?.id).filter(Boolean))];
    if (!ids.length) return rows;
    const { data, error } = await supabaseAdmin.from('orders').select('id, payment_type, cod_payment_status, cod_amount, cod_currency, cod_amount_status, external_source, order_source, import_source').in('id', ids);
    if (error || !data) return rows;
    const byId = new Map(data.filter((d) => d.payment_type).map((d) => [d.id, d]));
    for (const r of rows) {
      const d = byId.get(r.id);
      if (!d) continue;
      const v = codView(d);
      r.cod = { payment_type: v.payment_type, payment_status: v.payment_status, payment_state: v.payment_state, source: v.source, amount: v.amount, currency: v.currency, needs_verification: v.needs_verification, locked: v.locked, receive_blocked: v.receive_blocked, receive_block_reason: v.receive_block_reason };
    }
  } catch {
    /* the list still works without it */
  }
  return rows;
};
