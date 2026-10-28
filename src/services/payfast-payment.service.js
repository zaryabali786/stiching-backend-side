import { supabaseAdmin } from '../config/supabase.js';
import { config } from '../config/env.js';
import { notifyAdmins, notifyUser } from './notification.service.js';
import { isPayfastEnabled, isSuccessCode, isValidCallback } from './payfast.service.js';
import { releaseCodPayfast, settleCodPayfast } from './cod-payment.service.js';
import { settleInvoicePayfast } from './payment.service.js';

/**
 * What PayFast tells us about a payment (the server-to-server IPN, and the customer's browser coming back) is checked here
 * before anything is marked paid. A payment is applied only when ALL of these hold:
 *   1. the basket id is one we created, and its attempt is still pending (so a replay changes nothing)
 *   2. the validation hash is PayFast's (proves basket id + result code; needs the secured key)
 *   3. the result code says success
 *   4. the amount PayFast reports equals the amount we stored for that basket, to the paisa:
 *      less OR more than expected is refused and an administrator is told (the customer is not marked paid)
 *   5. the order / invoice is still unpaid and still expects that amount (checked again in the cod / invoice settle)
 * The hash does not cover the amount, and the customer's browser can edit its own redirect URL, so by default only the
 * server-to-server IPN can settle; the browser redirect just reports (see PAYFAST_TRUST_RETURN for local development).
 *
 * @returns {Promise<{ state: 'paid'|'waiting'|'failed'|'mismatch'|'invalid'|'duplicate', orderId?: string, reason?: string }>}
 */
export const processPayfastCallback = async (params, source) => {
  const basketId = String(params?.basket_id ?? '').trim();
  if (!isPayfastEnabled() || !basketId) return { state: 'invalid', reason: 'not a PayFast callback' };

  const { data: row } = await supabaseAdmin.from('payfast_payments').select('*').eq('basket_id', basketId).maybeSingle();
  if (!row) return { state: 'invalid', reason: 'unknown basket' };
  const orderId = row.order_id;

  // a forged or damaged callback changes nothing (and cannot be used to fail somebody else's pending payment)
  if (!isValidCallback(params)) {
    console.warn('[PayFast] callback with a wrong signature ignored:', basketId, source);
    return { state: 'invalid', orderId, reason: 'bad signature' };
  }
  if (row.status === 'paid') return { state: 'paid', orderId };
  if (row.status !== 'pending') return { state: row.status === 'failed' ? 'failed' : row.status === 'amount_mismatch' ? 'mismatch' : 'duplicate', orderId };

  const errCode = String(params.err_code ?? '').trim();
  const transactionId = String(params.transaction_id ?? '').trim() || null;
  const raw = { source, ...Object.fromEntries(Object.entries(params).filter(([k]) => k !== 'validation_hash').map(([k, v]) => [k, String(v).slice(0, 200)])) };

  if (!isSuccessCode(errCode)) {
    const { data: flipped } = await supabaseAdmin
      .from('payfast_payments')
      .update({ status: 'failed', err_code: errCode, err_msg: String(params.err_msg ?? '').slice(0, 300) || null, transaction_id: transactionId, raw, updated_at: new Date().toISOString() })
      .eq('id', row.id)
      .eq('status', 'pending')
      .select('id')
      .maybeSingle();
    if (flipped) {
      if (row.kind === 'cod') await releaseCodPayfast(orderId);
      const { data: order } = await supabaseAdmin.from('orders').select('id, reference, customer_id').eq('id', orderId).maybeSingle();
      if (order) {
        await notifyUser(order.customer_id, { type: 'alert', title: `Payment failed: ${order.reference}`, body: `${String(params.err_msg || 'The payment was not completed.')} No money was taken for this attempt. Please try again.`, link: `/app/orders/${order.id}`, orderId: order.id }).catch(() => undefined);
      }
    }
    return { state: 'failed', orderId, reason: String(params.err_msg ?? '') };
  }

  // success reported: only the server-to-server call (or the dev switch) may settle, the browser redirect is not enough
  if (source !== 'ipn' && !config.payfast.trustReturn) return { state: 'waiting', orderId };

  // the amount PayFast says it took must be exactly what we asked for; a missing amount cannot be verified
  const paidAmount = Number(String(params.transaction_amount ?? '').replace(/,/g, ''));
  const expected = Number(row.amount);
  if (!Number.isFinite(paidAmount) || Math.abs(paidAmount - expected) >= 0.005) {
    const { data: flipped } = await supabaseAdmin
      .from('payfast_payments')
      .update({ status: 'amount_mismatch', err_code: errCode, transaction_id: transactionId, paid_amount: Number.isFinite(paidAmount) ? paidAmount : null, raw, updated_at: new Date().toISOString() })
      .eq('id', row.id)
      .eq('status', 'pending')
      .select('id')
      .maybeSingle();
    if (flipped) {
      if (row.kind === 'cod') await releaseCodPayfast(orderId);
      const { data: order } = await supabaseAdmin.from('orders').select('id, reference, customer_id').eq('id', orderId).maybeSingle();
      if (order) {
        await notifyAdmins({ type: 'alert', title: `Check payment for ${order.reference}`, body: `PayFast reports PKR ${Number.isFinite(paidAmount) ? paidAmount.toFixed(2) : '?'} (${transactionId || basketId}) but PKR ${expected.toFixed(2)} was expected. The order was NOT marked paid: refund or contact the customer.`, link: `/admin/orders?ref=${order.reference}`, orderId: order.id });
        await notifyUser(order.customer_id, { type: 'alert', title: `Payment needs review: ${order.reference}`, body: 'The amount received did not match the amount due, so the order was not marked paid. Our team will contact you.', link: `/app/orders/${order.id}`, orderId: order.id }).catch(() => undefined);
      }
    }
    return { state: 'mismatch', orderId };
  }

  // claim the attempt first: only one caller (IPN retry, browser, dev switch) can move it from pending to paid
  const now = new Date().toISOString();
  const { data: claimed, error: claimError } = await supabaseAdmin
    .from('payfast_payments')
    .update({ status: 'paid', err_code: errCode, transaction_id: transactionId, paid_amount: paidAmount, verified_by: source, raw, paid_at: now, updated_at: now })
    .eq('id', row.id)
    .eq('status', 'pending')
    .select('id')
    .maybeSingle();
  if (claimError) {
    // the same PayFast transaction id already settled another basket: a replay, never applied twice
    console.warn('[PayFast] could not claim the payment:', claimError.message);
    return { state: 'invalid', orderId, reason: 'transaction already used' };
  }
  if (!claimed) return { state: 'paid', orderId }; // someone else claimed it a moment ago

  const result = row.kind === 'cod' ? await settleCodPayfast(row, transactionId) : await settleInvoicePayfast(row, transactionId);
  if (!result.settled && result.reason !== 'already paid') {
    // verified money that does not fit the order any more (changed or voided meanwhile): kept on record, an admin was told
    await supabaseAdmin.from('payfast_payments').update({ status: 'duplicate', updated_at: new Date().toISOString() }).eq('id', row.id);
    return { state: 'mismatch', orderId, reason: result.reason };
  }
  if (!result.settled) {
    // the order was already paid (another attempt or Stripe): this one is money taken twice
    await supabaseAdmin.from('payfast_payments').update({ status: 'duplicate', updated_at: new Date().toISOString() }).eq('id', row.id);
    await notifyAdmins({ type: 'alert', title: 'Duplicate PayFast payment', body: `PayFast took PKR ${expected.toFixed(2)} (${transactionId || basketId}) for an order that was already paid. Please refund it.`, link: '/admin/orders', orderId });
    return { state: 'duplicate', orderId };
  }
  return { state: 'paid', orderId };
};
