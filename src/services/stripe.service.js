import Stripe from 'stripe';
import { config } from '../config/env.js';
import { supabaseAdmin } from '../config/supabase.js';
import { AppError, BadRequestError } from '../utils/error.helper.js';

/**
 * Stripe card payments for issued invoices (PaymentIntents + the Payment Element in the apps).
 * The browser / native app only ever sees the publishable key and a one-time client secret.
 */

let client = null;

export const isStripeEnabled = () => !!config.stripe.secretKey;

export const stripe = () => {
  if (!isStripeEnabled()) throw new AppError('Card payments are not set up yet.', 503);
  if (!client) client = new Stripe(config.stripe.secretKey, { maxNetworkRetries: 2, appInfo: { name: 'V360 Stitching' } });
  return client;
};

// Stripe wants amounts in the currency's smallest unit
const ZERO_DECIMAL = new Set(['BIF', 'CLP', 'DJF', 'GNF', 'JPY', 'KMF', 'KRW', 'MGA', 'PYG', 'RWF', 'UGX', 'VND', 'VUV', 'XAF', 'XOF', 'XPF']);
const THREE_DECIMAL = new Set(['BHD', 'JOD', 'KWD', 'OMR', 'TND']);

export const toMinorUnits = (amount, currency) => {
  const c = String(currency).toUpperCase();
  const n = Number(amount);
  if (ZERO_DECIMAL.has(c)) return Math.round(n);
  if (THREE_DECIMAL.has(c)) return Math.round((n * 1000) / 10) * 10; // Stripe needs a multiple of 10 here
  return Math.round(n * 100);
};

/** What the customer pays: the invoice in the customer's currency (PKR invoices use the PKR total). */
export const invoiceCharge = (invoice) => {
  const currency = String(invoice.currency || 'PKR').toUpperCase();
  const amount = currency === 'PKR' ? Number(invoice.total_pkr) : Number(invoice.total_foreign);
  return { currency, amount, minor: toMinorUnits(amount, currency) };
};

const OPEN = new Set(['requires_payment_method', 'requires_confirmation', 'requires_action']);

/**
 * A PaymentIntent for this invoice. Reuses the customer's still-open one when nothing changed,
 * so reopening the pay sheet never creates stray intents.
 */
export const createOrReusePaymentIntent = async ({ order, invoice, customer }) => {
  const charge = invoiceCharge(invoice);
  if (!(charge.minor > 0)) throw new BadRequestError('This invoice has no amount to pay.');
  const api = stripe();

  const { data: pending } = await supabaseAdmin
    .from('payments')
    .select('id, provider_ref')
    .eq('invoice_id', invoice.id)
    .eq('status', 'pending')
    .like('provider_ref', 'pi\\_%')
    .order('created_at', { ascending: false })
    .limit(5);

  for (const row of pending || []) {
    try {
      const existing = await api.paymentIntents.retrieve(row.provider_ref);
      if (OPEN.has(existing.status) && existing.amount === charge.minor && existing.currency === charge.currency.toLowerCase()) {
        return { intent: existing, charge, reused: true };
      }
      // outdated (invoice changed) or finished: retire it
      if (existing.status !== 'succeeded' && existing.status !== 'canceled') await api.paymentIntents.cancel(existing.id).catch(() => {});
      if (existing.status !== 'succeeded') await supabaseAdmin.from('payments').update({ status: 'failed' }).eq('id', row.id).eq('status', 'pending');
    } catch {
      await supabaseAdmin.from('payments').update({ status: 'failed' }).eq('id', row.id).eq('status', 'pending');
    }
  }

  let intent;
  try {
    intent = await api.paymentIntents.create({
      amount: charge.minor,
      currency: charge.currency.toLowerCase(),
      // payment methods come from the Stripe Dashboard (Settings > Payment methods); nothing that redirects away is offered,
      // so it behaves the same in the browser and in the native app
      automatic_payment_methods: { enabled: true, allow_redirects: 'never' },
      description: `Invoice ${invoice.number} · ${order.reference}`,
      receipt_email: customer.email || undefined,
      metadata: { order_id: order.id, invoice_id: invoice.id, order_reference: order.reference, invoice_number: invoice.number || '', customer_id: order.customer_id },
    });
  } catch (err) {
    // e.g. a currency Stripe cannot charge, or an amount below Stripe's minimum
    throw new BadRequestError(err?.raw?.message || err.message || 'The payment could not be started.');
  }

  const { error } = await supabaseAdmin.from('payments').insert({
    invoice_id: invoice.id,
    order_id: order.id,
    amount_pkr: invoice.total_pkr,
    amount_foreign: invoice.total_foreign,
    currency: invoice.currency,
    method: 'card',
    provider_ref: intent.id,
    status: 'pending',
    created_by: order.customer_id,
  });
  if (error) console.warn('[Stripe] could not record the pending payment:', error.message);
  return { intent, charge, reused: false };
};

export const retrievePaymentIntent = (id) => stripe().paymentIntents.retrieve(id);

/** Verify a webhook delivery. `rawBody` must be the exact bytes Stripe sent. */
export const constructWebhookEvent = (rawBody, signature) => {
  if (!config.stripe.webhookSecret) throw new AppError('Stripe webhook is not configured (STRIPE_WEBHOOK_SECRET).', 503);
  return stripe().webhooks.constructEvent(rawBody, signature, config.stripe.webhookSecret);
};
