import { supabaseAdmin } from '../config/supabase.js';
import { emitTo, rooms } from '../realtime/io.js';
import { BadRequestError, ForbiddenError, NotFoundError, ConflictError } from '../utils/error.helper.js';
import { unwrap } from '../utils/db.js';
import { uploadDataUrls } from './storage.service.js';
import { pushToUserDetailed } from './push.service.js';
import { pageMeta } from '../utils/pagination.js';
import { STAFF_TYPES } from './unit-flow.service.js';
import { cleanDestination, linkFor, pageOptions } from './notification-destination.service.js';

/**
 * Notification Center: one "broadcast" is one message that an admin (to clients, staff or partners) or a partner (to its own
 * staff only) writes. It is stored once (broadcasts), delivered per person (broadcast_deliveries, one row each, so a retry or a
 * second worker can never send it twice), and shown to every person as an ordinary notification (notifications, with the
 * urgent flag and the picture).
 *
 *   web   = the notification row + the live socket event: the bell in the app, kept after a refresh
 *   push  = Firebase Cloud Messaging to the person's own registered devices
 * The two channels are delivered and recorded independently: a failed push never stops the web notification, and the other way.
 */

export const CATEGORIES = ['clients', 'staff', 'partners'];
export const CHANNELS = ['web', 'push'];
/**
 * What each channel means. web = the web application: the notification in the app's bell, live over the socket. push = the MOBILE
 * application: a Firebase push to the person's registered phones (Android and iPhone) only, never to a browser or to anybody else.
 */
export const MOBILE_PLATFORMS = ['android', 'ios'];
export { STAFF_TYPES };
/**
 * Who sits below whom, from the data the platform has: general office staff ('staff') supervise the production floor, and a master
 * directs the tailors. Used only by "Include subordinate staff".
 */
export const SUBORDINATE_TYPES = {
  staff: ['master', 'tailor', 'qa', 'pressing', 'packing'],
  master: ['tailor'],
};

const MAX_TITLE = 120;
const MAX_BODY = 1000;
const MAX_IDS = 2000;
const CHUNK = 200;
const STUCK_AFTER_MS = 10 * 60_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const IMAGE_MIME = /^data:image\/(png|jpe?g|webp);base64,/i;
const MAX_IMAGE_BYTES = 4 * 1024 * 1024; // a picture in a push must stay small

/**
 * @typedef {object} Actor
 * @property {'admin' | 'partner'} kind
 * @property {string} userId
 * @property {string | null} partnerId   the partner a partner user belongs to (null for an admin)
 * @property {(action: string) => boolean} can   whether this person holds one Notification Center action
 */

const need = (actor, action, message) => {
  if (!actor.can(action)) throw new ForbiddenError(message || 'You do not have permission to do this.');
};

const cleanText = (value, label, max) => {
  const text = String(value ?? '').replace(/\r\n/g, '\n').trim();
  if (!text) throw new BadRequestError(`${label} is required.`);
  if (text.length > max) throw new BadRequestError(`${label} is too long (max ${max} characters).`);
  return text;
};

const uniqueIds = (list, label) => {
  if (list === undefined || list === null) return [];
  if (!Array.isArray(list)) throw new BadRequestError(`${label} must be a list.`);
  const ids = [...new Set(list.map(String))];
  if (ids.length > MAX_IDS) throw new BadRequestError(`Choose at most ${MAX_IDS} ${label}.`);
  if (ids.some((id) => !UUID.test(id))) throw new BadRequestError(`${label} contains an invalid id.`);
  return ids;
};

/** The audience the sender asked for, cleaned and limited to what the sender may reach. */
export const cleanAudience = (actor, raw) => {
  const a = raw && typeof raw === 'object' ? raw : {};
  const category = String(a.category || '');
  if (!CATEGORIES.includes(category)) throw new BadRequestError('Choose who to notify: clients, staff or partners.');
  // a partner reaches its own staff and nobody else, whatever the request says
  if (actor.kind === 'partner' && category !== 'staff') throw new ForbiddenError('You can only send notifications to your own staff.');
  const mode = ['all', 'selected', 'filter'].includes(a.mode) ? a.mode : null;
  if (!mode) throw new BadRequestError('Choose all, selected people, or a group.');
  if (category === 'clients' && mode === 'filter') throw new BadRequestError('Choose all clients or select clients.');
  if (category === 'partners' && mode === 'filter') throw new BadRequestError('Choose all partners or select partners.');

  const out = { category, mode, ids: [], partner_ids: [], staff_types: [], include_subordinates: false };
  if (mode === 'selected') {
    out.ids = uniqueIds(a.ids, category === 'partners' ? 'partners' : category === 'clients' ? 'clients' : 'staff members');
    if (!out.ids.length) throw new BadRequestError(`Select at least one ${category === 'clients' ? 'client' : category === 'partners' ? 'partner' : 'staff member'}.`);
  }
  if (category === 'staff') {
    const types = Array.isArray(a.staff_types) ? [...new Set(a.staff_types.map(String))] : [];
    if (types.some((t) => !STAFF_TYPES.includes(t))) throw new BadRequestError('Unknown department or role.');
    out.staff_types = types;
    out.include_subordinates = a.include_subordinates === true;
    if (mode === 'filter' && !types.length && !(actor.kind === 'admin' && uniqueIds(a.partner_ids, 'partners').length)) {
      throw new BadRequestError('Choose a department, a role or a partner.');
    }
    out.partner_ids = actor.kind === 'partner' ? [actor.partnerId] : uniqueIds(a.partner_ids, 'partners');
  }
  if (category === 'partners' && mode === 'selected') out.partner_ids = out.ids;
  return out;
};

/** Staff types to include: the chosen ones, and (optionally) everyone below them. */
export const expandStaffTypes = (types, includeSubordinates) => {
  const set = new Set(types);
  if (includeSubordinates) for (const t of types) for (const below of SUBORDINATE_TYPES[t] || []) set.add(below);
  return [...set];
};

/** Everyone except a partner's owner login (null-safe: admin users have no partner role). */
const NOT_OWNER = 'partner_role.is.null,partner_role.neq.owner';

const pageThrough = async (build) => {
  const all = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await build().range(from, from + 999);
    if (error) throw error;
    all.push(...(data || []));
    if (!data || data.length < 1000) break;
  }
  return all;
};

/**
 * The people an audience reaches right now (active accounts only). `actor` limits it: a partner can only ever reach its own staff.
 * @returns {Promise<{ ids: string[], invalid: string[] }>} `invalid` = selected ids that are not eligible recipients for this sender
 */
export const resolveRecipients = async (actor, audience) => {
  const { category, mode, ids, partner_ids: partnerIds } = audience;
  const staffFilter = (q) => {
    // staff = the members of a partner (not its owner: that is the partner account itself) and restricted admin users
    const query = q.eq('is_active', true).or(NOT_OWNER);
    if (actor.kind === 'partner') return query.eq('role', 'partner_staff').eq('partner_id', actor.partnerId);
    if (partnerIds?.length) return query.eq('role', 'partner_staff').in('partner_id', partnerIds);
    return query.in('role', ['partner_staff', 'admin']);
  };

  let rows;
  if (category === 'clients') {
    rows = await pageThrough(() => {
      let q = supabaseAdmin.from('profiles').select('id').eq('role', 'customer').eq('is_active', true);
      if (mode === 'selected') q = q.in('id', ids);
      return q.order('id');
    });
  } else if (category === 'partners') {
    // the partner accounts: the owner login of each active partner
    const partners = await pageThrough(() => {
      let q = supabaseAdmin.from('partners').select('id').eq('status', 'active');
      if (mode === 'selected') q = q.in('id', partnerIds);
      return q.order('id');
    });
    const activeIds = partners.map((p) => p.id);
    if (mode === 'selected') {
      const known = new Set(activeIds);
      const missing = partnerIds.filter((id) => !known.has(id));
      if (missing.length) return { ids: [], invalid: missing };
    }
    rows = activeIds.length
      ? await pageThrough(() => supabaseAdmin.from('profiles').select('id, partner_id').eq('role', 'partner_staff').eq('partner_role', 'owner').eq('is_active', true).in('partner_id', activeIds).order('id'))
      : [];
  } else {
    const types = expandStaffTypes(audience.staff_types || [], audience.include_subordinates);
    rows = await pageThrough(() => {
      let q = staffFilter(supabaseAdmin.from('profiles').select('id, staff_type, role, partner_role'));
      if (mode === 'selected') q = q.in('id', ids);
      return q.order('id');
    });
    if (mode !== 'selected' && types.length) rows = rows.filter((r) => types.includes(r.staff_type || 'staff'));
  }

  const found = new Set(rows.map((r) => r.id));
  const requested = category === 'partners' ? [] : mode === 'selected' ? ids : [];
  const invalid = requested.filter((id) => !found.has(id));
  return { ids: [...found], invalid };
};

/** What a person may do in the Notification Center, for the form. */
export const abilities = (actor) =>
  Object.fromEntries(['create', 'send', 'schedule', 'edit', 'cancel', 'urgent', 'image', 'history', 'status'].map((a) => [a, actor.can(a)]));

const toPublic = (b) => ({
  id: b.id,
  title: b.title,
  body: b.body,
  image_url: b.image_url,
  priority: b.priority,
  channels: b.channels,
  category: b.category,
  audience: b.audience,
  destination: b.destination ?? null,
  status: b.status,
  is_scheduled: b.is_scheduled,
  send_at: b.send_at,
  timezone: b.timezone,
  sent_at: b.sent_at,
  created_at: b.created_at,
  created_by: b.created_by,
  creator_name: b.creator?.full_name ?? null,
  partner_id: b.partner_id,
  recipient_count: b.recipient_count,
  web_sent: b.web_sent,
  web_failed: b.web_failed,
  push_sent: b.push_sent,
  push_failed: b.push_failed,
  push_no_device: b.push_no_device,
  error: b.error,
});

const SELECT = '*, creator:profiles!broadcasts_created_by_fkey(full_name)';

/** A scheduled time must be a real, future instant. */
const cleanSchedule = (raw, now = Date.now()) => {
  const at = new Date(raw?.at);
  if (Number.isNaN(at.getTime())) throw new BadRequestError('Choose a valid date and time.');
  if (at.getTime() <= now + 30_000) throw new BadRequestError('The scheduled time must be in the future.');
  if (at.getTime() > now + 366 * 86_400_000) throw new BadRequestError('The scheduled time must be within a year.');
  let timezone = null;
  if (raw?.timezone) {
    try {
      new Intl.DateTimeFormat('en', { timeZone: String(raw.timezone) });
      timezone = String(raw.timezone);
    } catch {
      throw new BadRequestError('Unknown time zone.');
    }
  }
  return { at: at.toISOString(), timezone };
};

const cleanChannels = (value) => {
  const list = Array.isArray(value) ? [...new Set(value.map(String))] : [];
  if (!list.length || list.some((c) => !CHANNELS.includes(c))) throw new BadRequestError('Choose web, push or both.');
  return CHANNELS.filter((c) => list.includes(c));
};

const storeImage = async (folder, image) => {
  if (!image?.dataUrl) return { url: null, path: null };
  if (!IMAGE_MIME.test(image.dataUrl)) throw new BadRequestError('The picture must be a PNG, JPG or WebP image.');
  if ((image.dataUrl.length * 3) / 4 > MAX_IMAGE_BYTES) throw new BadRequestError('The picture must be smaller than 4 MB.');
  const [up] = await uploadDataUrls(folder, [{ name: image.name || 'notification', dataUrl: image.dataUrl }]);
  return { url: up.url, path: up.path };
};

/** Check the sender's permissions for what was asked, once for create and once for edit. */
const checkAbilities = (actor, { scheduled, urgent, image }) => {
  need(actor, 'create', 'You are not allowed to create notifications.');
  if (scheduled) need(actor, 'schedule', 'You are not allowed to schedule notifications.');
  else need(actor, 'send', 'You are not allowed to send notifications.');
  if (urgent) need(actor, 'urgent', 'You are not allowed to send urgent notifications.');
  if (image) need(actor, 'image', 'You are not allowed to attach images.');
};

/**
 * Create a broadcast. Immediate ones are claimed and returned ready for `dispatchBroadcast`; scheduled ones wait for the scheduler.
 * @returns {Promise<{ broadcast: object, dispatchNow: boolean }>}
 */
export const createBroadcast = async (actor, input, now = Date.now()) => {
  const title = cleanText(input.title, 'The title', MAX_TITLE);
  const body = cleanText(input.body, 'The message', MAX_BODY);
  const priority = input.priority === 'urgent' ? 'urgent' : 'normal';
  const channels = cleanChannels(input.channels);
  const scheduled = !!input.schedule;
  checkAbilities(actor, { scheduled, urgent: priority === 'urgent', image: !!input.image?.dataUrl });
  const audience = cleanAudience(actor, input.audience);
  // where a tap leads: optional, validated against the audience (an order only for its own client, a product only for clients)
  const destination = await cleanDestination(input.destination, audience, actor.kind);
  const when = scheduled ? cleanSchedule(input.schedule, now) : { at: new Date(now).toISOString(), timezone: null };

  // the sender must be allowed to reach every selected person: checked now (and again when it goes out)
  const { ids, invalid } = await resolveRecipients(actor, audience);
  if (invalid.length) throw new ForbiddenError('Some of the selected people are not available to you.');
  if (!ids.length) throw new BadRequestError('Nobody is eligible to receive this notification.');

  const image = await storeImage(`notifications/${actor.partnerId || 'admin'}`, input.image);
  const row = {
    created_by: actor.userId,
    partner_id: actor.kind === 'partner' ? actor.partnerId : null,
    audience,
    destination,
    category: audience.category,
    title,
    body,
    image_url: image.url,
    image_path: image.path,
    priority,
    channels,
    status: 'scheduled',
    send_at: when.at,
    is_scheduled: scheduled,
    timezone: when.timezone,
    recipient_count: ids.length,
  };
  const saved = unwrap(await supabaseAdmin.from('broadcasts').insert(row).select(SELECT).single(), 'Could not save the notification');
  return { broadcast: saved, dispatchNow: !scheduled };
};

/** Claim one due broadcast for this worker. Returns it, or null when another worker (or a cancel) got there first. */
export const claimBroadcast = async (id) => {
  const q = supabaseAdmin
    .from('broadcasts')
    .update({ status: 'processing', claimed_at: new Date().toISOString() })
    .eq('id', id)
    .eq('status', 'scheduled')
    .lte('send_at', new Date().toISOString())
    .select(SELECT);
  const { data, error } = await q;
  if (error) throw error;
  const row = data?.[0] || null;
  if (row) await supabaseAdmin.from('broadcasts').update({ attempts: (row.attempts || 0) + 1 }).eq('id', id);
  return row;
};

const needsWeb = (row, channels) => channels.includes('web') && row.web_status !== 'sent';
const needsPush = (row, channels) => channels.includes('push') && !['sent', 'no_device'].includes(row.push_status);

const chunks = (list, size) => {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
};

/** Run `fn` over `list` with at most `limit` in flight. */
const pool = async (list, limit, fn) => {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, list.length) }, async () => {
    while (next < list.length) await fn(list[next++]);
  }));
};

const deliverChunk = async (broadcast, rows, now) => {
  const channels = broadcast.channels || [];
  const urgent = broadcast.priority === 'urgent';
  const webRows = rows.filter((r) => needsWeb(r, channels));

  // web: the notification the person sees in the bell (kept in the database, pushed live over the socket)
  const notificationOf = new Map();
  if (webRows.length) {
    // a person who already has this broadcast's notification (an earlier attempt saved it but the record was lost) is not given a second one
    const { data: have } = await supabaseAdmin.from('notifications').select('id, user_id').eq('broadcast_id', broadcast.id).in('user_id', webRows.map((r) => r.user_id));
    const already = new Map((have || []).map((n) => [n.user_id, n]));
    for (const r of webRows) {
      const n = already.get(r.user_id);
      if (n) { r.web_status = 'sent'; r.notification_id = n.id; notificationOf.set(r.user_id, n); }
    }
    webRows.splice(0, webRows.length, ...webRows.filter((r) => !already.has(r.user_id)));
  }
  // the app each person uses decides which route the destination becomes for them (a client and a staff member open different pages)
  const roleOf = new Map();
  if (broadcast.destination && rows.length) {
    const { data: people } = await supabaseAdmin.from('profiles').select('id, role').in('id', rows.map((r) => r.user_id));
    (people || []).forEach((p) => roleOf.set(p.id, p.role));
  }
  const linkOf = (userId) => (broadcast.destination ? linkFor(broadcast.destination, roleOf.get(userId)) : { link: null, external_url: null });
  if (webRows.length) {
    const { data, error } = await supabaseAdmin
      .from('notifications')
      .insert(webRows.map((r) => ({
        user_id: r.user_id, type: 'broadcast', title: broadcast.title, body: broadcast.body, link: linkOf(r.user_id).link,
        destination: broadcast.destination ?? null,
        priority: broadcast.priority, image_url: broadcast.image_url, broadcast_id: broadcast.id,
      })))
      .select('*');
    if (error) {
      for (const r of webRows) { r.web_status = 'failed'; r.error = `Web: ${error.message}`.slice(0, 200); }
    } else {
      (data || []).forEach((n) => notificationOf.set(n.user_id, n));
      for (const r of webRows) {
        const n = notificationOf.get(r.user_id);
        r.web_status = n ? 'sent' : 'failed';
        r.notification_id = n?.id ?? r.notification_id ?? null;
        if (n) emitTo(rooms.user(r.user_id), 'notification:new', { notification: n });
        else r.error = 'Web: the notification was not saved.';
      }
    }
  }

  // push: handled on its own, so a failure here never undoes the web notification (and the other way round)
  const pushRows = rows.filter((r) => needsPush(r, channels));
  await pool(pushRows, 8, async (r) => {
    const n = notificationOf.get(r.user_id);
    const res = await pushToUserDetailed(r.user_id, {
      id: n?.id || r.notification_id || '', title: broadcast.title, body: broadcast.body, type: 'broadcast',
      imageUrl: broadcast.image_url || '', priority: urgent ? 'urgent' : 'normal',
      // the tap goes through the server's destination check (by notification id); the route is only a fallback for older apps
      link: linkOf(r.user_id).link, hasDestination: !!broadcast.destination,
    }, { platforms: MOBILE_PLATFORMS });
    r.push_message_ids = res.messageIds || [];
    r.push_devices = res.devices;
    r.push_status = res.status === 'off' ? 'failed' : res.status;
    if (res.status !== 'sent' && res.status !== 'no_device') r.error = `Push: ${res.error || 'not delivered'}`.slice(0, 200);
    else if (r.web_status !== 'failed') r.error = null;
  });

  for (const r of rows) {
    const record = {
      web_status: r.web_status ?? null, push_status: r.push_status ?? null, push_devices: r.push_devices ?? 0,
      notification_id: r.notification_id ?? null, error: r.error ?? null, attempts: (r.attempts || 0) + 1, updated_at: new Date(now).toISOString(),
    };
    // Firebase's receipts (message ids) of the accepted pushes. Needs migration 0053; until it has run, everything else is still recorded.
    let { error } = await supabaseAdmin.from('broadcast_deliveries').update(r.push_message_ids?.length ? { ...record, push_message_ids: r.push_message_ids } : record).eq('id', r.id);
    if (error && r.push_message_ids?.length) ({ error } = await supabaseAdmin.from('broadcast_deliveries').update(record).eq('id', r.id));
    if (error) console.warn('[Broadcast] could not record a delivery:', error.message);
  }
};

/** Add up the delivery rows into the counters of the broadcast and decide its final status. */
const settle = async (broadcast) => {
  const rows = await pageThrough(() => supabaseAdmin.from('broadcast_deliveries').select('id, web_status, push_status').eq('broadcast_id', broadcast.id).order('id'));
  const channels = broadcast.channels || [];
  const count = (pred) => rows.filter(pred).length;
  const webSent = count((r) => r.web_status === 'sent');
  const webFailed = count((r) => channels.includes('web') && r.web_status !== 'sent');
  const pushSent = count((r) => r.push_status === 'sent');
  const pushFailed = count((r) => channels.includes('push') && !['sent', 'no_device'].includes(r.push_status));
  const noDevice = count((r) => r.push_status === 'no_device');
  const failures = webFailed + pushFailed;
  const anyOk = webSent + pushSent + noDevice > 0;
  const status = !rows.length ? 'failed' : failures === 0 ? 'sent' : anyOk ? 'partial' : 'failed';
  const patch = {
    status, sent_at: new Date().toISOString(), recipient_count: rows.length,
    web_sent: webSent, web_failed: webFailed, push_sent: pushSent, push_failed: pushFailed, push_no_device: noDevice,
    error: status === 'sent' ? null : !rows.length ? 'Nobody was eligible to receive it.' : `${failures} delivery problem${failures === 1 ? '' : 's'}. See the delivery status.`,
  };
  unwrap(await supabaseAdmin.from('broadcasts').update(patch).eq('id', broadcast.id), 'Could not save the result');
  return { ...broadcast, ...patch };
};

/**
 * Deliver a claimed broadcast. `resolve: false` (a retry) only touches the people whose delivery failed; the audience is not
 * looked at again, so nobody new is added and nobody who already received it gets it twice.
 */
export const dispatchBroadcast = async (broadcast, { resolve = true } = {}) => {
  try {
    if (resolve) {
      // the sender may not be able to reach these people any more (a partner's staff member left): the audience is checked again
      const actor = { kind: broadcast.partner_id ? 'partner' : 'admin', partnerId: broadcast.partner_id, userId: broadcast.created_by, can: () => true };
      const { ids } = await resolveRecipients(actor, broadcast.audience);
      for (const part of chunks(ids, 500)) {
        // one row per person: a retry or a second worker finds the row already there and adds nothing
        const { error } = await supabaseAdmin.from('broadcast_deliveries').upsert(part.map((user_id) => ({ broadcast_id: broadcast.id, user_id })), { onConflict: 'broadcast_id,user_id', ignoreDuplicates: true });
        if (error) throw error;
      }
    }
    const deliveries = await pageThrough(() => supabaseAdmin.from('broadcast_deliveries').select('*').eq('broadcast_id', broadcast.id).order('id'));
    const channels = broadcast.channels || [];
    const todo = deliveries.filter((d) => needsWeb(d, channels) || needsPush(d, channels));
    for (const part of chunks(todo, CHUNK)) await deliverChunk(broadcast, part, Date.now());
    return await settle(broadcast);
  } catch (err) {
    console.warn('[Broadcast] dispatch failed:', err.message);
    const patch = { status: 'failed', error: String(err.message || 'Dispatch failed').slice(0, 300), sent_at: new Date().toISOString() };
    await supabaseAdmin.from('broadcasts').update(patch).eq('id', broadcast.id);
    return { ...broadcast, ...patch };
  }
};

/** Send a freshly created immediate broadcast: claim it (atomic) and deliver. */
export const sendNow = async (broadcast) => {
  const claimed = await claimBroadcast(broadcast.id);
  return claimed ? dispatchBroadcast(claimed) : broadcast;
};

/**
 * The scheduler tick: first hand back broadcasts a crashed worker left half-way, then claim and deliver everything that is due.
 * Several workers (or two ticks) can run it at once: only the one whose atomic claim succeeds delivers a broadcast.
 */
export const processDueBroadcasts = async (limit = 20) => {
  const nowIso = new Date().toISOString();
  await supabaseAdmin
    .from('broadcasts')
    .update({ status: 'scheduled' })
    .eq('status', 'processing')
    .lt('claimed_at', new Date(Date.now() - STUCK_AFTER_MS).toISOString());
  const { data, error } = await supabaseAdmin
    .from('broadcasts')
    .select('id, priority')
    .eq('status', 'scheduled')
    .lte('send_at', nowIso)
    .order('send_at')
    .limit(limit);
  if (error) {
    console.warn('[Broadcast] could not look for due notifications:', error.message);
    return 0;
  }
  // urgent ones first
  const due = [...(data || [])].sort((a, b) => Number(b.priority === 'urgent') - Number(a.priority === 'urgent'));
  let sent = 0;
  for (const { id } of due) {
    const claimed = await claimBroadcast(id);
    if (!claimed) continue;
    await dispatchBroadcast(claimed);
    sent += 1;
  }
  return sent;
};

let timer = null;
/** Start the scheduler (every 30 seconds). Safe to call once at server start. */
export const startBroadcastScheduler = (everyMs = 30_000) => {
  if (timer) return;
  timer = setInterval(() => processDueBroadcasts().catch((err) => console.warn('[Broadcast] scheduler:', err.message)), everyMs);
  timer.unref?.();
  processDueBroadcasts().catch(() => undefined);
};

// ─────────────────────────────── reading, editing, cancelling ───────────────────────────────

const scopeQuery = (actor, q) => (actor.kind === 'partner' ? q.eq('partner_id', actor.partnerId) : q);

const loadOwn = async (actor, id) => {
  if (!UUID.test(String(id))) throw new NotFoundError('Notification not found.');
  const { data } = await scopeQuery(actor, supabaseAdmin.from('broadcasts').select(SELECT).eq('id', id)).maybeSingle();
  // a partner can never see the admin's or another partner's notification: it simply does not exist for them
  if (!data) throw new NotFoundError('Notification not found.');
  return data;
};

/** History, newest first, one page at a time. */
export const listBroadcasts = async (actor, query) => {
  need(actor, 'history', 'You are not allowed to view the notification history.');
  const page = Math.max(1, parseInt(query.page, 10) || 1);
  const limit = Math.min(50, Math.max(1, parseInt(query.limit, 10) || 15));
  let q = scopeQuery(actor, supabaseAdmin.from('broadcasts').select(SELECT, { count: 'exact' }));
  if (['scheduled', 'processing', 'sent', 'partial', 'failed', 'cancelled'].includes(query.status)) q = q.eq('status', query.status);
  if (query.scheduled === 'true') q = q.eq('status', 'scheduled');
  if (['normal', 'urgent'].includes(query.priority)) q = q.eq('priority', query.priority);
  if (CATEGORIES.includes(query.category)) q = q.eq('category', query.category);
  if (query.from && !Number.isNaN(Date.parse(query.from))) q = q.gte('created_at', new Date(query.from).toISOString());
  if (query.to && !Number.isNaN(Date.parse(query.to))) q = q.lte('created_at', new Date(query.to).toISOString());
  const { data, error, count } = await q.order(query.scheduled === 'true' ? 'send_at' : 'created_at', { ascending: query.scheduled === 'true' }).range((page - 1) * limit, page * limit - 1);
  if (error) throw error;
  return { items: (data || []).map(toPublic), meta: pageMeta({ page, limit }, count) };
};

/** One notification with who got it and what failed (delivery status). */
export const getBroadcast = async (actor, id, query = {}) => {
  need(actor, 'history', 'You are not allowed to view the notification history.');
  const b = await loadOwn(actor, id);
  const out = { ...toPublic(b) };
  if (actor.can('status')) {
    const page = Math.max(1, parseInt(query.page, 10) || 1);
    const limit = 25;
    let q = supabaseAdmin.from('broadcast_deliveries').select('user_id, web_status, push_status, push_devices, error, updated_at, user:profiles!broadcast_deliveries_user_id_fkey(full_name, email)', { count: 'exact' }).eq('broadcast_id', b.id);
    if (query.problems === 'true') q = q.or('web_status.eq.failed,push_status.eq.failed');
    const { data, count } = await q.order('updated_at', { ascending: false }).range((page - 1) * limit, page * limit - 1);
    out.deliveries = (data || []).map((d) => ({ user_id: d.user_id, name: d.user?.full_name ?? null, email: d.user?.email ?? null, web_status: d.web_status, push_status: d.push_status, push_devices: d.push_devices, error: d.error }));
    out.deliveries_meta = pageMeta({ page, limit }, count);
  }
  return out;
};

/** Change a notification that has not gone out yet. */
export const updateBroadcast = async (actor, id, input) => {
  need(actor, 'edit', 'You are not allowed to edit scheduled notifications.');
  const b = await loadOwn(actor, id);
  if (b.status !== 'scheduled' || !b.is_scheduled) throw new ConflictError('Only a notification that is still waiting can be edited.');
  const patch = {};
  if (input.title !== undefined) patch.title = cleanText(input.title, 'The title', MAX_TITLE);
  if (input.body !== undefined) patch.body = cleanText(input.body, 'The message', MAX_BODY);
  if (input.priority !== undefined) {
    patch.priority = input.priority === 'urgent' ? 'urgent' : 'normal';
    if (patch.priority === 'urgent') need(actor, 'urgent', 'You are not allowed to send urgent notifications.');
  }
  if (input.channels !== undefined) patch.channels = cleanChannels(input.channels);
  if (input.schedule !== undefined) {
    need(actor, 'schedule', 'You are not allowed to schedule notifications.');
    const when = cleanSchedule(input.schedule);
    patch.send_at = when.at;
    patch.timezone = when.timezone;
  }
  if (input.audience !== undefined) {
    const audience = cleanAudience(actor, input.audience);
    const { ids, invalid } = await resolveRecipients(actor, audience);
    if (invalid.length) throw new ForbiddenError('Some of the selected people are not available to you.');
    if (!ids.length) throw new BadRequestError('Nobody is eligible to receive this notification.');
    patch.audience = audience;
    patch.category = audience.category;
    patch.recipient_count = ids.length;
  }
  // the destination is always checked against the audience that will receive it (the new one when it changed too)
  if (input.destination !== undefined || input.audience !== undefined) {
    patch.destination = await cleanDestination(input.destination !== undefined ? input.destination : b.destination, patch.audience || b.audience, actor.kind);
  }
  if (input.remove_image === true) {
    patch.image_url = null;
    patch.image_path = null;
  } else if (input.image?.dataUrl) {
    need(actor, 'image', 'You are not allowed to attach images.');
    const image = await storeImage(`notifications/${actor.partnerId || 'admin'}`, input.image);
    patch.image_url = image.url;
    patch.image_path = image.path;
  }
  if (!Object.keys(patch).length) return toPublic(b);
  // only while it still waits: if the scheduler picked it up meanwhile, nothing changes
  const { data, error } = await supabaseAdmin.from('broadcasts').update(patch).eq('id', b.id).eq('status', 'scheduled').select(SELECT);
  if (error) throw error;
  if (!data?.length) throw new ConflictError('This notification has just been sent and can no longer be edited.');
  return toPublic(data[0]);
};

/** Stop a notification that has not gone out yet. */
export const cancelBroadcast = async (actor, id) => {
  need(actor, 'cancel', 'You are not allowed to cancel scheduled notifications.');
  const b = await loadOwn(actor, id);
  const { data, error } = await supabaseAdmin.from('broadcasts').update({ status: 'cancelled' }).eq('id', b.id).eq('status', 'scheduled').select(SELECT);
  if (error) throw error;
  if (!data?.length) throw new ConflictError('Only a notification that is still waiting can be cancelled.');
  return toPublic(data[0]);
};

/** Try the failed deliveries of a partly sent or failed notification again (people who already got it are left alone). */
export const retryBroadcast = async (actor, id) => {
  need(actor, 'send', 'You are not allowed to send notifications.');
  const b = await loadOwn(actor, id);
  if (!['partial', 'failed'].includes(b.status)) throw new ConflictError('Only a notification with failed deliveries can be retried.');
  const { data, error } = await supabaseAdmin.from('broadcasts').update({ status: 'processing', claimed_at: new Date().toISOString() }).eq('id', b.id).in('status', ['partial', 'failed']).select(SELECT);
  if (error) throw error;
  if (!data?.length) throw new ConflictError('This notification is already being processed.');
  const hasRows = (await supabaseAdmin.from('broadcast_deliveries').select('id', { count: 'exact', head: true }).eq('broadcast_id', b.id)).count;
  return { broadcast: data[0], resolve: !hasRows };
};

// ─────────────────────────────── recipient pickers ───────────────────────────────

const LIKE = (s) => String(s || '').replace(/[,()*%\\:"']/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60);

/**
 * The searchable lists in the form. A partner only ever gets its own staff, whatever is asked for.
 * @returns {{ items: { id, name, email, detail }[], meta }}
 */
export const searchRecipients = async (actor, query) => {
  need(actor, 'create', 'You are not allowed to create notifications.');
  const category = actor.kind === 'partner' ? 'staff' : String(query.category || '');
  if (!CATEGORIES.includes(category)) throw new BadRequestError('Choose clients, staff or partners.');
  const page = Math.max(1, parseInt(query.page, 10) || 1);
  const limit = Math.min(50, Math.max(1, parseInt(query.limit, 10) || 20));
  const search = LIKE(query.search);
  const range = [(page - 1) * limit, page * limit - 1];

  if (category === 'partners') {
    let q = supabaseAdmin.from('partners').select('id, name', { count: 'exact' }).eq('status', 'active');
    if (search) q = q.ilike('name', `%${search}%`);
    const { data, count, error } = await q.order('name').range(...range);
    if (error) throw error;
    return { items: (data || []).map((p) => ({ id: p.id, name: p.name, email: null, detail: 'Partner' })), meta: pageMeta({ page, limit }, count) };
  }

  let q = supabaseAdmin.from('profiles').select('id, full_name, email, staff_type, role, partner_id, partner_role, customer_code', { count: 'exact' }).eq('is_active', true);
  if (category === 'clients') {
    q = q.eq('role', 'customer');
  } else if (actor.kind === 'partner') {
    q = q.eq('role', 'partner_staff').eq('partner_id', actor.partnerId).or(NOT_OWNER);
  } else {
    q = q.in('role', ['partner_staff', 'admin']).or(NOT_OWNER);
    const partnerId = String(query.partner_id || '');
    if (UUID.test(partnerId)) q = q.eq('partner_id', partnerId);
  }
  const type = String(query.staff_type || '');
  if (category === 'staff' && STAFF_TYPES.includes(type)) {
    q = q.in('staff_type', expandStaffTypes([type], query.include_subordinates === 'true'));
  }
  if (search) q = q.or(`full_name.ilike.%${search}%,email.ilike.%${search}%`);
  const { data, count, error } = await q.order('full_name').range(...range);
  if (error) throw error;
  return {
    items: (data || []).map((p) => ({ id: p.id, name: p.full_name || p.email, email: p.email, detail: category === 'clients' ? p.customer_code || 'Client' : p.role === 'admin' ? 'Admin staff' : p.staff_type || 'staff' })),
    meta: pageMeta({ page, limit }, count),
  };
};

/** For the form: the partners an admin can pick, the staff types, and what the sender may do. */
export const formOptions = async (actor) => {
  const partners = actor.kind === 'admin'
    ? unwrap(await supabaseAdmin.from('partners').select('id, name').eq('status', 'active').order('name').limit(500))
    : [];
  return {
    abilities: abilities(actor),
    kind: actor.kind,
    categories: actor.kind === 'partner' ? ['staff'] : CATEGORIES,
    channels: CHANNELS,
    staff_types: STAFF_TYPES.map((id) => ({ id, label: id === 'qa' ? 'Quality check' : id.charAt(0).toUpperCase() + id.slice(1), subordinates: SUBORDINATE_TYPES[id] || [] })),
    partners,
    // the pages a notification may open, per audience (generated from the page table of the destination service)
    destinations: Object.fromEntries(CATEGORIES.map((c) => [c, pageOptions(c, actor.kind)])),
    limits: { title: MAX_TITLE, body: MAX_BODY, image_mb: MAX_IMAGE_BYTES / 1024 / 1024 },
  };
};
