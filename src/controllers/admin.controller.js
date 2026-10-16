import { supabaseAdmin } from '../config/supabase.js';
import { catchAsync, ApiResponse, BadRequestError, ForbiddenError, NotFoundError } from '../utils/error.helper.js';
import { parseListQuery, sendPage, ilikeAny } from '../utils/pagination.js';
import { unwrap, unwrapOne, todayISO, startOfMonthISO, daysAgoISO, sum, round2 } from '../utils/db.js';
import { STATUS_GROUPS, STATUS_LABELS, ORDER_STATUSES, setOrderStatus, addEvent, getOrderOr404, syncReceiving, articleDisplayStatus } from '../services/order.service.js';
import { notifyUser } from '../services/notification.service.js';
import { adminModulesOf, adminActionsOf, roleIdsOf } from '../config/admin-modules.js';
import UserModel from '../models/user.model.js';
import { invalidateProfile } from '../middlewares/auth.middleware.js';
import { withSignedUrl } from '../services/storage.service.js';
import { withSizeSnapshot } from '../utils/measurements.js';
import { signNoteAudio } from '../services/voice-note.service.js';
import { logUnitEvent } from '../services/order.service.js';
import { unreadConversationCount } from '../services/chat.service.js';
import { activePartnerOf, inActivePartner } from '../services/access.service.js';
import { routedUnitIds, adjustUnitCounts } from '../services/return-order.service.js';
import { loadShipTo, saveShipTo } from '../services/ship-to.service.js';
import { postexSettingsView, savePostexSettings, getOperationalCities, listMerchantAddresses } from '../services/postex.service.js';
import { loadExpressStitching, saveExpressStitching } from '../services/express-stitching.service.js';
import { loadExpressShipping, saveExpressShipping } from '../services/express-shipping.service.js';
import { resolveCourier } from '../services/courier.service.js';

const one = (v) => (Array.isArray(v) ? v[0] ?? null : v ?? null);
const isPakistan = (country) => /^(pk|pakistan)$/i.test(String(country || '').trim());

// ─────────────────────────────── Overview ───────────────────────────────

/**
 * GET /api/admin/overview?period=this_week|this_month|6_months
 */
export const getAdminOverview = catchAsync(async (req, res) => {
  const period = ['this_week', 'this_month', '6_months'].includes(req.query.period) ? req.query.period : '6_months';
  const chartMonths = period === '6_months' ? 6 : 1;
  const since = period === 'this_week' ? daysAgoISO(7) : startOfMonthISO(chartMonths - 1);

  const inPartner = (query, column) => inActivePartner(req.access, query, column);
  const [periodOrders, statusRows, awaitingInvoices, delayedCards, inTransit, issueOrders] = await Promise.all([
    inPartner(supabaseAdmin.from('orders').select('id, created_at, destination_country, status').gte('created_at', since).not('status', 'in', '(cancelled,draft)')),
    inPartner(supabaseAdmin.from('orders').select('status, has_issue, shipped_at').not('status', 'in', '(cancelled,draft)')),
    inPartner(supabaseAdmin.from('invoices').select('total_pkr, order:orders!invoices_order_id_fkey!inner(partner_id)').eq('status', 'issued'), 'order.partner_id'),
    inPartner(supabaseAdmin.from('job_cards').select('order_id').lt('due_date', todayISO()).neq('stage', 'packed')),
    inPartner(supabaseAdmin.from('transfers').select('id, code, orders:orders!orders_transfer_id_fkey(id)').eq('status', 'in_transit')),
    inPartner(supabaseAdmin.from('orders').select('id, reference, customer_name').eq('has_issue', true).not('status', 'in', '(cancelled,delivered)').limit(5)),
  ]);

  const orders = unwrap(periodOrders);
  const allStatuses = unwrap(statusRows);
  const countIn = (group) => allStatuses.filter((o) => group.includes(o.status)).length;
  const delayedOrderIds = [...new Set(unwrap(delayedCards).map((c) => c.order_id))];

  // Orders per month (international vs Pakistan)
  const perMonth = [];
  for (let i = chartMonths === 1 ? 0 : 5; i >= 0; i--) {
    const d = new Date(startOfMonthISO(i));
    const key = d.toISOString().slice(0, 7);
    const inMonth = orders.filter((o) => o.created_at.startsWith(key));
    perMonth.push({
      month: d.toLocaleString('en-GB', { month: 'short', timeZone: 'UTC' }),
      key,
      international: inMonth.filter((o) => !isPakistan(o.destination_country)).length,
      pakistan: inMonth.filter((o) => isPakistan(o.destination_country)).length,
    });
  }
  const maxMonth = Math.max(1, ...perMonth.map((m) => m.international + m.pakistan));

  const byCountry = {};
  for (const o of orders) {
    const c = o.destination_country || 'Unknown';
    byCountry[c] = (byCountry[c] || 0) + 1;
  }
  const countries = Object.entries(byCountry).map(([country, count]) => ({ country, count })).sort((a, b) => b.count - a.count).slice(0, 6);
  const maxCountry = Math.max(1, ...countries.map((c) => c.count));

  const weekAgo = daysAgoISO(7);
  const statusBars = [
    { key: 'awaiting_parcel', status: 'Awaiting parcel', count: countIn(STATUS_GROUPS.awaiting_parcel) },
    { key: 'production', status: 'In production', count: countIn(STATUS_GROUPS.production) },
    { key: 'invoice', status: 'Waiting for invoice', count: countIn(STATUS_GROUPS.invoice) },
    { key: 'payment', status: 'Awaiting payment', count: countIn(STATUS_GROUPS.payment) },
    { key: 'warehouse', status: 'Paid · to dispatch', count: countIn(STATUS_GROUPS.warehouse) },
    { key: 'shipped', status: 'Shipped this week', count: allStatuses.filter((o) => o.shipped_at && o.shipped_at >= weekAgo).length },
  ];
  const maxStatus = Math.max(1, ...statusBars.map((s) => s.count));

  // Needs action list
  const packed = unwrap(await inActivePartner(req.access, supabaseAdmin.from('orders').select('id, reference, customer_name').eq('status', 'packed').order('packed_at').limit(5)));
  const delayedOrders = delayedOrderIds.length
    ? unwrap(await supabaseAdmin.from('orders').select('id, reference, customer_name, due_date').in('id', delayedOrderIds.slice(0, 5)))
    : [];
  const needsAction = [
    ...packed.map((o) => ({ id: `inv_${o.id}`, code: o.reference, title: o.customer_name, subtext: 'Packed at partner · issue the invoice', actionType: 'INVOICE', link: '/admin/invoices', queryParams: { order: o.id } })),
    ...unwrap(inTransit).map((t) => ({ id: `tr_${t.id}`, code: t.code, title: `${t.orders?.length || 0} parcel(s)`, subtext: 'On the way from partner', actionType: 'RECEIVE', link: '/admin/warehouse', queryParams: { tab: 'transfers' } })),
    ...unwrap(issueOrders).map((o) => ({ id: `iss_${o.id}`, code: o.reference, title: o.customer_name, subtext: 'Issue reported at receiving · contact customer', actionType: 'OPEN', link: '/admin/orders', queryParams: { ref: o.reference } })),
    ...delayedOrders.map((o) => ({ id: `del_${o.id}`, code: o.reference, title: o.customer_name, subtext: `Delayed · was due ${o.due_date}`, actionType: 'OPEN', link: '/admin/orders', queryParams: { ref: o.reference } })),
  ];

  const awaiting = unwrap(awaitingInvoices);
  return ApiResponse.success(res, {
    period,
    ordersInPeriod: orders.length,
    internationalOrders: orders.filter((o) => !isPakistan(o.destination_country)).length,
    inProduction: countIn(STATUS_GROUPS.production),
    waitingForInvoice: countIn(STATUS_GROUPS.invoice),
    awaitingPayment: countIn(STATUS_GROUPS.payment),
    awaitingPaymentPkr: round2(sum(awaiting, 'total_pkr')),
    delayedOrders: delayedOrderIds.length,
    ordersPerMonth: perMonth.map((m) => ({
      ...m,
      intlPct: Math.round((m.international / maxMonth) * 100),
      pkPct: Math.round((m.pakistan / maxMonth) * 100),
    })),
    whereOrdersShip: countries.map((c) => ({ ...c, pct: Math.round((c.count / maxCountry) * 100) })),
    ordersByStatus: statusBars.map((s) => ({ ...s, pct: Math.round((s.count / maxStatus) * 100) })),
    needsAction,
  });
});

// ─────────────────────────────── Orders ───────────────────────────────

const ADMIN_UNIT_DETAIL = '*, size_chart:size_charts(id, name, person_name, variation, nearest_size, measurements, notes, notes_audio), picks:order_unit_articles(type:article_types(id, name, sort_order), article:articles(id, name, image_url, customer_price, partner_cost))';

const ADMIN_ORDER_DETAIL = `
  *,
  customer:profiles!orders_customer_id_fkey(id, full_name, email, phone, customer_code, country, city, address),
  courier:couriers!orders_courier_id_fkey(id, name),
  partner:partners!orders_partner_id_fkey(id, name),
  units:order_units!order_units_order_id_fkey(*, size_chart:size_charts(id, name, person_name, variation, nearest_size, measurements, notes, notes_audio), picks:order_unit_articles(type:article_types(id, name, sort_order), article:articles(id, name, image_url, customer_price, partner_cost))),
  events:order_events!order_events_order_id_fkey(id, status, note, created_at),
  invoice:invoices!invoices_order_id_fkey(*, lines:invoice_lines(*)),
  shipment:shipments!shipments_order_id_fkey(*),
  payments:payments!payments_order_id_fkey(*),
  cards:job_cards!job_cards_order_id_fkey(id, unit_id, stage, unit_title, qc_passed, due_date, approval_status, approval_photos, approval_requested_at, approval_decided_at, change_request, change_request_audio, master:team_members!job_cards_master_id_fkey(name), tailor:team_members!job_cards_tailor_id_fkey(name)),
  transfer:transfers!orders_transfer_id_fkey(id, code, status)
`;

/**
 * GET /api/admin/orders?group=all|awaiting_parcel|production|invoice|payment|warehouse|shipped|issues&status=&search&page&limit&sort&dir
 */
export const getAdminOrders = catchAsync(async (req, res) => {
  const q = parseListQuery(req, { defaultLimit: 15, sortable: ['created_at', 'reference', 'customer_name', 'status', 'due_date'] });
  const group = req.query.group || 'all';

  const scope = (query) => {
    if (group === 'issues') return query.eq('has_issue', true).not('status', 'in', '(cancelled,delivered,draft)');
    if (STATUS_GROUPS[group]) return query.in('status', STATUS_GROUPS[group]);
    if (group === 'cancelled') return query.eq('status', 'cancelled');
    return query;
  };

  let query = scope(
    supabaseAdmin
      .from('orders')
      .select('id, reference, brand, status, order_kind, return_unit_id, has_issue, priority, customer_name, customer_code, destination_city, destination_country, due_date, created_at, partner_id, partner:partners!orders_partner_id_fkey(id, name), units:order_units!order_units_order_id_fkey(count)', { count: 'exact' })
  )
    .order(q.sort, { ascending: q.ascending, nullsFirst: false })
    .range(q.from, q.to);
  if (req.query.status && ORDER_STATUSES.includes(req.query.status)) query = query.eq('status', req.query.status);
  // the partner switcher wins over the filter box: it is the tenant the admin is working in
  const partnerFilter = activePartnerOf(req.access) || req.query.partner_id;
  if (partnerFilter === 'none') query = query.is('partner_id', null); // orders waiting for the admin to choose a partner
  else if (partnerFilter) query = query.eq('partner_id', partnerFilter);
  if (q.search) query = query.or(ilikeAny(['reference', 'customer_name', 'customer_code', 'brand', 'brand_order_number', 'tracking_number'], q.search));

  const groups = ['awaiting_parcel', 'production', 'invoice', 'payment', 'warehouse', 'shipped'];
  const countOrders = (withDrafts = false) => {
    const base = inActivePartner(req.access, supabaseAdmin.from('orders').select('id', { count: 'exact', head: true }));
    return withDrafts ? base : base.neq('status', 'draft');
  };
  const [result, ...counts] = await Promise.all([
    query,
    countOrders(true),
    ...groups.map((g) => countOrders().in('status', STATUS_GROUPS[g])),
    countOrders(true).eq('status', 'draft'),
    countOrders().eq('has_issue', true).not('status', 'in', '(cancelled,delivered)'),
    countOrders().eq('status', 'cancelled'),
  ]);

  const rows = await adjustUnitCounts(unwrap(result).map((o) => ({ ...o, units_count: o.units?.[0]?.count ?? 0, units: undefined, status_label: STATUS_LABELS[o.status] })));
  const countMap = { all: counts[0].count || 0, draft: counts[counts.length - 3].count || 0, issues: counts[counts.length - 2].count || 0, cancelled: counts[counts.length - 1].count || 0 };
  groups.forEach((g, i) => (countMap[g] = counts[i + 1].count || 0));
  return sendPage(res, rows, q, result.count, { counts: countMap });
});

export const getAdminOrder = catchAsync(async (req, res) => {
  const order = unwrapOne(await inActivePartner(req.access, supabaseAdmin.from('orders').select(ADMIN_ORDER_DETAIL).eq('id', req.params.id)).maybeSingle(), 'Order not found');
  // an article sent to the Warehouse moves to its return order: it leaves this order's list and the return order lists it
  let units = order.units || [];
  if (order.order_kind === 'return' && order.return_unit_id) {
    const own = (await supabaseAdmin.from('order_units').select(ADMIN_UNIT_DETAIL).eq('id', order.return_unit_id).maybeSingle()).data;
    units = own ? [{ ...own, line_no: 1 }] : [];
  } else {
    const routed = await routedUnitIds(units.map((u) => u.id));
    units = units.filter((u) => !routed.has(u.id));
  }
  return ApiResponse.success(res, await signNoteAudio({
    ...order,
    status_label: STATUS_LABELS[order.status],
    units: units
      .sort((a, b) => a.line_no - b.line_no)
      // admins also see the internal article price
      .map(({ picks, ...rawUnit }) => ({
        ...withSizeSnapshot(rawUnit),
        selected_articles: (picks || [])
          .map((p) => ({ type_name: one(p.type)?.name ?? null, type_sort: one(p.type)?.sort_order ?? 0, name: one(p.article)?.name ?? null, image_url: one(p.article)?.image_url ?? null, customer_price: one(p.article)?.customer_price ?? null, partner_cost: one(p.article)?.partner_cost ?? null }))
          .sort((a, b) => a.type_sort - b.type_sort)
          .map(({ type_sort, ...rest }) => rest),
      })),
    // where each article really is: its production stage, or the order's progress once it left production
    cards: (order.cards || []).map((c) => {
      const d = articleDisplayStatus(order.status, c.stage);
      return { ...c, display_status: d.key, display_label: d.label };
    }),
    events: (order.events || []).sort((a, b) => a.created_at.localeCompare(b.created_at)),
    invoice: one(order.invoice) ? { ...one(order.invoice), lines: (one(order.invoice).lines || []).sort((a, b) => a.sort_order - b.sort_order) } : null,
    shipment: one(order.shipment),
    brand_invoice: await withSignedUrl(order.brand_invoice),
  }));
});

/**
 * GET /api/admin/orders/by-ref/:reference
 */
export const getAdminOrderByRef = catchAsync(async (req, res) => {
  const order = unwrapOne(await inActivePartner(req.access, supabaseAdmin.from('orders').select('id').ilike('reference', req.params.reference)).maybeSingle(), 'Order not found');
  req.params.id = order.id;
  return getAdminOrder(req, res);
});

/**
 * PATCH /api/admin/orders/:id  body: { status?, note?, admin_notes?, due_date?, priority?, has_issue? }
 */
export const updateAdminOrder = catchAsync(async (req, res) => {
  const order = await getOrderOr404(req.params.id);
  if (order.status === 'draft') throw new NotFoundError('Order not found'); // a draft is private to its customer until they submit it
  const b = req.body || {};
  const patch = {};
  if (b.admin_notes !== undefined) patch.admin_notes = String(b.admin_notes || '').slice(0, 4000) || null;
  if (b.due_date !== undefined) patch.due_date = b.due_date || null;
  if (b.priority !== undefined) {
    if (!['normal', 'rush'].includes(b.priority)) throw new BadRequestError('Priority must be normal or rush.');
    patch.priority = b.priority;
  }
  if (b.express_stitching !== undefined) {
    patch.express_stitching = b.express_stitching === true;
    if (!patch.express_stitching) patch.express_days = null;
    else if (b.priority === undefined) patch.priority = 'rush';
  }
  if (b.express_days !== undefined && b.express_stitching !== false) {
    const days = b.express_days === null || b.express_days === '' ? null : Number(b.express_days);
    if (days !== null && (!Number.isInteger(days) || days < 1 || days > 90)) throw new BadRequestError('Priority days must be a whole number from 1 to 90.');
    patch.express_days = days;
    // the due date follows from the days the admin decided, unless they set a date themselves
    if (days !== null && b.due_date === undefined) {
      const start = new Date(order.created_at);
      start.setUTCDate(start.getUTCDate() + days);
      patch.due_date = start.toISOString().slice(0, 10);
    }
  }
  if (b.has_issue !== undefined) patch.has_issue = !!b.has_issue;
  if (b.destination_country !== undefined) patch.destination_country = b.destination_country || null;
  if (b.destination_city !== undefined) patch.destination_city = b.destination_city || null;
  // courier and tracking are optional on a new order; the admin can add or correct them any time
  if (b.tracking_number !== undefined || b.courier_id !== undefined) {
    if (b.tracking_number !== undefined) {
      const tracking = String(b.tracking_number ?? '').trim();
      if (tracking.length > 60) throw new BadRequestError('The tracking number is too long.');
      patch.tracking_number = tracking || null;
    }
    if (b.courier_id !== undefined) {
      patch.courier_id = b.courier_id ? (await resolveCourier({ courier_id: b.courier_id })).id : null;
      patch.courier_name = null;
    }
    patch.shipping_updated_at = new Date().toISOString(); // an older email must not overwrite what the admin just set
  }

  if (Object.keys(patch).length) {
    unwrap(await supabaseAdmin.from('orders').update({ ...patch, updated_at: new Date().toISOString() }).eq('id', order.id));
    if (patch.due_date !== undefined || patch.priority !== undefined) {
      const cardPatch = {};
      if (patch.due_date !== undefined) cardPatch.due_date = patch.due_date;
      if (patch.priority !== undefined) cardPatch.priority = patch.priority;
      await supabaseAdmin.from('job_cards').update(cardPatch).eq('order_id', order.id).neq('stage', 'packed');
    }
  }

  if (b.status && b.status !== order.status) {
    if (!ORDER_STATUSES.includes(b.status)) throw new BadRequestError('Unknown status.');
    const note = String(b.note || '').trim() || `Status changed by admin to "${STATUS_LABELS[b.status]}"`;
    const extra = {};
    if (b.status === 'delivered') extra.delivered_at = new Date().toISOString();
    if (b.status === 'shipped') extra.shipped_at = new Date().toISOString();
    await setOrderStatus(order.id, b.status, { note, actorId: req.userId, extra });
    if (b.notifyCustomer !== false) {
      await notifyUser(order.customer_id, {
        type: b.status === 'cancelled' ? 'alert' : 'update',
        title: `${order.reference}: ${STATUS_LABELS[b.status]}`,
        body: note,
        link: `/app/orders/${order.id}`,
        orderId: order.id,
      });
    }
  } else if (b.note) {
    await addEvent(order.id, order.status, String(b.note).slice(0, 1000), req.userId);
  }

  req.params.id = order.id;
  return getAdminOrder(req, res);
});

/**
 * POST /api/admin/orders/:id/units/:unitId/resolve — issue sorted out, unit can go to production
 */
export const resolveUnitIssue = catchAsync(async (req, res) => {
  const unit = unwrapOne(await supabaseAdmin.from('order_units').select('*').eq('id', req.params.unitId).eq('order_id', req.params.id).maybeSingle(), 'Unit not found');
  if (unit.status !== 'issue') throw new BadRequestError('This unit has no open issue.');
  unwrap(await supabaseAdmin.from('order_units').update({ status: 'received', received_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq('id', unit.id));
  const order = await getOrderOr404(req.params.id);
  await addEvent(order.id, order.status, `Issue resolved for "${unit.unit_title}"${req.body?.note ? `: ${req.body.note}` : ''}`, req.userId);
  await logUnitEvent(unit.id, order.id, 'issue_resolved', { actorId: req.userId });
  await logUnitEvent(unit.id, order.id, 'received', { actorId: req.userId });
  await syncReceiving(order.id, req.userId);
  return ApiResponse.success(res, null, 'Issue resolved. The unit is now in production.');
});

// ─────────────────────────────── Customers ───────────────────────────────

/**
 * GET /api/admin/customers?search&page&limit&sort
 */
export const getAdminCustomers = catchAsync(async (req, res) => {
  const q = parseListQuery(req, { defaultLimit: 15, sortable: ['created_at', 'full_name', 'customer_code', 'country'] });
  let query = supabaseAdmin
    .from('profiles')
    .select('id, full_name, email, phone, customer_code, country, city, address, created_at, is_active', { count: 'exact' })
    .eq('role', 'customer')
    .order(q.sort, { ascending: q.ascending, nullsFirst: false })
    .range(q.from, q.to);
  if (q.search) query = query.or(ilikeAny(['full_name', 'email', 'phone', 'customer_code', 'city', 'country'], q.search));
  if (req.query.country) query = query.ilike('country', String(req.query.country));

  const result = await query;
  const customers = unwrap(result);
  const ids = customers.map((c) => c.id);

  let stats = {};
  if (ids.length) {
    const orders = unwrap(await supabaseAdmin.from('orders').select('id, customer_id, status, created_at').in('customer_id', ids));
    const orderOwner = Object.fromEntries(orders.map((o) => [o.id, o.customer_id]));
    const paid = orders.length
      ? unwrap(await supabaseAdmin.from('invoices').select('order_id, total_pkr').eq('status', 'paid').in('order_id', orders.map((o) => o.id)))
      : [];
    for (const o of orders.filter((x) => x.status !== 'draft')) {
      const s = (stats[o.customer_id] ||= { total_orders: 0, active_orders: 0, total_spent_pkr: 0, last_order_at: null });
      s.total_orders++;
      if (STATUS_GROUPS.active.includes(o.status)) s.active_orders++;
      if (!s.last_order_at || o.created_at > s.last_order_at) s.last_order_at = o.created_at;
    }
    for (const inv of paid) {
      const cid = orderOwner[inv.order_id];
      if (!cid) continue;
      (stats[cid] ||= { total_orders: 0, active_orders: 0, total_spent_pkr: 0, last_order_at: null }).total_spent_pkr += Number(inv.total_pkr || 0);
    }
  }

  return sendPage(res, customers.map((c) => ({ ...c, ...(stats[c.id] || { total_orders: 0, active_orders: 0, total_spent_pkr: 0, last_order_at: null }) })), q, result.count);
});

export const getAdminCustomer = catchAsync(async (req, res) => {
  const customer = unwrapOne(await supabaseAdmin.from('profiles').select('*').eq('id', req.params.id).maybeSingle(), 'Customer not found');
  const [orders, sizes] = await Promise.all([
    supabaseAdmin.from('orders').select('id, reference, brand, status, created_at, units:order_units!order_units_order_id_fkey(count)').eq('customer_id', customer.id).neq('status', 'draft').order('created_at', { ascending: false }).limit(50),
    supabaseAdmin.from('size_charts').select('id, name, person_name, variation, measurements, notes, updated_at').eq('user_id', customer.id),
  ]);
  return ApiResponse.success(res, {
    ...customer,
    orders: unwrap(orders).map((o) => ({ ...o, units_count: o.units?.[0]?.count ?? 0, units: undefined, status_label: STATUS_LABELS[o.status] })),
    size_charts: unwrap(sizes),
  });
});

// ─────────────────────────────── Users & roles ───────────────────────────────

/**
 * GET /api/admin/users?role=admin|partner_staff|customer|requests&search&page
 */
export const getUsers = catchAsync(async (req, res) => {
  const q = parseListQuery(req, { defaultLimit: 15, sortable: ['created_at', 'full_name', 'email', 'role'] });
  let query = supabaseAdmin
    .from('profiles')
    .select('id, full_name, email, phone, role, customer_code, is_active, partner_id, partner_role, job_title, permissions, created_at, partner:partners!profiles_partner_id_fkey(id, name)', { count: 'exact' })
    .order(q.sort, { ascending: q.ascending })
    .range(q.from, q.to);
  const role = req.query.role;
  if (role === 'staff') query = query.in('role', ['admin', 'partner_staff']);
  else if (['admin', 'partner_staff', 'customer'].includes(role)) query = query.eq('role', role);
  if (q.search) query = query.or(ilikeAny(['full_name', 'email', 'customer_code', 'phone', 'job_title'], q.search));

  const result = await query;
  // an admin row says how much of the admin portal that person may use (permissions of other roles are not sent on)
  const rows = unwrap(result).map(({ permissions, ...u }) => {
    if (u.role !== 'admin') return u;
    const modules = adminModulesOf({ role: 'admin', permissions });
    const actions = adminActionsOf({ role: 'admin', permissions });
    return { ...u, admin_access: modules ? 'restricted' : 'full', admin_modules: modules, admin_actions: actions ? Object.fromEntries([...actions].map(([m, set]) => [m, [...set]])) : null, role_ids: roleIdsOf(permissions) };
  });
  return sendPage(res, rows, q, result.count);
});

/** The partner a Google sign-up created and then left behind (no users, team, orders or modules) is removed with its owner's promotion. */
const dropPartnerIfEmpty = async (partnerId) => {
  if (!partnerId) return;
  const head = (table) => supabaseAdmin.from(table).select('id', { count: 'exact', head: true }).eq('partner_id', partnerId);
  const [users, team, orders, partner] = await Promise.all([
    head('profiles'), head('team_members'), head('orders'),
    supabaseAdmin.from('partners').select('permissions, is_default').eq('id', partnerId).maybeSingle(),
  ]);
  const empty = !users.count && !team.count && !orders.count && !(partner.data?.permissions || []).length && !partner.data?.is_default;
  if (empty) await supabaseAdmin.from('partners').delete().eq('id', partnerId);
};

/**
 * PATCH /api/admin/users/:id/role  body: { role }
 */
export const setUserRole = catchAsync(async (req, res) => {
  const role = req.body?.role;
  if (role === 'partner_staff') throw new BadRequestError('Partner users are created under their partner: Partners > choose the partner > Users.');
  if (!['customer', 'admin'].includes(role)) throw new BadRequestError('Role must be customer or admin.');
  if (req.params.id === req.userId) throw new ForbiddenError('You cannot change your own role.');
  const current = unwrapOne(await supabaseAdmin.from('profiles').select('id, role, partner_role').eq('id', req.params.id).maybeSingle(), 'User not found');
  // an owner can be promoted to admin (e.g. someone who signed up with Google), but not demoted to a customer while they own a partner
  if (current.partner_role === 'owner' && role !== 'admin') throw new BadRequestError('This is a partner owner. Switch the partner off or change its owner instead.');
  const { data: before } = await supabaseAdmin.from('profiles').select('partner_id, partner_role').eq('id', req.params.id).maybeSingle();
  // leaving a partner removes every partner link and permission
  const updated = await UserModel.setRole(req.params.id, role, { partner_id: null, partner_role: null, permissions: [], job_title: null, staff_type: null });
  if (before?.partner_role === 'owner') await dropPartnerIfEmpty(before.partner_id);
  await notifyUser(updated.id, {
    type: 'update',
    title: 'Your access was updated',
    body: role === 'customer' ? 'Your staff access was removed.' : 'You now have admin access. Log out and in again if pages look out of date.',
    link: role === 'admin' ? '/admin/overview' : null,
  });
  return ApiResponse.success(res, updated, `Role updated to ${role}.`);
});

export const setUserActive = catchAsync(async (req, res) => {
  if (req.params.id === req.userId) throw new ForbiddenError('You cannot deactivate yourself.');
  const isActive = !!req.body?.is_active;
  const updated = unwrapOne(
    await supabaseAdmin.from('profiles').update({ is_active: isActive, updated_at: new Date().toISOString() }).eq('id', req.params.id).select('*').maybeSingle(),
    'User not found'
  );
  invalidateProfile(updated.id);
  return ApiResponse.success(res, updated, isActive ? 'Account activated.' : 'Account deactivated.');
});

// ─────────────────────────────── Reports ───────────────────────────────

/**
 * GET /api/admin/reports?months=6
 */
export const getAdminReports = catchAsync(async (req, res) => {
  const months = Math.min(24, Math.max(1, parseInt(req.query.months, 10) || 6));
  const since = startOfMonthISO(months - 1);
  const [invoices, orders] = await Promise.all([
    inActivePartner(req.access, supabaseAdmin.from('invoices').select('total_pkr, partner_total_pkr, discount_pkr, paid_at, order:orders!invoices_order_id_fkey!inner(partner_id), lines:invoice_lines(kind, customer_amount, partner_amount)').eq('status', 'paid').gte('paid_at', since), 'order.partner_id'),
    inActivePartner(req.access, supabaseAdmin.from('orders').select('brand, destination_country, created_at, packed_at, shipped_at, status').neq('status', 'draft').gte('created_at', since)),
  ]);
  const inv = unwrap(invoices);
  const ords = unwrap(orders);

  const monthly = [];
  for (let i = months - 1; i >= 0; i--) {
    const d = new Date(startOfMonthISO(i));
    const key = d.toISOString().slice(0, 7);
    const rows = inv.filter((r) => (r.paid_at || '').startsWith(key));
    const revenue = sum(rows, 'total_pkr');
    const payout = sum(rows, 'partner_total_pkr');
    monthly.push({ key, month: d.toLocaleString('en-GB', { month: 'short', year: '2-digit', timeZone: 'UTC' }), revenue: round2(revenue), payout: round2(payout), margin: round2(revenue - payout), orders: ords.filter((o) => o.created_at.startsWith(key)).length });
  }
  const maxRevenue = Math.max(1, ...monthly.map((m) => m.revenue));

  const byKind = {};
  for (const i of inv) for (const l of i.lines || []) {
    const k = (byKind[l.kind] ||= { kind: l.kind, customer: 0, partner: 0 });
    k.customer += Number(l.customer_amount || 0);
    k.partner += Number(l.partner_amount || 0);
  }
  const tally = (key) => Object.entries(ords.reduce((acc, o) => ((acc[o[key] || 'Unknown'] = (acc[o[key] || 'Unknown'] || 0) + 1), acc), {}))
    .map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count).slice(0, 8);
  const turnaround = ords.filter((o) => o.shipped_at).map((o) => (new Date(o.shipped_at) - new Date(o.created_at)) / 86_400_000);

  const revenue = sum(inv, 'total_pkr');
  const payout = sum(inv, 'partner_total_pkr');
  return ApiResponse.success(res, {
    months,
    totals: {
      revenuePkr: round2(revenue),
      partnerPayoutPkr: round2(payout),
      marginPkr: round2(revenue - payout),
      marginPct: revenue ? Math.round(((revenue - payout) / revenue) * 100) : 0,
      discountsPkr: round2(sum(inv, 'discount_pkr')),
      paidInvoices: inv.length,
      orders: ords.length,
      cancelled: ords.filter((o) => o.status === 'cancelled').length,
      avgTurnaroundDays: turnaround.length ? Math.round(turnaround.reduce((a, b) => a + b, 0) / turnaround.length) : null,
    },
    monthly: monthly.map((m) => ({ ...m, pct: Math.round((m.revenue / maxRevenue) * 100) })),
    byChargeType: Object.values(byKind).map((k) => ({ ...k, customer: round2(k.customer), partner: round2(k.partner), margin: round2(k.customer - k.partner) })),
    topBrands: tally('brand'),
    topCountries: tally('destination_country'),
  });
});

/**
 * GET /api/admin/badges — sidebar counters
 */
export const getAdminBadges = catchAsync(async (req, res) => {
  const head = (table) => inActivePartner(req.access, supabaseAdmin.from(table).select('id', { count: 'exact', head: true }));
  const [invoices, needsLabel, transfers, issues, messages] = await Promise.all([
    head('orders').eq('status', 'packed'),
    inActivePartner(req.access, supabaseAdmin.from('shipments').select('id, order:orders!shipments_order_id_fkey!inner(partner_id)', { count: 'exact', head: true }).eq('shipped_from', 'admin_warehouse').in('status', ['needs_label', 'labelled']), 'order.partner_id'),
    head('transfers').eq('status', 'in_transit'),
    head('orders').eq('has_issue', true).not('status', 'in', '(cancelled,delivered)'),
    unreadConversationCount(activePartnerOf(req.access)),
  ]);
  return ApiResponse.success(res, {
    messages,
    invoices: invoices.count || 0,
    warehouse: (needsLabel.count || 0) + (transfers.count || 0),
    orders: issues.count || 0,
    settings: 0,
  });
});

// ─────────────────────────────── Ship-to address ───────────────────────────────

/** GET /api/admin/settings/ship-to — the address customers ship parcels to */
export const getShipTo = catchAsync(async (req, res) => {
  const a = await loadShipTo();
  return ApiResponse.success(res, { name: a.shipToName, address: a.shipToAddress, city: a.shipToCity, phone: a.shipToPhone });
});

/** PUT /api/admin/settings/ship-to  body: { name, address, city, phone } */
export const setShipTo = catchAsync(async (req, res) => {
  const b = req.body || {};
  if (!String(b.address ?? '').trim()) throw new BadRequestError('Enter the street address.');
  if (!String(b.city ?? '').trim()) throw new BadRequestError('Enter the city.');
  const a = await saveShipTo(b, req.userId).catch(() => {
    throw new BadRequestError('Could not save. Run the latest database update (0008) first.');
  });
  return ApiResponse.success(res, { name: a.shipToName, address: a.shipToAddress, city: a.shipToCity, phone: a.shipToPhone }, 'Address saved. Customers now see it.');
});


// ─────────────────────────────── Priority stitching ───────────────────────────────

/** GET /api/admin/settings/express-stitching -> { enabled, days } */
export const getExpressStitching = catchAsync(async (req, res) => ApiResponse.success(res, await loadExpressStitching()));

/** PUT /api/admin/settings/express-stitching  body: { enabled, days } */
export const setExpressStitching = catchAsync(async (req, res) => {
  const b = req.body || {};
  const days = Number(b.days);
  if (!Number.isInteger(days) || days < 1 || days > 90) throw new BadRequestError('Days must be a whole number from 1 to 90.');
  const saved = await saveExpressStitching(b, req.userId);
  return ApiResponse.success(res, saved, 'Priority stitching saved. Customers now see it when they create an order.');
});


// ─────────────────────────────── Fast shipping ───────────────────────────────

/** GET /api/admin/settings/express-shipping -> { enabled, days } */
export const getExpressShipping = catchAsync(async (req, res) => ApiResponse.success(res, await loadExpressShipping()));

/** PUT /api/admin/settings/express-shipping  body: { enabled, days }: Fast shipping has no price */
export const setExpressShipping = catchAsync(async (req, res) => {
  const b = req.body || {};
  const days = Number(b.days);
  if (!Number.isInteger(days) || days < 1 || days > 90) throw new BadRequestError('Days must be a whole number from 1 to 90.');
  const saved = await saveExpressShipping(b, req.userId);
  return ApiResponse.success(res, saved, 'Fast shipping saved. Customers now see it when they create an order.');
});


// ─────────────────────────────── PostEx connection ───────────────────────────────

/** GET /api/admin/settings/postex — the PostEx settings (the token is never returned, only its last 4 characters). */
export const getPostexSettings = catchAsync(async (req, res) => ApiResponse.success(res, postexSettingsView()));

/** PUT /api/admin/settings/postex  body: { token?, clearToken?, baseUrl?, pickupAddressCode?, storeAddressCode?, orderType?, pollMinutes? } */
export const setPostexSettings = catchAsync(async (req, res) => {
  try {
    const view = await savePostexSettings(req.body || {}, req.userId);
    return ApiResponse.success(res, view, view.configured ? 'PostEx saved. Warehouse bookings and tracking now use it.' : 'PostEx saved. It is not connected: no token is set.');
  } catch (e) {
    if (e?.name === 'PostexError') throw new BadRequestError(e.message);
    throw e;
  }
});

/** POST /api/admin/settings/postex/test — ask PostEx for its operational cities: proves the token and the address work. */
export const testPostexSettings = catchAsync(async (req, res) => {
  if (!postexSettingsView().configured) throw new BadRequestError('Save the PostEx token first.');
  try {
    await getOperationalCities();
  } catch (e) {
    throw new BadRequestError(`PostEx did not accept the connection: ${e?.message || 'no answer'}.`);
  }
  return ApiResponse.success(res, { ok: true }, 'PostEx answered. The token works.');
});

/** GET /api/admin/settings/postex/addresses — the pickup / return addresses of the PostEx account, with the codes PostEx accepts. */
export const getPostexAddresses = catchAsync(async (req, res) => {
  if (!postexSettingsView().configured) throw new BadRequestError('Save the PostEx token first.');
  try {
    return ApiResponse.success(res, await listMerchantAddresses());
  } catch (e) {
    throw new BadRequestError(`PostEx did not return your addresses: ${e?.message || 'no answer'}.`);
  }
});
