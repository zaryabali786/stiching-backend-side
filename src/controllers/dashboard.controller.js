import { supabaseAdmin } from '../config/supabase.js';
import { catchAsync, ApiResponse, BadRequestError } from '../utils/error.helper.js';
import { unwrap, todayISO, daysAgoISO, startOfMonthISO, sum, round2 } from '../utils/db.js';
import { STATUS_GROUPS, STATUS_LABELS } from '../services/order.service.js';
import { inActivePartner } from '../services/access.service.js';

const isPakistan = (country) => /^(pk|pakistan)$/i.test(String(country || '').trim());
const PERIODS = [7, 30, 90, 180, 365];
const DAY = 86_400_000;

/** Split [since, now] into daily buckets (up to 90 days) or weekly buckets (longer). */
const makeBuckets = (days) => {
  const step = days <= 90 ? 1 : 7;
  const count = Math.ceil(days / step);
  const start = new Date(daysAgoISO(days)).getTime();
  const buckets = Array.from({ length: count }, (_, i) => {
    const d = new Date(start + i * step * DAY);
    return { label: d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' }), value: 0, amount: 0 };
  });
  const indexOf = (iso) => {
    const i = Math.floor((new Date(iso).getTime() - start) / (step * DAY));
    return i >= 0 && i < count ? i : -1;
  };
  return { buckets, indexOf };
};

const tally = (rows, pick, limit = 8) =>
  Object.entries(rows.reduce((acc, r) => ((acc[pick(r) || 'Unknown'] = (acc[pick(r) || 'Unknown'] || 0) + 1), acc), {}))
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, limit);

/**
 * GET /api/admin/dashboard?days=7|30|90|180|365
 * One call with every number the customizable dashboard can show; the page picks what its widgets need.
 */
export const getDashboard = catchAsync(async (req, res) => {
  const days = PERIODS.includes(Number(req.query.days)) ? Number(req.query.days) : 30;
  const since = daysAgoISO(days);
  const prevSince = daysAgoISO(days * 2);
  const sixMonths = startOfMonthISO(5);
  const scoped = (q, col) => inActivePartner(req.access, q, col);

  const [orderRows, openRows, paidInvoices, issuedInvoices, delayedCards, transfers, recent, profiles, partners] = await Promise.all([
    scoped(supabaseAdmin.from('orders').select('id, reference, brand, customer_id, customer_name, destination_country, status, has_issue, created_at, shipped_at, delivered_at, partner_id').gte('created_at', prevSince).neq('status', 'draft')),
    scoped(supabaseAdmin.from('orders').select('status, has_issue, partner_id').not('status', 'in', '(cancelled,draft,delivered)')),
    scoped(supabaseAdmin.from('invoices').select('total_pkr, partner_total_pkr, discount_pkr, paid_at, order:orders!invoices_order_id_fkey!inner(partner_id), lines:invoice_lines(kind, customer_amount, partner_amount)').eq('status', 'paid').gte('paid_at', prevSince), 'order.partner_id'),
    scoped(supabaseAdmin.from('invoices').select('total_pkr, order:orders!invoices_order_id_fkey!inner(partner_id)').eq('status', 'issued'), 'order.partner_id'),
    scoped(supabaseAdmin.from('job_cards').select('order_id').lt('due_date', todayISO()).neq('stage', 'packed')),
    scoped(supabaseAdmin.from('transfers').select('id, code, orders:orders!orders_transfer_id_fkey(id)').eq('status', 'in_transit')),
    scoped(supabaseAdmin.from('orders').select('id, reference, brand, customer_name, status, created_at, destination_country').neq('status', 'draft').order('created_at', { ascending: false }).limit(8)),
    supabaseAdmin.from('profiles').select('created_at').eq('role', 'customer').gte('created_at', sixMonths),
    supabaseAdmin.from('partners').select('id, name').eq('status', 'active'),
  ]);

  const inPeriod = unwrap(orderRows).filter((o) => o.created_at >= since);
  const previous = unwrap(orderRows).filter((o) => o.created_at < since);
  const live = inPeriod.filter((o) => o.status !== 'cancelled');
  const open = unwrap(openRows);
  const countIn = (group) => open.filter((o) => group.includes(o.status)).length;
  const paid = unwrap(paidInvoices);
  const paidNow = paid.filter((i) => i.paid_at >= since);
  const paidPrev = paid.filter((i) => i.paid_at < since);
  const awaiting = unwrap(issuedInvoices);
  const delayedOrderIds = [...new Set(unwrap(delayedCards).map((c) => c.order_id))];

  const revenue = sum(paidNow, 'total_pkr');
  const payout = sum(paidNow, 'partner_total_pkr');
  const prevRevenue = sum(paidPrev, 'total_pkr');
  const turnaround = live.filter((o) => o.shipped_at).map((o) => (new Date(o.shipped_at) - new Date(o.created_at)) / DAY);
  const uniqueCustomers = new Set(live.map((o) => o.customer_id)).size;
  const pct = (now, before) => (before ? Math.round(((now - before) / before) * 100) : null);

  // Trends over the chosen period
  const ordersTrend = makeBuckets(days);
  for (const o of live) {
    const i = ordersTrend.indexOf(o.created_at);
    if (i >= 0) ordersTrend.buckets[i].value += 1;
  }
  const revenueTrend = makeBuckets(days);
  for (const inv of paidNow) {
    const i = revenueTrend.indexOf(inv.paid_at);
    if (i >= 0) revenueTrend.buckets[i].value += Number(inv.total_pkr || 0);
  }
  revenueTrend.buckets.forEach((b) => (b.value = round2(b.value)));

  // Last six months, international vs Pakistan, new customers
  const sixOrders = unwrap(await scoped(supabaseAdmin.from('orders').select('created_at, destination_country').gte('created_at', sixMonths).not('status', 'in', '(cancelled,draft)')));
  const customersSince = unwrap(profiles);
  const ordersPerMonth = [];
  const signupsPerMonth = [];
  for (let i = 5; i >= 0; i--) {
    const d = new Date(startOfMonthISO(i));
    const key = d.toISOString().slice(0, 7);
    const month = d.toLocaleString('en-GB', { month: 'short', timeZone: 'UTC' });
    const inMonth = sixOrders.filter((o) => o.created_at.startsWith(key));
    ordersPerMonth.push({ month, international: inMonth.filter((o) => !isPakistan(o.destination_country)).length, pakistan: inMonth.filter((o) => isPakistan(o.destination_country)).length });
    signupsPerMonth.push({ label: month, value: customersSince.filter((c) => c.created_at.startsWith(key)).length });
  }

  const byKind = {};
  for (const inv of paidNow) for (const l of inv.lines || []) byKind[l.kind] = (byKind[l.kind] || 0) + Number(l.customer_amount || 0);

  const stage = (key, label, group) => ({ key, label, value: countIn(group) });
  const ordersByStatus = [
    stage('awaiting_parcel', 'Awaiting parcel', STATUS_GROUPS.awaiting_parcel),
    stage('production', 'In production', STATUS_GROUPS.production),
    stage('invoice', 'Waiting for invoice', STATUS_GROUPS.invoice),
    stage('payment', 'Awaiting payment', STATUS_GROUPS.payment),
    stage('warehouse', 'Paid · to dispatch', STATUS_GROUPS.warehouse),
    stage('shipped', 'Shipped', ['shipped']),
  ];

  const partnerList = unwrap(partners);
  const partnerLoad = partnerList
    .map((p) => ({ name: p.name, value: open.filter((o) => o.partner_id === p.id).length }))
    .filter((p) => p.value > 0)
    .sort((a, b) => b.value - a.value);

  // Needs action
  const packed = unwrap(await scoped(supabaseAdmin.from('orders').select('id, reference, customer_name').eq('status', 'packed').order('packed_at').limit(5)));
  const issues = unwrap(await scoped(supabaseAdmin.from('orders').select('id, reference, customer_name').eq('has_issue', true).not('status', 'in', '(cancelled,delivered)').limit(5)));
  const delayed = delayedOrderIds.length ? unwrap(await supabaseAdmin.from('orders').select('id, reference, customer_name, due_date').in('id', delayedOrderIds.slice(0, 5))) : [];
  const needsAction = [
    ...packed.map((o) => ({ id: `inv_${o.id}`, tag: 'Invoice', tone: 'amber', code: o.reference, title: o.customer_name, subtext: 'Packed at partner · issue the invoice', link: '/admin/invoices', queryParams: { order: o.id } })),
    ...unwrap(transfers).map((t) => ({ id: `tr_${t.id}`, tag: 'Incoming', tone: 'purple', code: t.code, title: `${t.orders?.length || 0} parcel(s)`, subtext: 'On the way from partner', link: '/admin/warehouse', queryParams: { tab: 'transfers' } })),
    ...issues.map((o) => ({ id: `iss_${o.id}`, tag: 'Issue', tone: 'red', code: o.reference, title: o.customer_name, subtext: 'Issue reported at receiving', link: '/admin/orders', queryParams: { ref: o.reference } })),
    ...delayed.map((o) => ({ id: `del_${o.id}`, tag: 'Delayed', tone: 'red', code: o.reference, title: o.customer_name, subtext: `Was due ${o.due_date}`, link: '/admin/orders', queryParams: { ref: o.reference } })),
  ];

  return ApiResponse.success(res, {
    days,
    kpis: {
      orders: live.length,
      ordersChangePct: pct(live.length, previous.filter((o) => o.status !== 'cancelled').length),
      revenue: round2(revenue),
      revenueChangePct: pct(revenue, prevRevenue),
      payout: round2(payout),
      margin: round2(revenue - payout),
      marginPct: revenue ? Math.round(((revenue - payout) / revenue) * 100) : 0,
      avgOrderValue: paidNow.length ? round2(revenue / paidNow.length) : 0,
      paidInvoices: paidNow.length,
      newCustomers: customersSince.filter((c) => c.created_at >= since).length,
      activeCustomers: uniqueCustomers,
      delivered: live.filter((o) => o.status === 'delivered').length,
      cancelled: inPeriod.filter((o) => o.status === 'cancelled').length,
      international: live.filter((o) => !isPakistan(o.destination_country)).length,
      inProduction: countIn(STATUS_GROUPS.production),
      waitingForInvoice: countIn(STATUS_GROUPS.invoice),
      awaitingPayment: countIn(STATUS_GROUPS.payment),
      awaitingPaymentPkr: round2(sum(awaiting, 'total_pkr')),
      openIssues: open.filter((o) => o.has_issue).length,
      delayed: delayedOrderIds.length,
      avgTurnaroundDays: turnaround.length ? Math.round(turnaround.reduce((a, b) => a + b, 0) / turnaround.length) : null,
    },
    ordersTrend: ordersTrend.buckets.map(({ label, value }) => ({ label, value })),
    revenueTrend: revenueTrend.buckets.map(({ label, value }) => ({ label, value })),
    ordersPerMonth,
    signupsPerMonth,
    ordersByStatus,
    partnerLoad,
    topBrands: tally(live, (o) => o.brand).map((r) => ({ label: r.name, value: r.count })),
    topCountries: tally(live, (o) => o.destination_country).map((r) => ({ label: r.name, value: r.count })),
    chargeTypes: Object.entries(byKind).map(([label, value]) => ({ label, value: round2(value) })).sort((a, b) => b.value - a.value),
    statusMix: tally(live, (o) => STATUS_LABELS[o.status] || o.status).map((r) => ({ label: r.name, value: r.count })),
    recentOrders: unwrap(recent),
    needsAction,
  });
});

// ───────────── each admin's own dashboard layout ─────────────

const SIZES = ['s', 'm', 'l', 'xl'];
const layoutKey = (userId) => `dashboard_layout:${userId}`;

const cleanLayout = (input) => {
  if (!Array.isArray(input)) throw new BadRequestError('The layout must be a list of widgets.');
  if (input.length > 40) throw new BadRequestError('A dashboard can hold up to 40 widgets.');
  return input.map((w) => {
    const id = String(w?.id ?? '').slice(0, 60);
    const type = String(w?.type ?? '').slice(0, 40);
    if (!id || !/^[a-z0-9_]+$/.test(type)) throw new BadRequestError('A widget in the layout is not valid.');
    return { id, type, size: SIZES.includes(w.size) ? w.size : 'm' };
  });
};

export const getDashboardLayout = catchAsync(async (req, res) => {
  const { data } = await supabaseAdmin.from('platform_settings').select('value').eq('key', layoutKey(req.userId)).maybeSingle();
  return ApiResponse.success(res, { widgets: Array.isArray(data?.value?.widgets) ? data.value.widgets : null });
});

export const setDashboardLayout = catchAsync(async (req, res) => {
  const widgets = cleanLayout(req.body?.widgets);
  const { error } = await supabaseAdmin
    .from('platform_settings')
    .upsert({ key: layoutKey(req.userId), value: { widgets }, updated_by: req.userId, updated_at: new Date().toISOString() });
  if (error) throw new BadRequestError('Could not save your dashboard.');
  return ApiResponse.success(res, { widgets }, 'Dashboard saved.');
});

export const resetDashboardLayout = catchAsync(async (req, res) => {
  await supabaseAdmin.from('platform_settings').delete().eq('key', layoutKey(req.userId));
  return ApiResponse.success(res, { widgets: null }, 'Dashboard reset.');
});
