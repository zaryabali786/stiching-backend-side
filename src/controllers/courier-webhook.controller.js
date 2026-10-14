import crypto from 'node:crypto';
import { config } from '../config/env.js';
import { catchAsync, ApiResponse } from '../utils/error.helper.js';
import { findShipmentByCn, normalizeCourierStatus, normalizeDispatchStatus, recordTracking } from '../services/return-shipment.service.js';
import { findDispatchByCn, recordDispatchTracking } from '../services/dispatch-shipment.service.js';

const sameSecret = (given, expected) => {
  const a = Buffer.from(String(given ?? ''));
  const b = Buffer.from(String(expected));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};

/**
 * POST /api/webhooks/courier   header x-webhook-secret: COURIER_WEBHOOK_SECRET
 *   body: { cn, courier?, status, event_id?, occurred_at?, note? }
 * A courier (or a bridge in front of it) reports the tracking of a return parcel. Only "in transit" and "delivered" events are
 * acted on; the same event_id twice, or a second "delivered", is acknowledged and changes nothing.
 */
export const courierTrackingWebhook = catchAsync(async (req, res) => {
  if (!config.courier.webhookSecret) return res.status(503).json({ success: false, statusCode: 503, message: 'Courier tracking is not connected: COURIER_WEBHOOK_SECRET is not set.' });
  if (!sameSecret(req.get('x-webhook-secret'), config.courier.webhookSecret)) return res.status(401).json({ success: false, statusCode: 401, message: 'Invalid webhook secret.' });
  const body = req.body || {};
  const at = body.occurred_at && !Number.isNaN(Date.parse(body.occurred_at)) ? new Date(body.occurred_at).toISOString() : undefined;
  const eventId = body.event_id ? String(body.event_id).slice(0, 80) : undefined;

  // a customer's return parcel (in transit / delivered) or a parcel we dispatched (also a failed attempt / returning to us)
  const returnStatus = normalizeCourierStatus(body.status);
  const dispatchStatus = normalizeDispatchStatus(body.status);
  if (!returnStatus && !dispatchStatus) return ApiResponse.success(res, { ignored: true }, 'Status not used by the courier workflows.');

  const ret = returnStatus ? await findShipmentByCn({ cn: body.cn, courier: body.courier }) : { error: 'skip' };
  let result;
  try {
    if (!ret.error) {
      result = await recordTracking({ shipment: ret.shipment, status: returnStatus, note: body.note, source: 'webhook', eventId, occurredAt: at, profile: null });
    } else {
      const found = await findDispatchByCn({ cn: body.cn, courier: body.courier });
      if (found.error) return res.status(404).json({ success: false, statusCode: 404, message: found.error });
      result = await recordDispatchTracking({
        shipment: found.shipment, status: dispatchStatus, note: body.note, reason: body.reason, proof: body.proof && typeof body.proof === 'object' ? body.proof : undefined,
        source: 'webhook', eventId, occurredAt: at, profile: null,
      });
    }
  } catch (e) {
    // a parcel that is not handed over yet (or already past this step) is not an error for the courier: acknowledge, change nothing
    if (e?.statusCode === 400) return ApiResponse.success(res, { ignored: true, reason: e.message }, 'Event not applied.');
    throw e;
  }
  return ApiResponse.success(res, { status: result.shipment.status, duplicate: !!result.duplicate }, result.duplicate ? 'Already recorded.' : 'Tracking recorded.');
});
