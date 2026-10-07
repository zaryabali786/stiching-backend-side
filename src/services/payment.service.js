import { supabaseAdmin } from '../config/supabase.js';
import { round2 } from '../utils/db.js';
import { setOrderStatus } from './order.service.js';
import { notifyUser, notifyPartner, notifyAdmins } from './notification.service.js';
import { invoiceCharge } from './stripe.service.js';

/**
 * Turning a successful Stripe payment into "invoice paid". Two paths can report the same payment
 * (the app confirming right after paying, and Stripe's webhook), so everything here is safe to run twice:
 * only the first caller flips the invoice from `issued` to `paid`.
 */

/**
 * @param {import('stripe').Stripe.PaymentIntent} intent a PaymentIntent with status "succeeded"
 * @returns {Promise<{ settled: boolean, reason?: string }>}
 */
export const settleSucceededIntent = async (intent) => {
  const invoiceId = intent.metadata?.invoice_id;
  if (!invoiceId) return { settled: false, reason: 'not one of our payments' };

  const { data: invoice } = await supabaseAdmin.from('invoices').select('*').eq('id', invoiceId).maybeSingle();
  if (!invoice) return { settled: false, reason: 'invoice not found' };
  const { data: order } = await supabaseAdmin.from('orders').select('*').eq('id', invoice.order_id).maybeSingle();
  if (!order) return { settled: false, reason: 'order not found' };

  // make sure the payment row exists and says "succeeded" (the unique index keeps it to one row per intent)
  const paidMinor = intent.amount_received ?? intent.amount;
  const base = { invoice_id: invoice.id, order_id: order.id, amount_pkr: invoice.total_pkr, amount_foreign: invoice.total_foreign, currency: invoice.currency, method: 'card', provider_ref: intent.id, created_by: order.customer_id };
  const { data: existingRow } = await supabaseAdmin.from('payments').select('id, status').eq('provider_ref', intent.id).maybeSingle();
  if (existingRow) {
    if (existingRow.status !== 'succeeded') await supabaseAdmin.from('payments').update({ status: 'succeeded' }).eq('id', existingRow.id);
  } else {
    const { error } = await supabaseAdmin.from('payments').insert({ ...base, status: 'succeeded' });
    if (error && error.code !== '23505') console.warn('[Payment] could not record the payment:', error.message);
  }

  if (invoice.status === 'paid') return { settled: false, reason: 'already paid' };

  const expected = invoiceCharge(invoice);
  if (invoice.status !== 'issued' || paidMinor < expected.minor || intent.currency !== expected.currency.toLowerCase()) {
    // money arrived but it does not match an open invoice (changed or voided meanwhile): a person must look
    await notifyAdmins({
      type: 'alert',
      title: `Check payment for ${order.reference}`,
      body: `Stripe received ${String(intent.currency).toUpperCase()} ${(paidMinor / 100).toFixed(2)} (${intent.id}) but invoice ${invoice.number} is ${invoice.status} / expects ${expected.currency} ${expected.amount}.`,
      link: `/admin/orders?ref=${order.reference}`,
      orderId: order.id,
    });
    return { settled: false, reason: 'amount or invoice state mismatch' };
  }

  // only the first caller gets a row back here
  const now = new Date().toISOString();
  const { data: flipped } = await supabaseAdmin
    .from('invoices')
    .update({ status: 'paid', paid_at: now, updated_at: now })
    .eq('id', invoice.id)
    .eq('status', 'issued')
    .select('id');
  if (!flipped?.length) return { settled: false, reason: 'already paid' };

  await setOrderStatus(order.id, 'paid', {
    note: `Card payment received · ${expected.currency} ${round2(expected.amount)} (invoice ${invoice.number})`,
    actorId: order.customer_id,
    extra: { paid_at: now },
  });
  await notifyUser(order.customer_id, { type: 'invoice', title: `Payment confirmed: ${order.reference}`, body: `Thank you! Invoice ${invoice.number} is paid. We will dispatch your order soon.`, link: `/app/orders/${order.id}`, orderId: order.id });
  await notifyPartner({ type: 'invoice', title: `Paid: ${order.reference}`, body: 'Choose the dispatch route in Warehouse.', link: '/partner/warehouse?tab=paid', orderId: order.id }, null, { module: 'warehouse' });
  await notifyAdmins({ type: 'invoice', title: `Payment received: ${order.reference}`, body: `${expected.currency} ${round2(expected.amount)} · ${order.customer_name}`, link: '/admin/invoices?tab=paid', orderId: order.id });
  return { settled: true };
};

/** A card was declined or authentication failed: mark the attempt and tell the customer. */
export const recordFailedIntent = async (intent) => {
  const orderId = intent.metadata?.order_id;
  if (!orderId) return;
  await supabaseAdmin.from('payments').update({ status: 'failed' }).eq('provider_ref', intent.id).eq('status', 'pending');
  const { data: order } = await supabaseAdmin.from('orders').select('id, reference, customer_id').eq('id', orderId).maybeSingle();
  if (!order) return;
  const reason = intent.last_payment_error?.message || 'The card was not accepted.';
  await notifyUser(order.customer_id, {
    type: 'alert',
    title: `Payment failed: ${order.reference}`,
    body: `${reason} Please try again or use another card.`,
    link: `/app/orders/${order.id}`,
    orderId: order.id,
  });
};

