import { config } from '../config/env.js';
import { processPayfastCallback } from '../services/payfast-payment.service.js';

/** PayFast sends its fields in the query string or as a form; both are read, and the body wins. */
const paramsOf = (req) => ({ ...(req.query || {}), ...(req.body && typeof req.body === 'object' ? req.body : {}) });

/**
 * GET|POST /api/webhooks/payfast — PayFast's server-to-server notification (CHECKOUT_URL). Authenticated by PayFast's
 * validation hash. Answers 200 once handled (also for payments we refuse, so PayFast does not retry them forever);
 * a failure of ours answers 500 so PayFast retries.
 */
export const payfastIpn = async (req, res) => {
  try {
    const result = await processPayfastCallback(paramsOf(req), 'ipn');
    return res.status(200).json({ received: true, state: result.state });
  } catch (err) {
    console.error('[PayFast IPN] handler failed:', err.message);
    return res.status(500).json({ received: false });
  }
};

/**
 * GET|POST /api/payfast/return — where PayFast sends the customer after paying (SUCCESS_URL / FAILURE_URL).
 * Nothing is trusted from here: the callback is verified, and the customer is sent on to the app, which asks the server
 * for the order's real state.
 */
export const payfastReturn = async (req, res) => {
  const params = paramsOf(req);
  const base = String(config.urls.clientApp || '').replace(/\/$/, '');
  let result = { state: 'invalid' };
  try {
    result = await processPayfastCallback(params, 'return');
  } catch (err) {
    console.error('[PayFast return] handler failed:', err.message);
  }
  const orderId = /^[0-9a-f-]{36}$/i.test(String(req.query.order || '')) ? String(req.query.order) : result.orderId || '';
  // 'paid' and 'waiting' (the IPN settles it) both read as "thank you"; the app shows the real state after it asks the server
  const outcome = result.state === 'paid' ? 'success' : result.state === 'waiting' ? 'pending' : result.state === 'failed' || req.query.result === 'failure' ? 'cancel' : 'review';
  return res.redirect(303, `${base}/pay-return?result=${outcome}&provider=payfast${orderId ? `&order=${orderId}` : ''}`);
};
