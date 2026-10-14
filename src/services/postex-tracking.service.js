import crypto from 'node:crypto';
import { supabaseAdmin } from '../config/supabase.js';
import { unwrap } from '../utils/db.js';
import { trackParcel, mapPostexStatus, postexConfigured, postexSettingsView, PostexError } from './postex.service.js';
import { recordDispatchTracking, addShipmentEvent } from './dispatch-shipment.service.js';
import { recordTracking } from './return-shipment.service.js';

/**
 * Brings the tracking of a parcel dispatched with PostEx up to date: reads PostEx's tracking history and applies the events we have not seen,
 * oldest first, through the same transition rules as every other tracking event (delivered / returning to us / failed attempt / in transit).
 * Wording we cannot map is stored as a "courier update" and moves nothing. Safe to run as often as needed: an event is stored once.
 * PostEx webhooks are not used (not confirmed): this polls.
 */
const eventKey = (shipmentId, ev) => crypto.createHash('sha1').update(`${shipmentId}|${ev.code}|${ev.at}|${ev.text}`).digest('hex').slice(0, 40);

export const syncPostexShipment = async (shipment) => {
  const tracking = await trackParcel(shipment.tracking_number);
  let applied = 0;
  for (const ev of tracking.history) {
    const eventId = eventKey(shipment.id, ev);
    const status = mapPostexStatus(ev.text, ev.code);
    try {
      if (!status) {
        if (await addShipmentEvent({ shipmentId: shipment.id, status: 'courier_update', note: ev.text, source: 'system', eventId, occurredAt: ev.at || undefined })) applied += 1;
        continue;
      }
      const result = await recordDispatchTracking({ shipment, status, note: ev.text, source: 'system', eventId, occurredAt: ev.at || undefined, profile: null });
      if (!result.duplicate) applied += 1;
    } catch (e) {
      // a step that does not fit the parcel's state (an older event, a parcel not handed over): keep the wording, change nothing
      if (e?.statusCode !== 400) throw e;
      await addShipmentEvent({ shipmentId: shipment.id, status: 'courier_update', note: ev.text, source: 'system', eventId, occurredAt: ev.at || undefined }).catch(() => {});
    }
    // later events are judged against the parcel as it is now
    const fresh = (await supabaseAdmin.from('shipments').select('*').eq('id', shipment.id).maybeSingle()).data;
    if (fresh) Object.assign(shipment, fresh);
  }
  return { applied, current: tracking.current, events: tracking.history.length };
};

/**
 * The same for a customer's return parcel: only "in transit" and "delivered" are acted on. A failed attempt or a return to us is stored as
 * wording but does not change the return (the article is not "Returned" until PostEx says delivered).
 */
export const syncPostexReturn = async (shipment) => {
  const tracking = await trackParcel(shipment.cn_number);
  let applied = 0;
  for (const ev of tracking.history) {
    const eventId = eventKey(shipment.id, ev);
    const status = mapPostexStatus(ev.text, ev.code);
    try {
      if (status === 'delivered' || status === 'in_transit') {
        const result = await recordTracking({ shipment, status, note: ev.text, source: 'webhook', eventId, occurredAt: ev.at || undefined, profile: null });
        if (!result.duplicate) applied += 1;
      } else {
        const { error } = await supabaseAdmin.from('return_shipment_events').insert({ shipment_id: shipment.id, status: 'courier_update', note: ev.text.slice(0, 300), source: 'webhook', event_id: eventId, occurred_at: ev.at || new Date().toISOString() });
        if (!error) applied += 1;
        else if (error.code !== '23505') throw error;
      }
    } catch (e) {
      if (e?.statusCode !== 400) throw e;
    }
    const fresh = (await supabaseAdmin.from('return_shipments').select('*').eq('id', shipment.id).maybeSingle()).data;
    if (fresh) Object.assign(shipment, fresh);
  }
  return { applied, current: tracking.current, events: tracking.history.length };
};

const LIVE = ['handed_to_courier', 'in_transit', 'failed_delivery'];

/** One pass over every PostEx parcel that is on its way. */
export const pollPostex = async () => {
  if (!postexConfigured()) return { checked: 0 };
  const rows = unwrap(await supabaseAdmin.from('shipments').select('*').eq('shipped_from', 'partner').ilike('courier', 'postex').in('status', LIVE).limit(100));
  const returns = unwrap(await supabaseAdmin.from('return_shipments').select('*').ilike('courier_name', 'postex').in('status', ['handed_over', 'in_transit']).limit(100));
  let checked = 0;
  for (const s of returns) {
    try {
      await syncPostexReturn(s);
      checked += 1;
    } catch (e) {
      console.warn('[postex] return tracking failed for', s.cn_number, '-', e instanceof PostexError ? e.message : e?.message || e);
    }
  }
  for (const s of rows) {
    try {
      await syncPostexShipment(s);
      checked += 1;
    } catch (e) {
      console.warn('[postex] tracking failed for', s.tracking_number, '-', e instanceof PostexError ? e.message : e?.message || e);
    }
  }
  return { checked };
};

let timer = null;
let running = false;

/** Starts the polling when a PostEx token is set and POSTEX_POLL_MINUTES is not 0. */
export const stopPostexPolling = () => {
  if (timer) clearInterval(timer);
  timer = null;
};

/** (Re)starts the polling to match the settings: stopped when PostEx is not configured or the interval is 0. */
export const startPostexPolling = () => {
  stopPostexPolling();
  const minutes = Number(postexSettingsView().pollMinutes);
  if (!postexConfigured() || !minutes) return false;
  const tick = async () => {
    if (running) return;
    running = true;
    try { await pollPostex(); } finally { running = false; }
  };
  timer = setInterval(tick, minutes * 60 * 1000);
  timer.unref?.();
  console.log(`[postex] tracking is checked every ${minutes} min`);
  return true;
};
