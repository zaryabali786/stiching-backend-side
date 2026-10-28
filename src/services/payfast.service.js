import crypto from 'node:crypto';
import { config } from '../config/env.js';
import { supabaseAdmin } from '../config/supabase.js';
import { AppError, BadRequestError } from '../utils/error.helper.js';

/**
 * PayFast (Pakistan, PKR). Orders delivered inside Pakistan are paid here, orders delivered abroad with Stripe.
 *
 * Flow: the server asks PayFast for a one-time access token for THIS basket and amount, hands the browser a signed form that
 * posts to PayFast's page, and PayFast later reports the result twice: to the customer's browser (SUCCESS_URL / FAILURE_URL)
 * and server-to-server (CHECKOUT_URL, the IPN). The amount we expect lives in our own table (payfast_payments); a payment is
 * only ever applied after the callback's signature, result code AND amount have been checked against it.
 */

const cfg = () => config.payfast;

export const isPayfastEnabled = () => !!(cfg().merchantId && cfg().securedKey);

export const isPakistan = (country) => /^(pk|pakistan)$/i.test(String(country ?? '').trim());

/** 'payfast' for a PKR payment delivered inside Pakistan (when PayFast is set up), otherwise 'stripe'. */
export const gatewayFor = ({ order, currency }) =>
  isPayfastEnabled() && isPakistan(order?.destination_country) && String(currency || '').toUpperCase() === 'PKR' ? 'payfast' : 'stripe';

const money = (n) => Number(n).toFixed(2);

const SUCCESS_CODES = new Set(['00', '000']);
export const isSuccessCode = (code) => SUCCESS_CODES.has(String(code ?? '').trim());

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

/**
 * PayFast signs every callback: validation_hash = SHA-256 of  basket_id|secured_key|merchant_id|err_code.
 * Only PayFast (and we) know the secured key, so a valid hash proves the basket and result code are genuine.
 * It does NOT cover the amount: the amount is checked separately against what we stored.
 */
export const validationHash = ({ basketId, errCode }) => sha256(`${basketId}|${cfg().securedKey}|${cfg().merchantId}|${errCode}`);

export const isValidCallback = (params) => {
  const got = String(params?.validation_hash ?? '').trim().toLowerCase();
  if (!got || !params?.basket_id) return false;
  const want = validationHash({ basketId: String(params.basket_id), errCode: String(params.err_code ?? '') });
  const a = Buffer.from(got);
  const b = Buffer.from(want);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};

/** The one-time token for this basket and amount (must be requested from the server, never from the browser). */
const getAccessToken = async ({ basketId, amount }) => {
  const body = new URLSearchParams({
    MERCHANT_ID: cfg().merchantId,
    SECURED_KEY: cfg().securedKey,
    BASKET_ID: basketId,
    TXNAMT: money(amount),
    CURRENCY_CODE: 'PKR',
  });
  let res;
  try {
    res = await fetch(`${cfg().baseUrl}/GetAccessToken`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
      signal: AbortSignal.timeout(cfg().timeoutMs),
    });
  } catch (err) {
    console.error('[PayFast] token request failed:', err.message);
    throw new AppError('PayFast could not be reached. Please try again in a moment.', 502);
  }
  const data = await res.json().catch(() => null);
  const token = data?.ACCESS_TOKEN;
  if (!res.ok || !token) {
    console.error('[PayFast] no access token:', res.status, JSON.stringify(data)?.slice(0, 300));
    throw new AppError('PayFast could not start this payment. Please try again later.', 502);
  }
  return String(token);
};

const orderDate = (d = new Date()) => d.toISOString().slice(0, 19).replace('T', ' ');

const newBasketId = (kind, order) => {
  const ref = String(order.reference || order.id).replace(/[^A-Za-z0-9]/g, '').slice(0, 16);
  return `${kind === 'cod' ? 'COD' : 'INV'}-${ref}-${crypto.randomBytes(5).toString('hex')}`.toUpperCase();
};

/**
 * Start a PayFast payment. `amount` is the PKR total from OUR database. Returns the signed form the browser posts to PayFast.
 * Earlier unfinished attempts for the same target stay in the table: a late success of an old attempt is still checked against
 * the order as it stands (and refused when the order was paid or changed meanwhile).
 */
export const startPayfastCheckout = async ({ kind, order, invoice = null, amount, customer }) => {
  if (!isPayfastEnabled()) throw new BadRequestError('PayFast payments are not available yet.');
  if (!cfg().apiUrl) throw new AppError('PayFast is not fully set up (PAYFAST_API_URL is missing).', 503);
  const value = Math.round(Number(amount) * 100) / 100;
  if (!(value > 0)) throw new BadRequestError('This order has no amount to pay.');

  const basketId = newBasketId(kind, order);
  const token = await getAccessToken({ basketId, amount: value });

  const { error } = await supabaseAdmin.from('payfast_payments').insert({
    basket_id: basketId,
    kind,
    order_id: order.id,
    invoice_id: invoice?.id ?? null,
    amount: value,
    currency: 'PKR',
    status: 'pending',
    created_by: order.customer_id,
  });
  if (error) {
    if (/payfast_payments/i.test(error.message || '')) throw new AppError('PayFast needs the database update 0052 (npm run migrate).', 503);
    throw new AppError('The payment could not be started.', 500);
  }

  const api = cfg().apiUrl;
  const phone = String(customer?.phone || '').replace(/[^\d+]/g, '');
  const fields = {
    CURRENCY_CODE: 'PKR',
    MERCHANT_ID: cfg().merchantId,
    MERCHANT_NAME: cfg().merchantName,
    TOKEN: token,
    BASKET_ID: basketId,
    TXNAMT: money(value),
    ORDER_DATE: orderDate(),
    SUCCESS_URL: `${api}/api/payfast/return?result=success&order=${order.id}`,
    FAILURE_URL: `${api}/api/payfast/return?result=failure&order=${order.id}`,
    CHECKOUT_URL: `${api}/api/webhooks/payfast`,
    CUSTOMER_EMAIL_ADDRESS: customer?.email || '',
    CUSTOMER_MOBILE_NO: phone,
    SIGNATURE: crypto.randomBytes(8).toString('hex'),
    VERSION: 'STITCHSHIP-1.0',
    TXNDESC: kind === 'cod' ? `Order ${order.reference || ''}` : `Invoice ${invoice?.number || ''} ${order.reference || ''}`.trim(),
    PROCCODE: '00',
    TRAN_TYPE: 'ECOMM_PURCHASE',
    ...(cfg().storeId ? { STORE_ID: cfg().storeId } : {}),
  };
  return { basketId, amount: value, currency: 'PKR', action: `${cfg().baseUrl}/PostTransaction`, method: 'POST', fields };
};

/** The latest attempt of an order (for the "check payment" answer). */
export const latestPayfastPayment = async (orderId, kind) => {
  const { data } = await supabaseAdmin
    .from('payfast_payments')
    .select('*')
    .eq('order_id', orderId)
    .eq('kind', kind)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  return data ?? null;
};
