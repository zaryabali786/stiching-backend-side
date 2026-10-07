import { supabaseAdmin } from '../config/supabase.js';
import { unwrap, unwrapOne } from '../utils/db.js';
import { notifyUser, notifyAdmins, notifyPartner } from './notification.service.js';
import { emitTo, rooms } from '../realtime/io.js';
import { ConflictError } from '../utils/error.helper.js';

export const ORDER_STATUSES = [
  'submitted', 'received', 'assigned', 'cutting', 'stitching', 'qc_passed', 'customer_approval',
  'packed', 'invoice_issued', 'awaiting_payment', 'paid', 'at_admin_warehouse', 'partner_dispatch',
  'shipped', 'delivered', 'cancelled',
];

export const STATUS_LABELS = {
  draft: 'Draft · complete and submit',
  submitted: 'Submitted · awaiting parcel',
  received: 'Parcel received',
  assigned: 'Assigned to a team',
  cutting: 'Cutting',
  stitching: 'Stitching',
  qc_passed: 'Quality check passed',
  customer_approval: 'Awaiting your approval',
  packed: 'Packed',
  invoice_issued: 'Invoice issued',
  awaiting_payment: 'Awaiting payment',
  paid: 'Paid',
  at_admin_warehouse: 'At dispatch warehouse',
  partner_dispatch: 'Dispatching from partner',
  shipped: 'Shipped',
  delivered: 'Delivered',
  cancelled: 'Cancelled',
};

// Status groups used for filters and counts across portals
export const STATUS_GROUPS = {
  // made automatically from an email; only the customer sees it until they submit it
  draft: ['draft'],
  awaiting_parcel: ['submitted'],
  production: ['received', 'assigned', 'cutting', 'stitching', 'qc_passed', 'customer_approval'],
  invoice: ['packed'],
  payment: ['invoice_issued', 'awaiting_payment'],
  warehouse: ['paid', 'at_admin_warehouse', 'partner_dispatch'],
  shipped: ['shipped', 'delivered'],
  active: ['submitted', 'received', 'assigned', 'cutting', 'stitching', 'qc_passed', 'customer_approval',
    'packed', 'invoice_issued', 'awaiting_payment', 'paid', 'at_admin_warehouse', 'partner_dispatch', 'shipped'],
  completed: ['delivered', 'cancelled'],
};

// Statuses the production board is allowed to drive (never regress a paid/shipped order)
const BOARD_DRIVEN = ['received', 'assigned', 'cutting', 'stitching', 'qc_passed', 'customer_approval', 'packed'];

export const STAGE_RANK = { to_assign: 0, cutting: 1, stitching: 2, qc: 3, packed: 4 };

/**
 * Add a timeline entry without changing status.
 */
export const addEvent = async (orderId, status, note, actorId = null) => {
  const { error } = await supabaseAdmin.from('order_events').insert({ order_id: orderId, status, note, created_by: actorId });
  if (error) console.warn('[order_events] insert failed:', error.message);
};

/**
 * How far along the fulfilment an order is. Everything from `paid` onwards is locked: the status can only move
 * forward, so a late or duplicate write (a stale screen, a webhook retry, a board sync that read an old row)
 * can never turn a shipped order back into "Packed". A DB trigger enforces the same rule (migration 0005).
 */
export const STATUS_RANK = {
  submitted: 0, received: 1, assigned: 2, cutting: 3, stitching: 4, qc_passed: 5, customer_approval: 6,
  packed: 7, invoice_issued: 8, awaiting_payment: 9, paid: 10, at_admin_warehouse: 11, partner_dispatch: 11,
  shipped: 12, delivered: 13,
};
const LOCKED_FROM = STATUS_RANK.paid;
const TERMINAL = ['delivered', 'cancelled'];

/**
 * Is moving an order from `from` to `to` allowed?
 * @returns {{ ok: boolean, reason?: string }}
 */
export const checkTransition = (from, to) => {
  if (from === to) return { ok: true };
  // only the customer can submit a draft (PATCH /client/orders/:id); no staff action may move it
  if (from === 'draft') return { ok: false, reason: 'This order is still a draft the customer has not submitted.' };
  if (!(to in STATUS_RANK) && to !== 'cancelled') return { ok: false, reason: `"${to}" is not an order status.` };
  if (TERMINAL.includes(from)) return { ok: false, reason: `The order is already ${STATUS_LABELS[from].toLowerCase()} and its status cannot change.` };
  if (to === 'cancelled') {
    return STATUS_RANK[from] >= STATUS_RANK.shipped ? { ok: false, reason: 'A shipped order cannot be cancelled.' } : { ok: true };
  }
  if (STATUS_RANK[from] >= LOCKED_FROM && STATUS_RANK[to] < STATUS_RANK[from]) {
    return { ok: false, reason: `The order is already "${STATUS_LABELS[from]}", so it cannot go back to "${STATUS_LABELS[to]}".` };
  }
  return { ok: true };
};

/**
 * What an article (job card) shows to people: its production stage while the order is still being made,
 * and the order's own progress once it has left production (so a delivered order never lists "Packed" articles).
 */
export const ARTICLE_AFTER_PACK = {
  packed: 'Packed',
  invoice_issued: 'Packed · invoice issued',
  awaiting_payment: 'Packed · awaiting payment',
  paid: 'Paid · ready to dispatch',
  at_admin_warehouse: 'At dispatch warehouse',
  partner_dispatch: 'Dispatching from partner',
  shipped: 'Shipped',
  delivered: 'Delivered',
};
export const articleDisplayStatus = (orderStatus, stage) => {
  const afterProduction = stage === 'packed' && ARTICLE_AFTER_PACK[orderStatus] && STATUS_RANK[orderStatus] >= STATUS_RANK.packed;
  if (afterProduction) return { key: orderStatus, label: ARTICLE_AFTER_PACK[orderStatus] };
  return { key: stage, label: null };
};

/** Article timeline entries that follow an order milestone (every article of the order moves together). */
const UNIT_EVENT_FOR_STATUS = { shipped: 'shipped', delivered: 'delivered' };

/**
 * Change an order's status. The DB trigger writes the order_event; we then enrich it with a readable note.
 *
 * The write is a compare-and-swap on the status that was just read, so two requests racing each other cannot
 * overwrite one another, and `checkTransition` refuses moves backwards once the order is paid or later.
 * `soft: true` (used by the automatic board sync) returns the current order instead of throwing when the move is not allowed.
 */
export const setOrderStatus = async (orderId, status, { note, actorId, extra = {}, soft = false } = {}) => {
  let order = null;
  for (let attempt = 0; attempt < 4 && !order; attempt++) {
    const current = unwrapOne(await supabaseAdmin.from('orders').select('*').eq('id', orderId).maybeSingle(), 'Order not found');
    if (current.status === status) {
      // already there: keep the extra fields (dates) but write no duplicate timeline entry
      if (Object.keys(extra).length) await supabaseAdmin.from('orders').update({ ...extra, updated_at: new Date().toISOString() }).eq('id', orderId);
      return current;
    }
    const verdict = checkTransition(current.status, status);
    if (!verdict.ok) {
      if (soft) return current;
      throw new ConflictError(`Order ${current.reference}: ${verdict.reason}`);
    }
    const { data } = await supabaseAdmin
      .from('orders')
      .update({ status, updated_at: new Date().toISOString(), ...extra })
      .eq('id', orderId)
      .eq('status', current.status) // somebody else moved it meanwhile: read again and re-check
      .select('*');
    order = data?.[0] || null;
  }
  if (!order) throw new ConflictError('The order was changed by someone else at the same moment. Refresh and try again.');

  if (note || actorId) {
    const { data: ev } = await supabaseAdmin
      .from('order_events')
      .select('id')
      .eq('order_id', orderId)
      .eq('status', status)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (ev) {
      await supabaseAdmin
        .from('order_events')
        .update({ note: note || STATUS_LABELS[status], created_by: actorId || null })
        .eq('id', ev.id);
    }
  }

  // every article of the order reaches the same milestone (so its own timeline ends in "Shipped" / "Delivered", not "Packed")
  if (UNIT_EVENT_FOR_STATUS[status]) {
    const units = unwrap(await supabaseAdmin.from('order_units').select('id').eq('order_id', orderId));
    if (units.length) {
      const rows = units.map((u) => ({ unit_id: u.id, order_id: orderId, status: UNIT_EVENT_FOR_STATUS[status], note: null, created_by: actorId || null }));
      const { error } = await supabaseAdmin.from('order_unit_events').insert(rows);
      if (error) console.warn('[UnitEvent] milestone insert failed:', error.message);
    }
  }

  // open customer screens (order page, list) refresh by themselves
  emitTo(rooms.user(order.customer_id), 'order:update', { orderId: order.id, status: order.status, status_label: STATUS_LABELS[order.status] });
  return order;
};

export const getOrderOr404 = async (orderId, columns = '*') =>
  unwrapOne(await supabaseAdmin.from('orders').select(columns).eq('id', orderId).maybeSingle(), 'Order not found');

/**
 * After a unit is received / flagged, move the order to `received` once nothing is pending.
 */
export const syncReceiving = async (orderId, actorId) => {
  const order = await getOrderOr404(orderId);
  const units = unwrap(await supabaseAdmin.from('order_units').select('id, status').eq('order_id', orderId));
  const pending = units.filter((u) => u.status === 'pending').length;
  const issues = units.filter((u) => u.status === 'issue').length;

  const extra = { has_issue: issues > 0 };
  if (pending === 0 && order.status === 'submitted') {
    await setOrderStatus(orderId, 'received', {
      note: issues > 0
        ? `Parcel received · ${units.length - issues} of ${units.length} units OK, ${issues} with an issue`
        : `Parcel received · all ${units.length} units OK`,
      actorId,
      extra: { ...extra, received_at: new Date().toISOString() },
    });
    await notifyUser(order.customer_id, {
      type: issues > 0 ? 'alert' : 'update',
      title: `Parcel received: ${order.reference}`,
      body: issues > 0
        ? `We received your parcel from ${order.brand || 'the brand'}, but ${issues} unit(s) have an issue. Our team will contact you.`
        : `All ${units.length} unit(s) from ${order.brand || 'the brand'} arrived safely and are queued for stitching.`,
      link: `/app/orders/${order.id}`,
      orderId: order.id,
    });
  } else {
    unwrap(await supabaseAdmin.from('orders').update(extra).eq('id', orderId));
  }
  return { pending, issues, total: units.length };
};

/**
 * Derive the order status from the slowest job card on the production board.
 */
export const syncOrderFromCards = async (orderId, actorId) => {
  const order = await getOrderOr404(orderId);
  if (!BOARD_DRIVEN.includes(order.status)) return order;

  const cards = unwrap(await supabaseAdmin.from('job_cards').select('stage, qc_passed, approval_status').eq('order_id', orderId));
  if (!cards.length) return order;

  const minRank = Math.min(...cards.map((c) => STAGE_RANK[c.stage]));
  let target;
  if (minRank === 0) target = 'received';
  else if (minRank === 1) target = 'cutting';
  else if (minRank === 2) target = 'stitching';
  else if (minRank === 3) target = cards.every((c) => c.qc_passed || c.stage === 'packed') ? 'qc_passed' : 'stitching';
  else target = 'packed';

  // Approval is per piece: while any piece waits for the customer, the order shows "awaiting your approval"
  if (cards.some((c) => c.approval_status === 'pending')) target = 'customer_approval';
  if (target === order.status) return order;

  const extra = target === 'packed' ? { packed_at: new Date().toISOString() } : {};
  const updated = await setOrderStatus(orderId, target, { note: STATUS_LABELS[target], actorId, extra, soft: true });

  const customerMessages = {
    cutting: 'Your fabric is being cut by our master tailor.',
    stitching: 'Your outfit is now being stitched.',
    qc_passed: 'Your outfit passed quality check.',
    packed: 'Your order is packed. We will send your invoice shortly.',
  };
  if (customerMessages[target]) {
    await notifyUser(order.customer_id, {
      type: 'update',
      title: `${order.reference}: ${STATUS_LABELS[target]}`,
      body: customerMessages[target],
      link: `/app/orders/${order.id}`,
      orderId: order.id,
    });
  }
  if (target === 'packed') {
    await notifyAdmins({
      type: 'invoice',
      title: `Ready for invoice: ${order.reference}`,
      body: `${order.customer_name || 'Customer'} · packed at partner. Issue the invoice.`,
      link: `/admin/invoices?order=${order.id}`,
      orderId: order.id,
    });
  }
  return updated;
};

/**
 * Notify the partner team when something needs their attention.
 */
export const notifyPartnerAboutOrder = (order, title, body, actorId) =>
  notifyPartner({ type: 'update', title, body, link: `/partner/production?search=${order.reference}`, orderId: order.id }, actorId, { module: 'production' });

// ─────────────────────────────── Per-article timeline ───────────────────────────────

/** What the customer reads for each step of one article. */
export const UNIT_EVENT_LABELS = {
  received: 'Received at our atelier',
  issue: 'A problem was found at receiving',
  issue_resolved: 'Problem resolved',
  to_assign: 'Waiting for a master',
  cutting: 'Cutting started',
  stitching: 'Stitching started',
  qc: 'Quality check',
  qc_passed: 'Quality check passed',
  qc_failed: 'Sent back to the tailor for a fix',
  approval_requested: 'Photos sent for your approval',
  approved: 'You approved it',
  changes_requested: 'You asked for changes',
  packed: 'Packed',
  shipped: 'Shipped',
  delivered: 'Delivered',
};

/** Record one step in an article's own timeline. Never throws: a missed entry must not break the action. */
export const logUnitEvent = async (unitId, orderId, status, { note = null, actorId = null } = {}) => {
  if (!unitId || !orderId) return;
  const { error } = await supabaseAdmin.from('order_unit_events').insert({ unit_id: unitId, order_id: orderId, status, note, created_by: actorId });
  if (error) console.warn('[UnitEvent] insert failed:', error.message);
};

/**
 * The timeline a customer sees for one article: the recorded steps, or (older orders) a best-effort
 * version built from the dates stored on the unit and its ticket.
 */
export const buildUnitTimeline = (unit, card, events = []) => {
  const shape = (e) => ({ status: e.status, label: UNIT_EVENT_LABELS[e.status] || e.status, note: e.note || null, at: e.created_at || e.at });
  if (events?.length) return [...events].sort((a, b) => String(a.created_at).localeCompare(String(b.created_at))).map(shape);
  const derived = [
    ['received', unit.received_at],
    ['cutting', card?.cutting_at],
    ['stitching', card?.stitching_at],
    ['qc', card?.qc_at],
    ['approval_requested', card?.approval_requested_at],
    [card?.approval_status === 'changes_requested' ? 'changes_requested' : card?.approval_status === 'approved' ? 'approved' : null, card?.approval_decided_at],
    ['packed', card?.packed_at],
  ];
  return derived
    .filter(([status, at]) => status && at)
    .sort((a, b) => String(a[1]).localeCompare(String(b[1])))
    .map(([status, at]) => shape({ status, created_at: at }));
};
