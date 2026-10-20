import { supabaseAdmin } from '../config/supabase.js';
import { catchAsync, ApiResponse, NotFoundError } from '../utils/error.helper.js';
import { getOrderOr404 } from '../services/order.service.js';
import { codAmountHistory, codView, confirmCodPayment, createCodCheckout, setPaymentType, verifyCodAmount } from '../services/cod-payment.service.js';

/** The customer's own order; 404 for anyone else's. */
const loadOwnOrder = async (req) => {
  const { data, error } = await supabaseAdmin.from('orders').select('*').eq('id', req.params.id).eq('customer_id', req.userId).maybeSingle();
  if (error) throw error;
  if (!data) throw new NotFoundError('Order not found');
  return data;
};

const staffActor = (req) => ({ id: req.userId, role: 'staff' });

// ───────────── customer ─────────────

/**
 * POST /api/client/orders/:id/payment-type  body: { type: 'COD' | 'NON_COD' }
 * The customer chooses on the email order. NON_COD changes nothing; COD reads the total from the original email.
 */
export const setClientPaymentType = catchAsync(async (req, res) => {
  const order = await loadOwnOrder(req);
  const result = await setPaymentType({ order, type: String(req.body?.type || '').toUpperCase(), actor: { id: req.userId, role: 'customer' } });
  return ApiResponse.success(res, { cod: codView(result.order) }, result.order.payment_type === 'COD' ? 'Marked as cash on delivery.' : 'Marked as Non-COD.');
});

/**
 * POST /api/client/orders/:id/cod/checkout
 * Pay Now: a Stripe Checkout page for the verified total. The amount comes from the database, never from the app.
 * -> { url, sessionId, amount, currency }
 */
export const startCodCheckout = catchAsync(async (req, res) => {
  const order = await loadOwnOrder(req);
  const result = await createCodCheckout({ order, customer: req.profile });
  return ApiResponse.success(res, result, result.reused ? 'Payment resumed.' : 'Payment started.');
});

/**
 * POST /api/client/orders/:id/cod/confirm
 * After the customer is back from Stripe: the server asks Stripe about this order's own session and settles it only if Stripe
 * says it is paid. Returning to a success page proves nothing by itself.
 */
export const confirmClientCodPayment = catchAsync(async (req, res) => {
  const order = await loadOwnOrder(req);
  const result = await confirmCodPayment(order);
  const fresh = await getOrderOr404(order.id);
  return ApiResponse.success(res, { ...result, cod: codView(fresh) }, result.paid ? 'Payment received.' : 'Payment not completed yet.');
});

// ───────────── authorised staff (admin, and partner staff for their own orders) ─────────────

const idOf = (req) => req.params.id ?? req.params.orderId;

/** GET .../orders/:id/cod — type, total, currency, status and the history of manual amount changes. */
export const getOrderCod = catchAsync(async (req, res) => {
  const order = await getOrderOr404(idOf(req));
  return ApiResponse.success(res, { cod: codView(order), history: await codAmountHistory(order.id) });
});

/** PUT .../orders/:id/payment-type  body: { type } — staff may also move an order away from COD (for example a misread email). */
export const setStaffPaymentType = catchAsync(async (req, res) => {
  const order = await getOrderOr404(idOf(req));
  const result = await setPaymentType({ order, type: String(req.body?.type || '').toUpperCase(), actor: staffActor(req) });
  return ApiResponse.success(res, { cod: codView(result.order), history: await codAmountHistory(order.id) }, 'Payment type saved.');
});

/** PUT .../orders/:id/cod-amount  body: { amount, currency, reason } — the verified total (needed when the email gave none or an unclear one). Audited. */
export const setStaffCodAmount = catchAsync(async (req, res) => {
  const order = await getOrderOr404(idOf(req));
  const result = await verifyCodAmount({ order, amount: req.body?.amount, currency: req.body?.currency, reason: req.body?.reason, actor: staffActor(req) });
  return ApiResponse.success(res, { cod: codView(result.order), history: await codAmountHistory(order.id) }, result.status === 'corrected' ? 'Amount corrected.' : 'Amount verified.');
});
