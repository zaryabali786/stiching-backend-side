import { supabaseAdmin } from '../config/supabase.js';
import { config } from '../config/env.js';
import { catchAsync, ApiResponse, BadRequestError, NotFoundError } from '../utils/error.helper.js';
import { unwrap } from '../utils/db.js';
import { constructWebhookEvent, createOrReusePaymentIntent, isStripeEnabled, retrievePaymentIntent } from '../services/stripe.service.js';
import { recordFailedIntent, settleSucceededIntent } from '../services/payment.service.js';

const one = (v) => (Array.isArray(v) ? v[0] ?? null : v ?? null);

/** The customer's own order with its invoice; 404 for anyone else's. */
const loadOwnOrderWithInvoice = async (req) => {
  const { data, error } = await supabaseAdmin
    .from('orders')
    .select('*, invoice:invoices!invoices_order_id_fkey(*)')
    .eq('id', req.params.id)
    .eq('customer_id', req.userId)
    .maybeSingle();
  if (error) unwrap({ error }, 'Could not load the order');
  if (!data) throw new NotFoundError('Order not found');
  return { order: data, invoice: one(data.invoice) };
};

/**
 * POST /api/client/orders/:id/payment-intent
 * Starts (or resumes) the card payment for the issued invoice.
 * -> { clientSecret, paymentIntentId, amount, currency, invoiceNumber, reference, publishableKey }
 */
export const createPaymentIntent = catchAsync(async (req, res) => {
  if (!isStripeEnabled()) throw new BadRequestError('Card payments are not available yet.');
  const { order, invoice } = await loadOwnOrderWithInvoice(req);
  if (!invoice || invoice.status !== 'issued') throw new BadRequestError('There is no unpaid invoice for this order.');
  if (!['awaiting_payment', 'invoice_issued'].includes(order.status)) throw new BadRequestError('This order is not awaiting payment.');

  const { intent, charge, reused } = await createOrReusePaymentIntent({ order, invoice, customer: req.profile });
  return ApiResponse.success(
    res,
    {
      clientSecret: intent.client_secret,
      paymentIntentId: intent.id,
      amount: charge.amount,
      currency: charge.currency,
      invoiceNumber: invoice.number,
      reference: order.reference,
      publishableKey: config.stripe.publishableKey,
    },
    reused ? 'Payment resumed.' : 'Payment started.'
  );
});

/**
 * POST /api/client/orders/:id/payment-intent/confirm  { payment_intent_id }
 * Called by the app right after Stripe confirms the card. The server asks Stripe itself (it never trusts the app)
 * and marks the invoice paid when Stripe says the money is in. The webhook does the same and wins if it is first.
 * -> { paid: boolean, status }
 */
export const confirmPayment = catchAsync(async (req, res) => {
  if (!isStripeEnabled()) throw new BadRequestError('Card payments are not available yet.');
  const { order } = await loadOwnOrderWithInvoice(req);
  const id = String(req.body?.payment_intent_id || '');
  if (!/^pi_[A-Za-z0-9]+$/.test(id)) throw new BadRequestError('Missing payment reference.');

  let intent;
  try {
    intent = await retrievePaymentIntent(id);
  } catch {
    throw new NotFoundError('Payment not found');
  }
  // the intent must belong to this order and this customer
  if (intent.metadata?.order_id !== order.id || intent.metadata?.customer_id !== req.userId) throw new NotFoundError('Payment not found');

  if (intent.status === 'succeeded') {
    const result = await settleSucceededIntent(intent);
    return ApiResponse.success(res, { paid: true, status: intent.status, ...result }, 'Payment received.');
  }
  if (intent.status === 'requires_payment_method' && intent.last_payment_error) await recordFailedIntent(intent);
  return ApiResponse.success(res, { paid: false, status: intent.status, error: intent.last_payment_error?.message || null }, 'Payment not completed yet.');
});

/**
 * POST /api/webhooks/stripe — called by Stripe, authenticated by its signature (not a user token).
 * Mounted with the RAW body (see app.js): the signature is computed over the exact bytes Stripe sent.
 */
export const stripeWebhook = async (req, res) => {
  let event;
  try {
    event = constructWebhookEvent(req.body, req.headers['stripe-signature']);
  } catch (err) {
    // 503 when not configured, 400 for a bad signature: Stripe retries on any non-2xx
    const status = err.statusCode === 503 ? 503 : 400;
    return res.status(status).json({ received: false, error: status === 503 ? err.message : 'Invalid signature' });
  }

  try {
    if (event.type === 'payment_intent.succeeded') await settleSucceededIntent(event.data.object);
    else if (event.type === 'payment_intent.payment_failed') await recordFailedIntent(event.data.object);
    // other event types are acknowledged and ignored
  } catch (err) {
    console.error('[Stripe webhook] handler failed:', event.type, err.message);
    return res.status(500).json({ received: false }); // Stripe will retry
  }
  return res.json({ received: true });
};
