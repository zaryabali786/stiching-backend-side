import { attachCodSummary } from '../services/cod-payment.service.js';
import { supabaseAdmin } from '../config/supabase.js';
import { catchAsync, ApiResponse, BadRequestError, ConflictError, ForbiddenError } from '../utils/error.helper.js';
import { createUser, updateUser, setMemberUser } from '../services/partner-users.service.js';
import { UserModel } from '../models/user.model.js';
import { invalidateProfile } from '../middlewares/auth.middleware.js';
import { parseListQuery, sendPage, ilikeAny } from '../utils/pagination.js';
import { unwrap, unwrapOne, todayISO, daysAgoISO, startOfMonthISO, sum, round2 } from '../utils/db.js';
import { syncReceiving, setOrderStatus, addEvent, getOrderOr404, STATUS_LABELS } from '../services/order.service.js';
import { getTeamWithLoad, suggestAssignees } from '../services/team.service.js';
import { uploadDataUrls } from '../services/storage.service.js';
import { STAGE_LABELS, articleGroup, groupReference } from '../services/unit-flow.service.js';
import { resubmitCorrected, receiveCorrectedHold, requestIssueDecision } from '../services/unit-review.service.js';
import { cnSlipsHtml } from '../services/cn-slip.service.js';
import { loadOrderArticles, cnRemarks, orderListHtml } from '../services/order-list.service.js';
import { parseWeight, saveUnitWeight, orderWeightInfo, syncOrderWeight } from '../services/weight.service.js';
import { createReturnOrder, returnOrdersForUnits, adjustUnitCounts } from '../services/return-order.service.js';
import { addOrderToTransfer } from '../services/transfer.service.js';
import { postexConfigured, getOperationalCities, airwayBillPdf } from '../services/postex.service.js';
import { syncPostexShipment, syncPostexReturn } from '../services/postex-tracking.service.js';
import { bookDispatch, setDispatchCn, cancelDispatchBooking, createDispatchLoadsheet, markDownloaded, confirmDispatchHandover, recordDispatchTracking, confirmReturnedToPartner, dispatchEventsFor } from '../services/dispatch-shipment.service.js';
import { bookReturn, cancelBooking, createLoadsheet, confirmHandover, loadsheetCsv, recordTracking, shipmentsForUnits } from '../services/return-shipment.service.js';
import { notifyAdmins, notifyUser, notifyPartner } from '../services/notification.service.js';
import { unreadConversationCount } from '../services/chat.service.js';
import { cleanVoiceNote } from '../services/voice-note.service.js';
import { logUnitEvent } from '../services/order.service.js';
import { resolveCourier } from '../services/courier.service.js';
import { scoped, scopeOf, can, partnerForWrite, assertOrderAccess, assertMemberOfPartner } from '../services/access.service.js';

const one = (v) => (Array.isArray(v) ? v[0] ?? null : v ?? null);

/**
 * Invoices of the caller's partner (an invoice belongs to the partner of its order). Admins get all of them.
 * Adds an `owner` embed that is only used for the partner filter.
 */
const partnerInvoices = (access, columns, options) => {
  let query = supabaseAdmin.from('invoices').select(`${columns}, owner:orders!invoices_order_id_fkey!inner(partner_id)`, options);
  const partnerId = scopeOf(access);
  if (partnerId !== undefined) query = query.eq('owner.partner_id', partnerId);
  return query;
};

// ─────────────────────────────── Overview ───────────────────────────────

/**
 * GET /api/partner/overview?range=today|14days|30days
 */
export const getPartnerOverview = catchAsync(async (req, res) => {
  const range = ['today', '14days', '30days'].includes(req.query.range) ? req.query.range : '14days';
  const days = range === '30days' ? 30 : range === '14days' ? 14 : 7;
  const today = todayISO();

  const [cards, team, warehouseOrders, paidThisMonth] = await Promise.all([
    scoped(req.access, supabaseAdmin.from('job_cards').select('stage, priority, due_date, packed_at, qc_at, tailor_id, master_id')),
    getTeamWithLoad({ partnerId: scopeOf(req.access) }),
    scoped(req.access, supabaseAdmin.from('orders').select('status').in('status', ['packed', 'invoice_issued', 'awaiting_payment', 'paid']).is('partner_route', null)),
    partnerInvoices(req.access, 'partner_total_pkr').eq('status', 'paid').gte('paid_at', startOfMonthISO(0)),
  ]);
  const allCards = unwrap(cards);
  const whOrders = unwrap(warehouseOrders);

  const active = allCards.filter((c) => c.stage !== 'packed');
  const dueToday = active.filter((c) => c.due_date === today);
  const packedRecent = allCards.filter((c) => c.packed_at && c.packed_at >= daysAgoISO(30));
  const onTime = packedRecent.filter((c) => !c.due_date || c.packed_at.slice(0, 10) <= c.due_date).length;

  // Articles finished per day
  const daily = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() - i);
    const key = d.toISOString().slice(0, 10);
    daily.push({
      date: key,
      day: i === 0 ? 'Today' : String(d.getUTCDate()),
      count: allCards.filter((c) => (c.packed_at || '').startsWith(key)).length,
      isToday: i === 0,
    });
  }
  const tailorCapacity = team.members.filter((m) => m.role === 'tailor').reduce((a, m) => a + (m.daily_capacity || 0), 0);
  const maxDaily = Math.max(1, tailorCapacity, ...daily.map((d) => d.count));
  const peak = Math.max(...daily.map((d) => d.count));

  const stageCounts = ['to_assign', 'cutting', 'stitching', 'qc', 'packed'].map((s) => ({
    stage: s,
    count: s === 'packed' ? 0 : allCards.filter((c) => c.stage === s).length,
  }));
  stageCounts[4].count = whOrders.length; // "In warehouse" = packed orders not yet dispatched
  const maxStage = Math.max(1, ...stageCounts.map((s) => s.count));

  // Tailor output this week (cards that reached QC this week)
  const weekAgo = daysAgoISO(7);
  const outputByTailor = {};
  for (const c of allCards) if (c.tailor_id && c.qc_at && c.qc_at >= weekAgo) outputByTailor[c.tailor_id] = (outputByTailor[c.tailor_id] || 0) + 1;
  const tailorOutput = team.members
    .filter((m) => m.role === 'tailor')
    .map((t) => ({ id: t.id, name: t.name, count: outputByTailor[t.id] || 0 }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 8);
  const maxOutput = Math.max(1, ...tailorOutput.map((t) => t.count));

  return ApiResponse.success(res, {
    range,
    inProduction: active.length,
    dueToday: dueToday.length,
    rushDueToday: dueToday.filter((c) => c.priority === 'rush').length,
    delayed: active.filter((c) => c.due_date && c.due_date < today).length,
    onTimeRate: packedRecent.length ? Math.round((onTime / packedRecent.length) * 100) : null,
    inWarehouse: whOrders.length,
    awaitingPayment: whOrders.filter((o) => ['invoice_issued', 'awaiting_payment'].includes(o.status)).length,
    earningsThisMonth: round2(sum(unwrap(paidThisMonth), 'partner_total_pkr')),
    dailyCapacity: tailorCapacity,
    dailyFinished: daily.map((d) => ({ ...d, pct: Math.round((d.count / maxDaily) * 100), isPeak: d.count > 0 && d.count === peak })),
    capacityPct: tailorCapacity ? Math.round((tailorCapacity / maxDaily) * 100) : null,
    workByStage: stageCounts.map((s) => ({ ...s, pct: Math.round((s.count / maxStage) * 100) })),
    teamLoad: team.masters.map((m) => ({ id: m.id, name: m.name, pct: Math.min(100, m.team_load_pct), load_pct: m.team_load_pct, assigned: m.team_assigned, capacity: m.team_capacity })),
    tailorOutput: tailorOutput.map((t) => ({ ...t, pct: Math.round((t.count / maxOutput) * 100) })),
  });
});

// ─────────────────────────────── Receiving ───────────────────────────────

const RECEIVING_SELECT = `
  partner:partners!orders_partner_id_fkey(name, short_code, receiving_name, receiving_address, receiving_city),
  id, reference, partner_id, brand, brand_order_number, tracking_number, status, has_issue, customer_name, customer_code,
  destination_city, destination_country, destination_address, destination_phone, priority, express_stitching, express_days, express_shipping, express_shipping_days, due_date, customer_notes, created_at, received_at,
  import_source, order_source, details_completed_at, parcel_media, parcel_received_at, parcel_review,
  units:order_units!order_units_order_id_fkey(id, code, unit_title, stitching_type, notes, quantity, status, issue_type, issue_note, issue_media, receive_media, received_at, line_no, design, weight_kg, product_image_url, created_at, review_status, review_note, review_media, return_status, return_to, return_note, return_courier, return_tracking, resubmit_count, held_at, hold_received_at, hold_resolved_at, return_shipping)
`;

const RECEIVING_SELECT_BEFORE_0036 = RECEIVING_SELECT.replace(', express_shipping, express_shipping_days', '');
const RECEIVING_SELECT_BEFORE_0027 = RECEIVING_SELECT_BEFORE_0036.replace(', return_shipping', '').replace(', held_at, hold_received_at, hold_resolved_at', '');
const RECEIVING_SELECT_BEFORE_0021 = RECEIVING_SELECT_BEFORE_0027.replace(/, review_status, review_note[^)]*\)/, ')').replace(', order_source, details_completed_at', '');

/**
 * GET /api/partner/receiving?tab=expected|issues|recent&search&page
 */
export const getReceiving = catchAsync(async (req, res) => {
  const q = parseListQuery(req, { defaultLimit: 10 });
  const RETURN_TABS = ['return_requested', 'ready_return', 'handed_over', 'returns'];
  const tab = ['expected', 'issues', ...RETURN_TABS, 'hold', 'recent'].includes(req.query.tab) ? req.query.tab : 'expected';

  // "Direct from website" orders are drafts made from an email: they are received while still a draft, so the customer can review the photos first
  const since = daysAgoISO(7);
  const EXPECTED = 'status.eq.submitted,and(status.eq.draft,parcel_received_at.is.null)';
  const RECENT = `and(status.not.in.(submitted,draft),received_at.gte.${since}),and(status.eq.draft,parcel_received_at.gte.${since})`;
  // orders that have an article the customer sent back (returns) or put on hold (hold)
  const idsWithReturn = async (statuses) => {
    const rows = (await supabaseAdmin.from('order_units').select('order_id').in('return_status', statuses).limit(2000)).data || [];
    return [...new Set(rows.map((x) => x.order_id))];
  };
  const resolvedIds = async () => {
    const rows = (await supabaseAdmin.from('order_units').select('order_id').not('hold_resolved_at', 'is', null).limit(2000)).data || [];
    return [...new Set(rows.map((x) => x.order_id))];
  };
  // where each returned article stands in the courier workflow: Return Requested > Ready for Return (CN booked) > Handed Over > Returns (delivered)
  const returnTabOfUnits = async () => {
    const units = (await supabaseAdmin.from('order_units').select('id, order_id, return_status').in('return_status', ['requested', 'sent_back', 'returned']).limit(5000)).data || [];
    const ships = (await supabaseAdmin.from('return_shipments').select('unit_id, status').neq('status', 'cancelled').limit(5000)).data || [];
    const shipOf = new Map(ships.map((x) => [x.unit_id, x.status]));
    // a return that was sent to the Warehouse is handled there (its return order): it leaves the Receiving return tabs
    const routed = new Set(((await supabaseAdmin.from('orders').select('return_unit_id').not('return_unit_id', 'is', null).neq('status', 'cancelled').limit(5000)).data || []).map((x) => x.return_unit_id));
    const map = new Map();
    for (const u of units) {
      if (routed.has(u.id)) continue;
      const st = shipOf.get(u.id);
      let t;
      if (u.return_status === 'returned') t = 'returns';
      else if (u.return_status === 'sent_back') t = st === 'delivered' ? 'returns' : 'handed_over';
      else t = st === 'booked' ? 'ready_return' : 'return_requested';
      map.set(u.id, { tab: t, order_id: u.order_id });
    }
    return map;
  };
  // orders that really have an article with an open problem (the order's own has_issue flag can be out of date)
  const issueOrderIds = async () => {
    const rows = (await supabaseAdmin.from('order_units').select('order_id, return_status').eq('status', 'issue').limit(2000)).data || [];
    return [...new Set(rows.filter((x) => !x.return_status || x.return_status === 'none').map((x) => x.order_id))];
  };
  const [returnTabs, holdOnlyIds, resolvedOrderIds, issueIds] = await Promise.all([returnTabOfUnits(), idsWithReturn(['held']), resolvedIds(), issueOrderIds()]);
  const returnOrderIds = Object.fromEntries(RETURN_TABS.map((t) => [t, [...new Set([...returnTabs.values()].filter((x) => x.tab === t).map((x) => x.order_id))]]));
  const holdIds = [...new Set([...holdOnlyIds, ...resolvedOrderIds])];
  const NONE = ['00000000-0000-0000-0000-000000000000'];
  const scopeTab = (query) => {
    if (RETURN_TABS.includes(tab)) return query.in('id', returnOrderIds[tab].length ? returnOrderIds[tab] : NONE);
    if (tab === 'hold') return query.in('id', holdIds.length ? holdIds : NONE);
    if (tab === 'expected') return query.or(EXPECTED);
    if (tab === 'issues') return query.in('id', issueIds.length ? issueIds : NONE).not('status', 'in', '(cancelled,delivered)');
    return query.or(RECENT);
  };

  const listQuery = (select) => {
    let query = scoped(req.access, scopeTab(supabaseAdmin.from('orders').select(select, { count: 'exact' })))
      .order(tab === 'recent' ? 'received_at' : 'created_at', { ascending: tab !== 'recent' })
      .range(q.from, q.to);
    if (q.search) query = query.or(ilikeAny(['reference', 'customer_code', 'customer_name', 'brand', 'tracking_number', 'brand_order_number'], q.search));
    return query;
  };

  const countIn = (ids) => scoped(req.access, supabaseAdmin.from('orders').select('id', { count: 'exact', head: true }).in('id', ids.length ? ids : NONE));
  let [result, expected, issues, recent, hold, ...returnCounts] = await Promise.all([
    listQuery(RECEIVING_SELECT),
    scoped(req.access, supabaseAdmin.from('orders').select('id', { count: 'exact', head: true }).or(EXPECTED)),
    countIn(issueIds).not('status', 'in', '(cancelled,delivered)'),
    scoped(req.access, supabaseAdmin.from('orders').select('id', { count: 'exact', head: true }).or(RECENT)),
    countIn(holdIds),
    ...RETURN_TABS.map((t) => countIn(returnOrderIds[t])),
  ]);
  // the article-review columns come with database update 0021: until it is applied, keep the screen working without them
  if (result.error && /express_shipping/.test(result.error.message || '')) result = await listQuery(RECEIVING_SELECT_BEFORE_0036);
  if (result.error && /held_|hold_|return_shipping/.test(result.error.message || '')) result = await listQuery(RECEIVING_SELECT_BEFORE_0027);
  if (result.error && /review_|return_|resubmit_|order_source|details_completed/.test(result.error.message || '')) result = await listQuery(RECEIVING_SELECT_BEFORE_0021);
  // One order is shown per group: <ref> (approved / normal), <ref>-HOLD, <ref>-RETURN, <ref>-RESOLVED. Each tab shows only the
  // articles of its own group, and every row keeps the original order reference.
  const wanted = RETURN_TABS.includes(tab) ? ['return'] : tab === 'hold' ? ['hold', 'resolved'] : ['main'];
  const rows = [];
  for (const o of unwrap(result)) {
    const units = (o.units || []).sort((a, b) => a.line_no - b.line_no);
    const base = { ...o, original_reference: o.reference, status_label: STATUS_LABELS[o.status] };
    if (!units.length) { rows.push({ ...base, units, group: 'main', group_reference: o.reference, row_key: o.id }); continue; }
    for (const g of wanted) {
      const part = units.filter((u) => articleGroup(u) === g && (!RETURN_TABS.includes(tab) || returnTabs.get(u.id)?.tab === tab));
      if (part.length) rows.push({ ...base, units: part, group: g, group_reference: groupReference(o.reference, g), row_key: `${o.id}:${g}` });
    }
  }
  // the courier shipment (CN, status, tracking events) of every returned article shown
  const shipments = await shipmentsForUnits(rows.flatMap((o) => o.units.filter((u) => u.return_status && u.return_status !== 'none').map((u) => u.id))).catch(() => new Map());
  for (const o of rows) for (const u of o.units) u.return_shipment = shipments.get(u.id) ?? null;
  // a return already routed to the Warehouse (or the admin): its return order
  const returnOrders = await returnOrdersForUnits(rows.flatMap((o) => o.units.filter((u) => u.return_status && u.return_status !== 'none').map((u) => u.id))).catch(() => new Map());
  for (const o of rows) for (const u of o.units) u.return_order = returnOrders.get(u.id) ?? null;
  const suggestion = tab === 'expected' && rows.length ? await suggestAssignees(null, scopeOf(req.access)) : null;
  // COD orders: whether the customer has paid, so the person receiving the parcel sees it on the card
  await attachCodSummary(rows);

  return sendPage(res, rows, q, result.count, {
    counts: { expected: expected.count || 0, issues: issues.count || 0, hold: hold.count || 0, recent: recent.count || 0, ...Object.fromEntries(RETURN_TABS.map((t, i) => [t, returnCounts[i].count || 0])) },
    suggestion,
  });
});

const loadUnit = async (unitId) =>
  unwrapOne(await supabaseAdmin.from('order_units').select('*, order:orders!order_units_order_id_fkey(id, reference, status, customer_id, customer_name, partner_id)').eq('id', unitId).maybeSingle(), 'Unit not found');

/** POST /api/partner/receiving/units/:unitId/receive-corrected  body: { note?, media? } — the corrected article of a HOLD arrived. */
export const receiveCorrectedArticle = catchAsync(async (req, res) => {
  const unit = await loadUnit(req.params.unitId);
  const full = unwrapOne(await supabaseAdmin.from('order_units').select('*').eq('id', unit.id).maybeSingle(), 'Unit not found');
  const result = await receiveCorrectedHold({ order: unit.order, unit: full, note: req.body?.note, media: req.body?.media, profile: req.profile });
  return ApiResponse.success(res, result, `${unit.unit_title}: corrected article received. The customer now reviews it.`);
});

export const receiveUnit = catchAsync(async (req, res) => {
  const unit = await loadUnit(req.params.unitId);
  if (unit.order.status === 'cancelled') throw new BadRequestError('This order was cancelled.');
  // a held article is received with "Receive Corrected Article"; a rejected one waits until it is sent back
  if (unit.return_status === 'held') throw new BadRequestError('This article is on hold. Use “Receive Corrected Article” when the corrected one arrives.');
  if (unit.return_status === 'requested') throw new BadRequestError('Send the rejected article back first.');
  // every received article is weighed; an article that already has its weight (entered earlier) keeps it unless a new one is given
  const hasNewWeight = req.body?.weight_kg !== undefined && req.body?.weight_kg !== null && req.body?.weight_kg !== '';
  if (!hasNewWeight && !(Number(unit.weight_kg) > 0)) throw new BadRequestError(`Enter the weight (kg) of ${unit.unit_title}.`);
  const weight = hasNewWeight ? parseWeight(req.body.weight_kg) : null;
  // photos / a video of this one article (optional)
  const media = req.body?.media?.length ? await uploadDataUrls(`received/${unit.order.id}`, req.body.media) : [];
  unwrap(await supabaseAdmin.from('order_units').update({
    ...(weight ? { weight_kg: weight } : {}),
    status: 'received', received_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    // the customer approves each received article before it can go to production
    ...(unit.review_status === 'none' && ['draft', 'submitted'].includes(unit.order.status) ? { review_status: 'pending' } : {}),
    ...(media.length ? { receive_media: [...(unit.receive_media || []), ...media] } : {}),
  }).eq('id', unit.id));
  if (unit.status === 'issue') {
    await addEvent(unit.order.id, unit.order.status, `Issue resolved for "${unit.unit_title}" · unit received`, req.userId);
    await logUnitEvent(unit.id, unit.order.id, 'issue_resolved', { actorId: req.userId });
  }
  await logUnitEvent(unit.id, unit.order.id, 'received', { actorId: req.userId });
  if (['sent_back', 'returned'].includes(unit.return_status)) await resubmitCorrected({ order: unit.order, unit, actorId: req.userId });
  await syncOrderWeight(unit.order);
  const summary = await syncReceiving(unit.order.id, req.userId);
  return ApiResponse.success(res, summary, `${unit.unit_title} received.`);
});

/**
 * POST /api/partner/receiving/units/:unitId/weight  body: { weight_kg }
 * Add or correct an article's weight (also completes articles of older orders that were received without one).
 */
export const setUnitWeight = catchAsync(async (req, res) => {
  const unit = await loadUnit(req.params.unitId);
  if (unit.order.status === 'cancelled') throw new BadRequestError('This order was cancelled.');
  if (['awaiting_payment', 'paid', 'partner_dispatch', 'at_admin_warehouse', 'shipped', 'delivered'].includes(unit.order.status)) {
    throw new BadRequestError('This order is already invoiced, so the weight can no longer change.');
  }
  const result = await saveUnitWeight({ unit, order: unit.order, weight: req.body?.weight_kg });
  await logUnitEvent(unit.id, unit.order.id, 'weighed', { note: `${result.weight_kg} kg`, actorId: req.userId });
  return ApiResponse.success(res, result, `${unit.unit_title}: ${result.weight_kg} kg saved.`);
});

/**
 * POST /api/partner/receiving/units/:unitId/issue  body: { issue_type, note, media: [{ name, dataUrl }] }
 * Photos/video are optional and only asked for when something is wrong.
 */
export const reportUnitIssue = catchAsync(async (req, res) => {
  const unit = await loadUnit(req.params.unitId);
  const issueType = ['piece_missing', 'damaged', 'wrong_item', 'other'].includes(req.body?.issue_type) ? req.body.issue_type : 'other';
  const note = String(req.body?.note || '').trim();
  const audio = await cleanVoiceNote(req.body?.notes_audio, req.userId);
  if (!note && !audio) throw new BadRequestError('Describe the issue (type it or record a voice note), e.g. "Dupatta missing".');

  const media = req.body?.media?.length ? await uploadDataUrls(`issues/${unit.order.id}`, req.body.media) : [];
  const hasWeight = req.body?.weight_kg !== undefined && req.body?.weight_kg !== null && req.body?.weight_kg !== '';
  unwrap(await supabaseAdmin.from('order_units').update({
    ...(hasWeight ? { weight_kg: parseWeight(req.body.weight_kg) } : {}),
    status: 'issue',
    issue_type: issueType,
    issue_note: note ? note.slice(0, 1000) : 'Voice note',
    ...(audio !== undefined ? { issue_audio: audio } : {}),
    issue_media: [...(unit.issue_media || []), ...media],
    updated_at: new Date().toISOString(),
  }).eq('id', unit.id));

  await addEvent(unit.order.id, unit.order.status, `Issue reported for "${unit.unit_title}": ${note || 'voice note'}`, req.userId);
  await logUnitEvent(unit.id, unit.order.id, 'issue', { note: note || null, actorId: req.userId });
  await notifyAdmins({
    type: 'alert',
    title: `Receiving issue: ${unit.order.reference}`,
    body: `${unit.unit_title} · ${note || 'voice note'}`,
    link: `/admin/orders?ref=${unit.order.reference}`,
    orderId: unit.order.id,
  });
  if (hasWeight) await syncOrderWeight(unit.order);
  // the customer now decides what happens to this article: Hold or Return
  await requestIssueDecision({ order: unit.order, unit: { ...unit, status: 'issue' }, actorId: req.userId });
  const summary = await syncReceiving(unit.order.id, req.userId);
  return ApiResponse.success(res, summary, 'Issue reported. The customer will choose Hold or Return, and the admin team has been notified.');
});

export const receiveAllUnits = catchAsync(async (req, res) => {
  const order = await getOrderOr404(req.params.orderId);
  if (order.status === 'cancelled') throw new BadRequestError('This order was cancelled.');
  const pendingUnits = unwrap(await supabaseAdmin.from('order_units').select('id, unit_title, code, return_status, resubmit_count').eq('order_id', order.id).eq('status', 'pending'));
  for (const u of pendingUnits) await logUnitEvent(u.id, order.id, 'received', { actorId: req.userId });
  unwrap(await supabaseAdmin.from('order_units').update({
    status: 'received', received_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    ...(['draft', 'submitted'].includes(order.status) ? { review_status: 'pending' } : {}),
  }).eq('order_id', order.id).eq('status', 'pending').eq('review_status', 'none'));
  // an article that was sent back is received again: it keeps its own review (set in resubmitCorrected below)
  unwrap(await supabaseAdmin.from('order_units').update({
    status: 'received', received_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  }).eq('order_id', order.id).eq('status', 'pending'));
  for (const u of pendingUnits.filter((x) => x.return_status === 'sent_back')) await resubmitCorrected({ order, unit: u, actorId: req.userId });
  const summary = await syncReceiving(order.id, req.userId);
  return ApiResponse.success(res, summary, 'All pending units received.');
});

/**
 * POST /api/partner/receiving/orders/:orderId/parcel-media  body: { media: [{ name, dataUrl }] }
 * Photos / a video of the whole parcel as it arrived (before it is opened). Shown to the customer to review.
 */
export const addParcelMedia = catchAsync(async (req, res) => {
  const order = await getOrderOr404(req.params.orderId);
  if (order.status === 'cancelled') throw new BadRequestError('This order was cancelled.');
  if (!req.body?.media?.length) throw new BadRequestError('Add at least one photo or video of the parcel.');
  const uploaded = await uploadDataUrls(`parcels/${order.id}`, req.body.media);
  const media = [...(order.parcel_media || []), ...uploaded].slice(0, 12);
  unwrap(await supabaseAdmin.from('orders').update({ parcel_media: media, updated_at: new Date().toISOString() }).eq('id', order.id));
  return ApiResponse.success(res, { parcel_media: media }, 'Parcel photos saved.');
});

/**
 * POST /api/partner/receiving/units/:unitId/sent-back  body: { courier?, tracking? }
 * The customer rejected this article and asked to send it back: it was returned. When the corrected or replacement
 * article arrives, receive it again and the customer reviews it once more.
 */
export const sendArticleBack = catchAsync(async () => {
  // the return now follows Return Requested > Book CN > Ready for Return > loadsheet > Handed Over > Delivered
  throw new BadRequestError('Book the CN first, then download the loadsheet. Open the Return Requested tab.');
});

const partnerCanAccess = (req) => (partnerId) => {
  const scope = scopeOf(req.access);
  return scope === undefined || partnerId === scope;
};

/** POST /api/partner/receiving/units/:unitId/return/book  body: { courier_id, cn_number } — the CN the courier gave for this returned article. */
export const bookReturnCn = catchAsync(async (req, res) => {
  const unit = await loadUnit(req.params.unitId);
  const full = unwrapOne(await supabaseAdmin.from('order_units').select('*').eq('id', unit.id).maybeSingle(), 'Unit not found');
  const shipment = await bookReturn({ order: unit.order, unit: full, courierId: req.body?.courier_id, cn: req.body?.cn_number, manual: req.body?.manual === true, profile: req.profile });
  return ApiResponse.success(res, shipment, shipment.booking_source === 'api' ? `${unit.unit_title}: booked with ${shipment.courier_name}, CN ${shipment.cn_number}. It is ready for return.` : `${unit.unit_title}: CN ${shipment.cn_number} booked. It is ready for return.`);
});

/**
 * POST /api/partner/receiving/units/:unitId/return/route  body: { destination: 'customer' | 'admin' }
 * Send to Admin (joins the transfer to the admin warehouse) or Return Directly to Customer (invoice, payment, courier ... in the Warehouse).
 */
export const routeReturn = catchAsync(async (req, res) => {
  const destination = req.body?.destination;
  if (destination !== 'customer') throw new BadRequestError('A return goes to the Warehouse to be returned directly to the customer.');
  if (!can(req.access, 'warehouse.book')) throw new ForbiddenError('You need the Warehouse permission to move a parcel there.');
  const unit = await loadUnit(req.params.unitId);
  const full = unwrapOne(await supabaseAdmin.from('order_units').select('*').eq('id', unit.id).maybeSingle(), 'Unit not found');
  const order = unwrapOne(await supabaseAdmin.from('orders').select('*').eq('id', unit.order.id).maybeSingle(), 'Order not found');
  const created = await createReturnOrder({ order, unit: full, destination, profile: req.profile });
  return ApiResponse.success(res, { id: created.id, reference: created.reference, status: created.status }, destination === 'admin'
    ? `${unit.unit_title} added to the transfer to the admin warehouse (${created.reference}).`
    : `${unit.unit_title} is now in the Warehouse as ${created.reference}. It waits for its invoice.`);
});

/** POST /api/partner/receiving/units/:unitId/return/cancel — undo a booking before the parcel is handed over. */
export const cancelReturnBooking = catchAsync(async (req, res) => {
  const unit = await loadUnit(req.params.unitId);
  const result = await cancelBooking({ order: unit.order, unit, profile: req.profile });
  return ApiResponse.success(res, result, 'Booking cancelled.');
});

/** POST /api/partner/receiving/returns/loadsheet  body: { shipment_ids: [] } — make the loadsheet (nothing is handed over yet). */
export const createReturnLoadsheet = catchAsync(async (req, res) => {
  const sheet = await createLoadsheet({ shipmentIds: req.body?.shipment_ids, profile: req.profile, canAccess: partnerCanAccess(req) });
  return ApiResponse.success(res, { id: sheet.id, number: sheet.number, courier_name: sheet.courier_name, count: sheet.items.length }, `Loadsheet ${sheet.number} is ready.`);
});

/** GET /api/partner/receiving/returns/loadsheets/:id/download — the loadsheet file (CSV). */
export const downloadReturnLoadsheet = catchAsync(async (req, res) => {
  const sheet = unwrapOne(await supabaseAdmin.from('return_loadsheets').select('*').eq('id', req.params.id).maybeSingle(), 'Loadsheet not found');
  if (!partnerCanAccess(req)(sheet.partner_id)) throw new ForbiddenError('This loadsheet belongs to another partner.');
  if (sheet.status === 'void') throw new BadRequestError('This loadsheet was replaced by a newer one.');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="loadsheet-${sheet.number}.csv"`);
  res.setHeader('Cache-Control', 'no-store');
  return res.send(loadsheetCsv(sheet));
});

/** POST /api/partner/receiving/returns/loadsheets/:id/handed-over — the loadsheet was downloaded: the parcels are with the courier. */
export const confirmReturnHandover = catchAsync(async (req, res) => {
  const result = await confirmHandover({ sheetId: req.params.id, profile: req.profile, canAccess: partnerCanAccess(req) });
  return ApiResponse.success(res, { count: result.count, number: result.sheet.number }, result.already ? 'These parcels were already handed over.' : `${result.count} parcel${result.count === 1 ? '' : 's'} handed over to the courier.`);
});

/** POST /api/partner/receiving/returns/:shipmentId/refresh-tracking: read PostEx's tracking of a return parcel now. */
export const refreshReturnTracking = catchAsync(async (req, res) => {
  const shipment = unwrapOne(await supabaseAdmin.from('return_shipments').select('*').eq('id', req.params.shipmentId).maybeSingle(), 'Return shipment not found');
  if (!partnerCanAccess(req)(shipment.partner_id)) throw new ForbiddenError('This shipment belongs to another partner.');
  if (!/^postex$/i.test(String(shipment.courier_name || '').trim())) throw new BadRequestError('Live tracking is only available for parcels booked with PostEx.');
  if (!postexConfigured()) throw new BadRequestError('PostEx tracking is not connected: set the PostEx token in Settings.');
  if (!['handed_over', 'in_transit'].includes(shipment.status)) throw new BadRequestError('The parcel has not been handed over to the courier yet.');
  const result = await syncPostexReturn(shipment).catch((e) => { throw new BadRequestError(e?.message || 'PostEx tracking failed.'); });
  return ApiResponse.success(res, result, result.applied ? `${result.applied} new tracking update${result.applied === 1 ? '' : 's'}.` : 'No new tracking updates.');
});

/**
 * POST /api/partner/receiving/returns/:shipmentId/tracking  body: { status: 'in_transit'|'delivered', note? }
 * For a courier without a tracking connection: a person enters what the courier's own tracking shows. Recorded as manual.
 */
export const updateReturnTracking = catchAsync(async (req, res) => {
  const shipment = unwrapOne(await supabaseAdmin.from('return_shipments').select('*').eq('id', req.params.shipmentId).maybeSingle(), 'Return shipment not found');
  if (!partnerCanAccess(req)(shipment.partner_id)) throw new ForbiddenError('This shipment belongs to another partner.');
  const result = await recordTracking({ shipment, status: req.body?.status, note: req.body?.note, source: 'manual', profile: req.profile });
  return ApiResponse.success(res, result.shipment, result.duplicate ? 'Already recorded.' : req.body?.status === 'delivered' ? 'Delivery recorded. The article is now Returned.' : 'Tracking updated.');
});

export const getUnmatchedParcels = catchAsync(async (req, res) => {
  const q = parseListQuery(req, { defaultLimit: 10 });
  let query = scoped(req.access, supabaseAdmin.from('unmatched_parcels').select('*', { count: 'exact' })).order('created_at', { ascending: false }).range(q.from, q.to);
  if (req.query.status !== 'all') query = query.eq('status', 'open');
  if (q.search) query = query.or(ilikeAny(['label_text', 'brand', 'tracking_number', 'notes'], q.search));
  const result = await query;
  return sendPage(res, unwrap(result), q, result.count);
});

export const createUnmatchedParcel = catchAsync(async (req, res) => {
  const b = req.body || {};
  if (!b.label_text && !b.tracking_number) throw new BadRequestError('Enter what is written on the label or the tracking number.');
  const partnerId = await partnerForWrite(req.access, b.partner_id);
  const row = unwrap(await supabaseAdmin.from('unmatched_parcels').insert({
    partner_id: partnerId,
    label_text: b.label_text?.trim() || null, brand: b.brand?.trim() || null, tracking_number: b.tracking_number?.trim() || null,
    notes: b.notes?.trim() || null, created_by: req.userId,
  }).select('*').single());
  await notifyAdmins({ type: 'alert', title: 'Unmatched parcel received', body: `${b.brand || 'Unknown brand'} · ${b.label_text || b.tracking_number}`, link: '/admin/orders' });
  return ApiResponse.created(res, row, 'Parcel logged. The admin team will match it to a customer.');
});

export const updateUnmatchedParcel = catchAsync(async (req, res) => {
  // a parcel can only be matched to an order of the same partner
  if (req.body?.matched_order_id) await assertOrderAccess(req.access, req.body.matched_order_id);
  const status = ['open', 'matched', 'returned'].includes(req.body?.status) ? req.body.status : undefined;
  const row = unwrap(await supabaseAdmin.from('unmatched_parcels').update({
    ...(status && { status }),
    ...(req.body?.matched_order_id !== undefined && { matched_order_id: req.body.matched_order_id || null }),
    ...(req.body?.notes !== undefined && { notes: req.body.notes }),
    updated_at: new Date().toISOString(),
  }).eq('id', req.params.id).select('*').single());
  return ApiResponse.success(res, row, 'Parcel updated.');
});

// ─────────────────────────────── Teams ───────────────────────────────

export const getTeams = catchAsync(async (req, res) =>
  ApiResponse.success(res, await getTeamWithLoad({ includeInactive: req.query.includeInactive === 'true', partnerId: scopeOf(req.access) })));

const cleanMember = (b, partial = false) => {
  const out = {};
  if (!partial || b.name !== undefined) {
    const name = String(b.name || '').trim();
    if (!name) throw new BadRequestError('Name is required.');
    out.name = name.slice(0, 80);
  }
  if (!partial || b.role !== undefined) {
    if (!['master', 'tailor', 'qa', 'pressing', 'packing'].includes(b.role)) throw new BadRequestError('Role must be master, tailor, quality check, pressing or packing.');
    out.role = b.role;
  }
  if (!partial || b.daily_capacity !== undefined) {
    const cap = parseInt(b.daily_capacity, 10);
    if (!(cap >= 1 && cap <= 100)) throw new BadRequestError('Daily capacity must be between 1 and 100 articles.');
    out.daily_capacity = cap;
  }
  if (b.master_id !== undefined) out.master_id = b.master_id || null;
  if (b.is_active !== undefined) out.is_active = !!b.is_active;
  return out;
};

/**
 * Give a master / tailor their own login, linked to the team member. The login is typed after the member's role and
 * gets only the permissions listed (a subset of what the caller holds, within the partner's modules).
 * @returns {Promise<{ email: string, temporaryPassword: string }>}
 */
const createLoginFor = async (req, member, input) => {
  if (!can(req.access, 'users.create')) throw new ForbiddenError('You need the Users permission to create a login.');
  const { user, temporaryPassword } = await createUser(
    { profile: req.profile, access: req.access },
    member.partner_id,
    { email: input.email, password: input.password, full_name: member.name, staff_type: member.role, permissions: input.permissions ?? [] }
  );
  const { error } = await supabaseAdmin.from('team_members').update({ user_id: user.id, updated_at: new Date().toISOString() }).eq('id', member.id);
  if (error) {
    await supabaseAdmin.auth.admin.deleteUser(user.id).catch(() => {});
    throw error;
  }
  return { email: user.email, temporaryPassword };
};

/** Keep the login in step with the team member: switched off / on together, same name. */
const syncLogin = async (member, patch) => {
  if (!member.user_id) return;
  const change = {};
  if (patch.is_active !== undefined) change.is_active = !!patch.is_active;
  if (!Object.keys(change).length) return;
  await supabaseAdmin.from('profiles').update({ ...change, updated_at: new Date().toISOString() }).eq('id', member.user_id);
  invalidateProfile(member.user_id);
};

export const createTeamMember = catchAsync(async (req, res) => {
  const row = cleanMember(req.body || {});
  if (row.role === 'tailor' && !row.master_id) throw new BadRequestError('Choose which master this tailor works under.');
  if (row.role !== 'tailor') row.master_id = null; // only a tailor works under a master
  row.partner_id = await partnerForWrite(req.access, req.body?.partner_id);
  if (row.master_id) await assertMemberOfPartner(row.master_id, row.partner_id, 'Master');
  const login = req.body?.login;
  if (login && !can(req.access, 'users.create')) throw new ForbiddenError('You need the Users permission to create a login.');
  const created = unwrap(await supabaseAdmin.from('team_members').insert(row).select('*').single());
  // the usual way: the person was added as a user first, and is linked here
  if (req.body?.user_id) {
    try {
      await setMemberUser(created.partner_id, created.id, String(req.body.user_id));
    } catch (err) {
      await supabaseAdmin.from('team_members').delete().eq('id', created.id);
      throw err;
    }
    return ApiResponse.created(res, { ...created, user_id: String(req.body.user_id) }, `${created.name} added and linked to their user.`);
  }
  if (!login) return ApiResponse.created(res, created, `${created.name} added.`);
  try {
    const credential = await createLoginFor(req, created, login);
    return ApiResponse.created(res, { ...created, credential }, `${created.name} added with their own login. Share the temporary password once.`);
  } catch (err) {
    // a team member without the login the partner asked for would be confusing: undo
    await supabaseAdmin.from('team_members').delete().eq('id', created.id);
    throw err;
  }
});

/** POST /api/partner/teams/members/:id/login  body: { email, password?, permissions: [...] } */
export const createMemberLogin = catchAsync(async (req, res) => {
  const member = unwrapOne(await supabaseAdmin.from('team_members').select('*').eq('id', req.params.id).maybeSingle(), 'Team member not found');
  if (member.user_id) throw new ConflictError(`${member.name} already has a login.`);
  const credential = await createLoginFor(req, member, req.body || {});
  return ApiResponse.created(res, { member_id: member.id, credential }, `Login created for ${member.name}. Share the temporary password once.`);
});

/**
 * Edit the login of a team member (their email, a new password, the permissions) while editing the member.
 * Needs the Users permission; permissions stay within what the caller holds and the partner's modules.
 */
const changeMemberLogin = async (req, member, input) => {
  if (!member.user_id) throw new BadRequestError(`${member.name} has no login yet.`);
  if (!can(req.access, 'users.update')) throw new ForbiddenError('You need the Users permission to change a login.');
  const actor = { profile: req.profile, access: req.access };
  const now = new Date().toISOString();

  if (Array.isArray(input.permissions)) await updateUser(actor, member.partner_id, member.user_id, { permissions: input.permissions });

  const email = String(input.email ?? '').trim().toLowerCase();
  if (email) {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new BadRequestError('Enter a valid email address.');
    const current = unwrapOne(await supabaseAdmin.from('profiles').select('id, email').eq('id', member.user_id).maybeSingle(), 'Login not found');
    if (current.email.toLowerCase() !== email) {
      const taken = await supabaseAdmin.from('profiles').select('id').eq('email', email).neq('id', member.user_id).maybeSingle();
      if (taken.data) throw new ConflictError('An account with this email already exists.');
      const { error } = await supabaseAdmin.auth.admin.updateUserById(member.user_id, { email, email_confirm: true });
      if (error) throw /already|registered|exists/i.test(error.message || '') ? new ConflictError('An account with this email already exists.') : error;
      unwrap(await supabaseAdmin.from('profiles').update({ email, updated_at: now }).eq('id', member.user_id));
    }
  }

  if (input.password) {
    const password = String(input.password);
    if (password.length < 8) throw new BadRequestError('The password must be at least 8 characters.');
    await UserModel.updatePassword(member.user_id, password);
    // they choose their own at the next sign-in
    unwrap(await supabaseAdmin.from('profiles').update({ must_change_password: true, updated_at: now }).eq('id', member.user_id));
  }
  invalidateProfile(member.user_id);
};

export const updateTeamMember = catchAsync(async (req, res) => {
  const patch = cleanMember(req.body || {}, true);
  if (patch.master_id) {
    const current = unwrapOne(await supabaseAdmin.from('team_members').select('partner_id').eq('id', req.params.id).maybeSingle(), 'Team member not found');
    await assertMemberOfPartner(patch.master_id, current.partner_id, 'Master');
  }
  const updated = unwrap(await supabaseAdmin.from('team_members').update({ ...patch, updated_at: new Date().toISOString() }).eq('id', req.params.id).select('*').single());
  if (req.body?.user_id !== undefined) {
    await setMemberUser(updated.partner_id, updated.id, req.body.user_id ? String(req.body.user_id) : null);
    updated.user_id = req.body.user_id || null;
  }
  await syncLogin(updated, patch);
  if (req.body?.login) await changeMemberLogin(req, updated, req.body.login);
  return ApiResponse.success(res, updated, `${updated.name} updated.`);
});

export const deactivateTeamMember = catchAsync(async (req, res) => {
  const member = unwrapOne(await supabaseAdmin.from('team_members').select('*').eq('id', req.params.id).maybeSingle(), 'Team member not found');
  unwrap(await supabaseAdmin.from('team_members').update({ is_active: false, updated_at: new Date().toISOString() }).eq('id', member.id));
  await syncLogin(member, { is_active: false });
  return ApiResponse.success(res, null, `${member.name} removed from active teams.`);
});

// ─────────────────────────────── Warehouse ───────────────────────────────

const WAREHOUSE_TAB_KEYS = ['to_invoice', 'awaiting_payment', 'paid', 'ready_dispatch', 'dispatched', 'delivered', 'failed_delivery'];

/** Order ids whose shipment is in one of these states (the partner's direct dispatches). */
const orderIdsByShipment = async (statuses) =>
  [...new Set(((await supabaseAdmin.from('shipments').select('order_id').eq('shipped_from', 'partner').in('status', statuses).limit(5000)).data || []).map((x) => x.order_id))];

const NO_ID = '00000000-0000-0000-0000-000000000000';
const idList = (ids) => (ids.length ? ids : [NO_ID]).join(',');

/**
 * The seven warehouse tabs. Packed > Waiting for invoice > Awaiting payment > Paid are driven by the order, invoice and payment
 * records; the dispatch tabs by the shipment (CN, loadsheet, handover, tracking).
 */
const warehouseTabs = async () => {
  const [needsCn, ready, onTheWay, back] = await Promise.all([
    orderIdsByShipment(['needs_label']),
    orderIdsByShipment(['booked', 'labelled']),
    orderIdsByShipment(['handed_to_courier', 'in_transit', 'failed_delivery']),
    orderIdsByShipment(['returning_to_partner', 'returned_to_partner']),
  ]);
  return {
    to_invoice: (q) => q.eq('status', 'packed'),
    awaiting_payment: (q) => q.in('status', ['invoice_issued', 'awaiting_payment']),
    // paid and not routed yet, or routed for direct dispatch but with no courier booked (e.g. a cancelled booking)
    paid: (q) => q.or(`and(status.eq.paid,partner_route.is.null),id.in.(${idList(needsCn)})`),
    ready_dispatch: (q) => q.in('id', ready.length ? ready : [NO_ID]),
    // the admin-warehouse route keeps its old meaning; direct parcels are here from the handover until delivery or a confirmed return
    dispatched: (q) => q.or(`and(partner_route.eq.admin_warehouse,status.in.(paid,at_admin_warehouse,partner_dispatch,shipped)),id.in.(${idList(onTheWay)})`),
    delivered: (q) => q.eq('status', 'delivered').not('partner_route', 'is', null),
    failed_delivery: (q) => q.in('id', back.length ? back : [NO_ID]),
  };
};

const WAREHOUSE_SELECT = `
  id, reference, brand, status, customer_name, customer_code, destination_city, destination_country, destination_address, destination_phone,
  shipping_service, weight_kg, partner_route, packed_at, paid_at, created_at, order_kind, return_destination,
  return_unit:order_units!orders_return_unit_id_fkey(id, unit_title, code),
  units:order_units!order_units_order_id_fkey(count),
  invoice:invoices!invoices_order_id_fkey(id, number, status, issued_at, total_pkr, currency, total_foreign, lines:invoice_lines(kind, label)),
  transfer:transfers!orders_transfer_id_fkey(id, code, status),
  shipment:shipments!shipments_order_id_fkey(id, status, courier, tracking_number, shipped_from, booking_source, booked_at, handed_at, delivered_at, failure_reason, failed_at, return_started_at, returned_at, proof, loadsheet_id)
`;
const WAREHOUSE_SELECT_BEFORE_0032 = WAREHOUSE_SELECT.replace(', order_kind, return_destination,\n  return_unit:order_units!orders_return_unit_id_fkey(id, unit_title, code),', ',');
const WAREHOUSE_SELECT_BEFORE_0030 = WAREHOUSE_SELECT_BEFORE_0032.replace(', booking_source, booked_at, handed_at, delivered_at, failure_reason, failed_at, return_started_at, returned_at, proof, loadsheet_id', '');

/**
 * GET /api/partner/warehouse?tab=to_invoice|awaiting_payment|paid|ready_dispatch|dispatched|delivered|failed_delivery&search&page
 */
export const getPartnerWarehouse = catchAsync(async (req, res) => {
  const q = parseListQuery(req, { defaultLimit: 10, sortable: ['created_at', 'packed_at', 'paid_at'], defaultSort: 'packed_at' });
  const tabs = await warehouseTabs();
  const tab = tabs[req.query.tab] ? req.query.tab : 'paid';

  const listQuery = (select) => {
    let query = scoped(req.access, tabs[tab](supabaseAdmin.from('orders').select(select, { count: 'exact' })))
      .order(q.sort, { ascending: q.ascending, nullsFirst: false })
      .range(q.from, q.to);
    if (q.search) query = query.or(ilikeAny(['reference', 'customer_code', 'customer_name', 'destination_city', 'destination_country'], q.search));
    return query;
  };
  const countFor = (key) => scoped(req.access, tabs[key](supabaseAdmin.from('orders').select('id', { count: 'exact', head: true })));
  let [result, ...counts] = await Promise.all([listQuery(WAREHOUSE_SELECT), ...WAREHOUSE_TAB_KEYS.map(countFor)]);
  // the dispatch columns come with database update 0030: until then keep the screen working without them
  if (result.error && /order_kind|return_destination|return_unit/.test(result.error.message || '')) result = await listQuery(WAREHOUSE_SELECT_BEFORE_0032);
  if (result.error && /booking_source|loadsheet_id|failure_reason|proof/.test(result.error.message || '')) result = await listQuery(WAREHOUSE_SELECT_BEFORE_0030);

  // the count follows the shipment: an article that was rejected or returned on its own is not counted here
  const counted = await adjustUnitCounts(unwrap(result).map((o) => ({ ...o, units_count: o.units?.[0]?.count ?? 0, units: undefined, return_unit_id: one(o.return_unit)?.id ?? null })));
  const rows = counted.map((o) => ({
    ...o,
    invoice: one(o.invoice),
    return_unit: one(o.return_unit),
    shipment: one(o.shipment),
    status_label: STATUS_LABELS[o.status],
  }));
  const events = await dispatchEventsFor(rows.map((o) => o.shipment?.id).filter(Boolean)).catch(() => new Map());
  for (const o of rows) if (o.shipment) o.shipment = { ...o.shipment, events: events.get(o.shipment.id) ?? [] };
  const countMap = Object.fromEntries(WAREHOUSE_TAB_KEYS.map((k, i) => [k, counts[i].count || 0]));
  return sendPage(res, rows, q, result.count, { counts: countMap });
});

/** The weight can no longer be typed here: it is the total of the article weights entered in Receiving. */
export const setOrderWeight = catchAsync(async () => {
  throw new BadRequestError('The weight is the total of the article weights. Add or change an article weight in Receiving.');
});

/**
 * POST /api/partner/warehouse/orders/:id/route  body: { route: 'admin_warehouse' | 'direct_dispatch' }
 */
export const setDispatchRoute = catchAsync(async (req, res) => {
  const route = req.body?.route;
  if (route === 'direct_dispatch') throw new BadRequestError('Book the courier first: choose the courier and enter its CN. The parcel is then ready for dispatch.');
  if (route !== 'admin_warehouse') throw new BadRequestError('Choose a dispatch route.');
  const order = await getOrderOr404(req.params.id);
  if (order.status !== 'paid' || order.partner_route) throw new BadRequestError('Only paid orders without a route can be dispatched.');

  const transfer = await addOrderToTransfer({ order, userId: req.userId });
  return ApiResponse.success(res, { transfer }, `Added to ${transfer.code}. Dispatch the transfer when the batch is ready.`);
});

const orderAccess = (req) => async (orderId) => {
  const order = await getOrderOr404(orderId);
  const scope = scopeOf(req.access);
  if (scope !== undefined && order.partner_id !== scope) throw new ForbiddenError('This order belongs to another partner.');
  return order;
};

const shipmentWithAccess = async (req, shipmentId) => {
  const shipment = unwrapOne(await supabaseAdmin.from('shipments').select('*').eq('id', shipmentId).maybeSingle(), 'Shipment not found');
  await orderAccess(req)(shipment.order_id);
  return shipment;
};

/** POST /api/partner/warehouse/orders/:id/book  body: { courier_id, cn_number } — book the courier of a paid parcel and save its CN. */
export const bookDispatchCn = catchAsync(async (req, res) => {
  const order = await getOrderOr404(req.params.id);
  const shipment = await bookDispatch({ order, courierId: req.body?.courier_id, cn: req.body?.cn_number, manual: req.body?.manual === true, profile: req.profile });
  return ApiResponse.success(res, shipment, shipment.booking_source === 'api' ? `Booked with ${shipment.courier}: CN ${shipment.tracking_number}. The parcel is ready for dispatch.` : `CN ${shipment.tracking_number} saved. The parcel is ready for dispatch.`);
});

/**
 * POST /api/partner/warehouse/dispatch/bulk-book
 * body: { order_ids, route: 'direct_dispatch'|'admin_warehouse', mode?: 'api'|'manual', courier?: 'PostEx' (api) | courier_id (manual) }
 * Each paid order is handled on its own: one failing never stops the others. The answer lists every order's result.
 *   direct_dispatch + api     the courier is booked through its API and the CN saved
 *   direct_dispatch + manual  the courier is chosen, the CN is added later
 *   admin_warehouse           no courier is booked: the orders join the open transfer to the admin warehouse
 */
export const bulkBookDispatch = catchAsync(async (req, res) => {
  const ids = [...new Set((Array.isArray(req.body?.order_ids) ? req.body.order_ids : []).filter(Boolean))];
  if (!ids.length) throw new BadRequestError('Select at least one order.');
  if (ids.length > 50) throw new BadRequestError('Select up to 50 orders at a time.');
  const route = req.body?.route;
  if (!['direct_dispatch', 'admin_warehouse'].includes(route)) throw new BadRequestError('Choose Dispatch directly to customer or Send to admin warehouse.');
  const mode = req.body?.mode === 'manual' ? 'manual' : 'api';
  if (route === 'direct_dispatch') {
    if (mode === 'api' && !String(req.body?.courier || '').trim()) throw new BadRequestError('Choose the courier to book with.');
    if (mode === 'manual' && !req.body?.courier_id) throw new BadRequestError('Choose the courier for the manual booking.');
  }
  const can = partnerCanAccess(req);
  const results = [];
  for (const id of ids) {
    const order = (await supabaseAdmin.from('orders').select('*').eq('id', id).maybeSingle()).data;
    const ref = order?.reference || id;
    try {
      if (!order) throw new BadRequestError('Order not found.');
      if (!can(order.partner_id)) throw new ForbiddenError('This order belongs to another partner.');
      if (route === 'admin_warehouse') {
        if (order.status !== 'paid' || order.partner_route) throw new BadRequestError('Only paid orders without a route can be sent.');
        const transfer = await addOrderToTransfer({ order, userId: req.userId });
        results.push({ order_id: id, reference: ref, ok: true, message: `Added to ${transfer.code}` });
      } else if (mode === 'manual') {
        await bookDispatch({ order, courierId: req.body.courier_id, cnPending: true, profile: req.profile });
        results.push({ order_id: id, reference: ref, ok: true, message: 'Booked · CN to be added' });
      } else {
        const shipment = await bookDispatch({ order, courierName: req.body.courier, profile: req.profile });
        results.push({ order_id: id, reference: ref, ok: true, message: `Booked · CN ${shipment.tracking_number}`, cn: shipment.tracking_number });
      }
    } catch (e) {
      results.push({ order_id: id, reference: ref, ok: false, message: e?.message || 'Could not be booked.' });
    }
  }
  const done = results.filter((r) => r.ok).length;
  return ApiResponse.success(res, { results, done, failed: results.length - done }, done === results.length ? `${done} order${done === 1 ? '' : 's'} done.` : `${done} of ${results.length} done. See the list for the others.`);
});

/** POST /api/partner/warehouse/shipments/:shipmentId/cn  body: { cn_number } — the CN of a parcel booked by hand without one. */
export const addDispatchCn = catchAsync(async (req, res) => {
  const shipment = await shipmentWithAccess(req, req.params.shipmentId);
  const saved = await setDispatchCn({ shipment, cn: req.body?.cn_number, profile: req.profile });
  return ApiResponse.success(res, saved, `CN ${saved.tracking_number} saved.`);
});

export const cancelDispatchCn = catchAsync(async (req, res) => {
  const order = await getOrderOr404(req.params.id);
  const result = await cancelDispatchBooking({ order, profile: req.profile });
  return ApiResponse.success(res, result, 'Booking cancelled.');
});

/** POST /api/partner/warehouse/dispatch/loadsheet  body: { shipment_ids } */
export const createDispatchSheet = catchAsync(async (req, res) => {
  const sheet = await createDispatchLoadsheet({ shipmentIds: req.body?.shipment_ids, profile: req.profile, canAccess: partnerCanAccess(req) });
  return ApiResponse.success(res, { id: sheet.id, number: sheet.number, courier_name: sheet.courier_name, count: sheet.items.length }, `Loadsheet ${sheet.number} is ready.`);
});

/** POST /api/partner/warehouse/dispatch/loadsheets/:id/downloaded — the file was saved: the parcels wait for the courier. */
export const markDispatchSheetDownloaded = catchAsync(async (req, res) => {
  const result = await markDownloaded({ sheetId: req.params.id, profile: req.profile, canAccess: partnerCanAccess(req) });
  return ApiResponse.success(res, { count: result.count, number: result.sheet.number }, result.already ? 'Already recorded.' : `${result.sheet.number} downloaded. Confirm the handover when the courier takes the parcels.`);
});

/** POST /api/partner/warehouse/dispatch/loadsheets/:id/handed-over — the courier really took the parcels: Dispatched. */
export const confirmDispatchSheetHandover = catchAsync(async (req, res) => {
  const result = await confirmDispatchHandover({ sheetId: req.params.id, profile: req.profile, canAccess: partnerCanAccess(req) });
  return ApiResponse.success(res, { count: result.count, number: result.sheet.number }, result.already ? 'These parcels were already handed over.' : `${result.count} parcel${result.count === 1 ? '' : 's'} dispatched. The customers were told.`);
});

/** POST /api/partner/warehouse/shipments/:shipmentId/tracking  body: { status, note?, reason? } — entered from the courier's own tracking. */
export const updateDispatchTracking = catchAsync(async (req, res) => {
  const shipment = await shipmentWithAccess(req, req.params.shipmentId);
  const result = await recordDispatchTracking({ shipment, status: req.body?.status, note: req.body?.note, reason: req.body?.reason, source: 'manual', profile: req.profile });
  return ApiResponse.success(res, result.shipment, result.duplicate ? 'Already recorded.' : 'Tracking updated.');
});

/**
 * GET /api/partner/warehouse/scan-lookup?code=SA-1108-1 (an article's QR code) or SA-1108 (the parcel's order reference).
 * Resolves what a physical scan points to: the article, its order and its dispatch shipment, and whether the parcel can go on a
 * loadsheet (booked, CN saved, loadsheet not downloaded yet) and whether its CN can be printed (booked or loadsheet downloaded).
 * Nothing is changed here; the loadsheet and the CN use the existing endpoints with the shipment ids this returns.
 */
export const scanLookupDispatch = catchAsync(async (req, res) => {
  const code = String(req.query.code || '').trim().slice(0, 80);
  if (!code) throw new BadRequestError('Scan an article QR code or type its code.');
  const exact = code.replace(/[%_]/g, '\\$&');
  let unit = (await supabaseAdmin.from('order_units').select('id, code, unit_title, order_id, line_no').ilike('code', exact).limit(1).maybeSingle()).data;
  let order = null;
  if (unit) order = (await supabaseAdmin.from('orders').select('id, reference, partner_id, status, customer_name, customer_code, destination_city, destination_country, weight_kg').eq('id', unit.order_id).maybeSingle()).data;
  else order = (await supabaseAdmin.from('orders').select('id, reference, partner_id, status, customer_name, customer_code, destination_city, destination_country, weight_kg').ilike('reference', exact).limit(1).maybeSingle()).data;
  if (!order) throw new BadRequestError(`No article or parcel has the code ${code}.`);
  const scope = scopeOf(req.access);
  if (scope !== undefined && order.partner_id !== scope) throw new ForbiddenError('This article belongs to another partner.');

  const shipment = (await supabaseAdmin.from('shipments').select('id, status, courier, courier_id, tracking_number, loadsheet_id, shipped_from').eq('order_id', order.id).order('created_at', { ascending: false }).limit(1).maybeSingle()).data;
  let loadsheet = false;
  let cn = false;
  let reason = null;
  if (!shipment || shipment.status === 'needs_label') reason = 'No courier is booked for this parcel yet. Book it in the Paid tab first.';
  else if (!['booked', 'labelled'].includes(shipment.status)) reason = `This parcel is already ${shipment.status === 'handed_to_courier' ? 'dispatched' : String(shipment.status).replace(/_/g, ' ')}.`;
  else if (!String(shipment.tracking_number || '').trim()) reason = 'This parcel has no CN yet. Add its CN number first.';
  else {
    cn = true;
    if (shipment.status === 'labelled') reason = 'Its loadsheet was already downloaded. Confirm the handover in the list instead.';
    else loadsheet = true;
  }
  return ApiResponse.success(res, {
    code,
    article: unit ? { id: unit.id, code: unit.code, title: unit.unit_title, line_no: unit.line_no } : null,
    order: { id: order.id, reference: order.reference, customer_name: order.customer_name, customer_code: order.customer_code, destination_city: order.destination_city, destination_country: order.destination_country, weight_kg: order.weight_kg },
    shipment: shipment ? { id: shipment.id, status: shipment.status, courier: shipment.courier, courier_id: shipment.courier_id, tracking_number: shipment.tracking_number, loadsheet_id: shipment.loadsheet_id } : null,
    can_loadsheet: loadsheet,
    can_print_cn: cn,
    reason,
  });
});

/**
 * GET /api/partner/warehouse/cn/print?shipment_ids=a,b,c — the CN slips of dispatched / ready parcels.
 * All PostEx parcels (and PostEx connected): PostEx's own airway bill PDF (at most 10 at a time). Otherwise a printable slip made here.
 */
export const printDispatchCn = catchAsync(async (req, res) => {
  const ids = [...new Set(String(req.query.shipment_ids || '').split(',').map((x) => x.trim()).filter(Boolean))];
  if (!ids.length) throw new BadRequestError('Select at least one parcel.');
  if (ids.length > 100) throw new BadRequestError('Print up to 100 parcels at a time.');
  const rows = unwrap(await supabaseAdmin.from('shipments').select('*').in('id', ids));
  if (rows.length !== ids.length) throw new BadRequestError('One of the selected parcels was not found.');
  const orders = unwrap(await supabaseAdmin.from('orders').select('id, reference, partner_id, order_kind, return_unit_id, brand, customer_name, customer_code, destination_address, destination_city, destination_country, destination_phone, weight_kg').in('id', rows.map((x) => x.order_id)));
  const orderOf = new Map(orders.map((o) => [o.id, o]));
  const scope = scopeOf(req.access);
  for (const s of rows) {
    const o = orderOf.get(s.order_id);
    if (scope !== undefined && o?.partner_id !== scope) throw new ForbiddenError('One of the selected parcels belongs to another partner.');
    if (!String(s.tracking_number || '').trim()) throw new BadRequestError(`${o?.reference || 'A parcel'} has no CN yet.`);
  }
  res.setHeader('Cache-Control', 'no-store');
  const allPostex = rows.every((s) => /^postex$/i.test(String(s.courier || '').trim()));
  if (allPostex && postexConfigured()) {
    if (rows.length > 10) throw new BadRequestError('PostEx prints at most 10 CNs at a time. Select 10 or fewer.');
    let pdf;
    try {
      pdf = await airwayBillPdf(rows.map((s) => s.tracking_number));
    } catch (e) {
      throw new BadRequestError(`PostEx could not print the CN: ${e?.message || 'no answer'}.`);
    }
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="postex-cn-${rows.length}.pdf"`);
    return res.send(pdf);
  }
  const articlesOf = await loadOrderArticles(orders);
  const html = cnSlipsHtml(rows.map((s) => {
    const o = orderOf.get(s.order_id) || {};
    return { remarks: cnRemarks(articlesOf.get(o.id)), courier: s.courier || '', cn: s.tracking_number, order: o.reference, code: o.customer_code, customer: o.customer_name, phone: o.destination_phone, address: o.destination_address, city: [o.destination_city, o.destination_country].filter(Boolean).join(', '), weight: o.weight_kg };
  }));
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  return res.send(html);
});

/**
 * GET /api/partner/warehouse/orders/list?order_ids=a,b,c — the order list for the warehouse team: every order with its QR code and its
 * articles (code, name, quantity, brand, QR code). A printable HTML page.
 */
export const printOrderList = catchAsync(async (req, res) => {
  const ids = [...new Set(String(req.query.order_ids || '').split(',').map((x) => x.trim()).filter(Boolean))];
  if (!ids.length) throw new BadRequestError('Select at least one order.');
  if (ids.length > 100) throw new BadRequestError('Select up to 100 orders at a time.');
  const orders = unwrap(await supabaseAdmin.from('orders').select('id, reference, partner_id, order_kind, return_unit_id, brand, customer_name, customer_code, destination_city, destination_country, shipping_service, weight_kg, created_at').in('id', ids));
  if (orders.length !== ids.length) throw new BadRequestError('One of the selected orders was not found.');
  const can = partnerCanAccess(req);
  if (orders.some((o) => !can(o.partner_id))) throw new ForbiddenError('One of the selected orders belongs to another partner.');
  const articlesOf = await loadOrderArticles(orders);
  const sorted = ids.map((id) => orders.find((o) => o.id === id));
  const html = await orderListHtml(sorted.map((o) => ({ order: o, articles: articlesOf.get(o.id) || [] })));
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  return res.send(html);
});

/** GET /api/partner/warehouse/couriers/api — the couriers that can be booked through their API, and whether the connection answers. */
export const getApiCouriers = catchAsync(async (req, res) => {
  const out = [{ name: 'PostEx', configured: postexConfigured(), ok: null, message: postexConfigured() ? null : 'Not connected: POSTEX_API_TOKEN is not set on the server. PostEx parcels are booked by hand and the CN is typed in.' }];
  if (postexConfigured() && req.query.check === 'true') {
    try {
      await getOperationalCities();
      out[0].ok = true;
    } catch (e) {
      out[0].ok = false;
      out[0].message = e?.message || 'PostEx did not answer.';
    }
  }
  return ApiResponse.success(res, out);
});

/** POST /api/partner/warehouse/shipments/:shipmentId/refresh-tracking — read PostEx's tracking now (PostEx parcels only). */
export const refreshDispatchTracking = catchAsync(async (req, res) => {
  const shipment = await shipmentWithAccess(req, req.params.shipmentId);
  if (!/^postex$/i.test(String(shipment.courier || '').trim())) throw new BadRequestError('Live tracking is only available for parcels booked with PostEx.');
  if (!postexConfigured()) throw new BadRequestError('PostEx tracking is not connected: POSTEX_API_TOKEN is not set on the server.');
  const result = await syncPostexShipment(shipment).catch((e) => { throw new BadRequestError(e?.message || 'PostEx tracking failed.'); });
  return ApiResponse.success(res, result, result.applied ? `${result.applied} new tracking update${result.applied === 1 ? '' : 's'}.` : 'No new tracking updates.');
});

/** POST /api/partner/warehouse/shipments/:shipmentId/received-back — the returned parcel is physically back. */
export const confirmDispatchReturnReceived = catchAsync(async (req, res) => {
  const shipment = await shipmentWithAccess(req, req.params.shipmentId);
  const result = await confirmReturnedToPartner({ shipment, profile: req.profile });
  return ApiResponse.success(res, result.shipment, result.duplicate ? 'Already recorded.' : 'Marked as received back.');
});

/**
 * GET /api/partner/warehouse/transfers?status=open|in_transit|received
 */
export const getTransfers = catchAsync(async (req, res) => {
  const q = parseListQuery(req, { defaultLimit: 10 });
  // ?status=open or ?status=open,in_transit
  const statuses = String(req.query.status || '').split(',').filter((s) => ['open', 'in_transit', 'received'].includes(s));
  let query = supabaseAdmin
    .from('transfers')
    .select('*, orders:orders!orders_transfer_id_fkey(id, reference, customer_name, customer_code, destination_country, weight_kg, status)', { count: 'exact' })
    .order('created_at', { ascending: false })
    .range(q.from, q.to);
  query = scoped(req.access, query);
  if (statuses.length) query = query.in('status', statuses);
  if (q.search) query = query.ilike('code', `%${q.search}%`);
  const result = await query;
  return sendPage(res, unwrap(result), q, result.count);
});

export const dispatchTransfer = catchAsync(async (req, res) => {
  const transfer = unwrapOne(
    await supabaseAdmin.from('transfers').select('*, orders:orders!orders_transfer_id_fkey(id)').eq('id', req.params.id).maybeSingle(),
    'Transfer not found'
  );
  if (transfer.status !== 'open') throw new BadRequestError('This transfer was already dispatched.');
  if (!transfer.orders?.length) throw new BadRequestError('Add at least one parcel to the transfer first.');
  const now = new Date().toISOString();
  unwrap(await supabaseAdmin.from('transfers').update({ status: 'in_transit', dispatched_at: now, updated_at: now }).eq('id', transfer.id));
  for (const o of transfer.orders) await addEvent(o.id, 'paid', `On the way to the dispatch warehouse (${transfer.code})`, req.userId);
  await notifyAdmins({
    type: 'logistics', title: `${transfer.code} on the way`, body: `${transfer.orders.length} parcel(s) dispatched from the partner warehouse.`,
    link: '/admin/warehouse',
  });
  return ApiResponse.success(res, null, `${transfer.code} dispatched to the admin warehouse.`);
});

// ─────────────────────────────── Earnings ───────────────────────────────

export const getEarningsSummary = catchAsync(async (req, res) => {
  const since = startOfMonthISO(5);
  const [paid, issued, packedThisMonth] = await Promise.all([
    partnerInvoices(req.access, 'partner_total_pkr, paid_at').eq('status', 'paid'),
    partnerInvoices(req.access, 'partner_total_pkr').eq('status', 'issued'),
    scoped(req.access, supabaseAdmin.from('job_cards').select('id', { count: 'exact', head: true }).gte('packed_at', startOfMonthISO(0))),
  ]);
  const paidRows = unwrap(paid);
  const monthStart = startOfMonthISO(0);

  const monthly = [];
  for (let i = 5; i >= 0; i--) {
    const d = new Date(startOfMonthISO(i));
    const key = d.toISOString().slice(0, 7);
    monthly.push({
      key,
      month: d.toLocaleString('en-GB', { month: 'short', timeZone: 'UTC' }),
      amount: round2(sum(paidRows.filter((r) => (r.paid_at || '').startsWith(key)), 'partner_total_pkr')),
    });
  }
  const maxMonth = Math.max(1, ...monthly.map((m) => m.amount));

  return ApiResponse.success(res, {
    thisMonth: round2(sum(paidRows.filter((r) => r.paid_at && r.paid_at >= monthStart), 'partner_total_pkr')),
    pending: round2(sum(unwrap(issued), 'partner_total_pkr')),
    lastSixMonths: round2(sum(paidRows.filter((r) => r.paid_at && r.paid_at >= since), 'partner_total_pkr')),
    lifetime: round2(sum(paidRows, 'partner_total_pkr')),
    articlesThisMonth: packedThisMonth.count || 0,
    monthly: monthly.map((m) => ({ ...m, pct: Math.round((m.amount / maxMonth) * 100) })),
  });
});

/**
 * GET /api/partner/earnings?status=paid|issued&search&page
 */
export const getEarnings = catchAsync(async (req, res) => {
  const q = parseListQuery(req, { defaultLimit: 10, sortable: ['issued_at', 'paid_at', 'partner_total_pkr'], defaultSort: 'issued_at' });
  let query = supabaseAdmin
    .from('invoices')
    .select('id, number, status, issued_at, paid_at, partner_total_pkr, order:orders!invoices_order_id_fkey!inner(id, reference, partner_id, customer_name, customer_code, units:order_units!order_units_order_id_fkey(count))', { count: 'exact' })
    .in('status', req.query.status === 'issued' ? ['issued'] : req.query.status === 'paid' ? ['paid'] : ['issued', 'paid'])
    .order(q.sort, { ascending: q.ascending, nullsFirst: false })
    .range(q.from, q.to);
  query = scoped(req.access, query, 'order.partner_id');

  if (q.search) {
    const matches = unwrap(await scoped(req.access, supabaseAdmin.from('orders').select('id').or(ilikeAny(['reference', 'customer_name', 'customer_code'], q.search)).limit(200)));
    const ids = matches.map((m) => m.id);
    query = query.or(ids.length ? `number.ilike.%${q.search}%,order_id.in.(${ids.join(',')})` : `number.ilike.%${q.search}%`);
  }
  const result = await query;
  const invoices = unwrap(result);
  const adjusted = new Map((await adjustUnitCounts(invoices.filter((r) => r.order).map((r) => ({ ...r.order, units_count: r.order.units?.[0]?.count ?? 0, units: undefined })))).map((o) => [o.id, o]));
  const rows = invoices.map((r) => ({ ...r, order: r.order ? adjusted.get(r.order.id) : null }));
  return sendPage(res, rows, q, result.count);
});

/**
 * GET /api/partner/orders?search&page&sort&dir — every order of this partner (server-side search and paging).
 * `current_status` = where the articles are now (production stages); `parent_status` = the order's own status.
 */
export const getPartnerOrders = catchAsync(async (req, res) => {
  const q = parseListQuery(req, { defaultLimit: 10, sortable: ['created_at', 'due_date', 'reference', 'customer_name'], defaultSort: 'created_at' });
  const buildList = (logoSelect) => scoped(req.access, supabaseAdmin
    .from('orders')
        .select(`id, reference, brand, created_at, due_date, customer_name, customer_code, status, order_kind, return_unit_id${logoSelect}, units:order_units!order_units_order_id_fkey(count)`, { count: 'exact' })
    .order(q.sort, { ascending: q.ascending, nullsFirst: false })
    .range(q.from, q.to));
  const listQuery = (logoSelect) => {
    let query = buildList(logoSelect);
    if (q.search) query = query.or(ilikeAny(['reference', 'customer_name', 'customer_code', 'brand', 'brand_order_number'], q.search));
    return query;
  };
  // the brand's logo comes with database update 0037: until then the list works without it
  let result = await listQuery(', brand_ref:brands!orders_brand_id_fkey(id, name, logo_url)');
  if (result.error && /logo_url|brand_ref|brands/.test(result.error.message || '')) result = await listQuery('');
  // an article sent to the Warehouse counts on its return order, not on the original (same rule as the admin list)
  const rows = (await adjustUnitCounts(unwrap(result).map((o) => ({ ...o, units_count: o.units?.[0]?.count ?? 0 })))).map(({ units_count, ...o }) => ({ ...o, units: [{ count: units_count }] }));
  const cards = rows.length ? unwrap(await supabaseAdmin.from('job_cards').select('order_id, stage').in('order_id', rows.map((o) => o.id))) : [];
  const stagesOf = new Map();
  for (const c of cards) {
    const m = stagesOf.get(c.order_id) || new Map();
    m.set(c.stage, (m.get(c.stage) || 0) + 1);
    stagesOf.set(c.order_id, m);
  }
  const items = rows.map(({ units, brand_ref, ...o }) => {
    const stages = stagesOf.get(o.id);
    const brandRow = Array.isArray(brand_ref) ? brand_ref[0] : brand_ref;
    return {
      ...o,
      brand_logo_url: brandRow?.logo_url ?? null,
      articles: units?.[0]?.count ?? 0,
      parent_status: o.status,
      parent_status_label: STATUS_LABELS[o.status] || o.status,
      current_status: stages
        ? [...stages.entries()].map(([stage, n]) => `${n} ${STAGE_LABELS[stage] || stage}`).join(' · ')
        : o.order_kind === 'return' ? 'Return shipment' : STATUS_LABELS[o.status] || o.status,
    };
  });
  return sendPage(res, items, q, result.count);
});

/** Money and contact details never reach the partner through an event's note. */
const SENSITIVE_NOTE = /(pkr|usd|gbp|eur|aed|invoice|payment|paid|refund|stripe|@|\+?\d[\d\s-]{8,})/i;
const PARTNER_TIMELINE_LABELS = { ...STATUS_LABELS };

/**
 * GET /api/partner/orders/:id — one order for the partner's side panel. Only what the workshop needs: the customer's NAME and
 * delivery ADDRESS (never their phone or email), the articles, the order's status history, and what this partner earns on it.
 * Admin notes, invoice and payment amounts are not part of this response.
 */
export const getPartnerOrder = catchAsync(async (req, res) => {
  const order = unwrapOne(
    await scoped(req.access, supabaseAdmin
      .from('orders')
      .select('id, reference, brand, brand_order_number, status, order_kind, created_at, due_date, received_at, packed_at, shipped_at, delivered_at, customer_name, customer_code, destination_address, destination_city, destination_country, customer_notes, express_stitching, express_days, priority, express_shipping, express_shipping_days, return_unit_id')
      .eq('id', req.params.id)).maybeSingle(),
    'Order not found'
  );
  const brandRow = order.brand ? (await supabaseAdmin.from('brands').select('name, logo_url').ilike('name', order.brand).maybeSingle().then((x) => (x.error ? { data: null } : x))).data : null;
  const [unitsRes, eventsRes, invoiceRes] = await Promise.all([
    supabaseAdmin
      .from('order_units')
      .select('id, code, line_no, unit_title, quantity, status, notes, product_image_url, stitching_type, design, size_snapshot, picks:order_unit_articles(article_type_id, type:article_types(name, sort_order), article:articles(name, image_url))')
      .eq('order_id', order.id)
      .order('line_no'),
    supabaseAdmin.from('order_events').select('id, status, note, created_at').eq('order_id', order.id).order('created_at', { ascending: true }),
    supabaseAdmin.from('invoices').select('status, partner_total_pkr').eq('order_id', order.id).maybeSingle(),
  ]);
  const one = (v) => (Array.isArray(v) ? v[0] : v);
  const units = unwrap(unitsRes).map((u) => {
    const chart = u.size_snapshot || null;
    return {
      id: u.id,
      code: u.code,
      line_no: u.line_no,
      title: u.unit_title,
      quantity: u.quantity,
      image_url: u.product_image_url,
      stitching_type: u.stitching_type,
      notes: u.notes,
      size: chart ? { name: chart.name || null, person: chart.person_name || null, nearest: chart.nearest_size || null, measurements: chart.measurements || {} } : null,
      customizations: (u.picks || [])
        .map((p) => ({ type: one(p.type)?.name ?? null, sort: one(p.type)?.sort_order ?? 0, name: one(p.article)?.name ?? null, image_url: one(p.article)?.image_url ?? null }))
        .sort((a, b) => a.sort - b.sort)
        .map(({ sort, ...x }) => x),
    };
  });
  const timeline = unwrap(eventsRes)
    .map((e) => ({ id: e.id, status: e.status, label: PARTNER_TIMELINE_LABELS[e.status] || e.status, note: e.note && !SENSITIVE_NOTE.test(e.note) ? e.note : null, at: e.created_at }));

  // the partner's own share, from the invoice's partner total (the same figure as Earnings): earned once paid, pending until then
  const inv = unwrap(invoiceRes);
  const earnings = !inv || inv.status === 'draft' || inv.status === 'void'
    ? { state: 'unavailable', amount_pkr: null }
    : inv.status === 'paid'
      ? { state: 'earned', amount_pkr: Number(inv.partner_total_pkr) }
      : { state: 'pending', amount_pkr: Number(inv.partner_total_pkr) };

  return ApiResponse.success(res, {
    id: order.id,
    reference: order.reference,
    order_kind: order.order_kind,
    status: order.status,
    status_label: STATUS_LABELS[order.status] || order.status,
    created_at: order.created_at,
    due_date: order.due_date,
    brand: { name: order.brand, logo_url: brandRow?.logo_url ?? null, order_number: order.brand_order_number },
    customer: { name: order.customer_name, code: order.customer_code },
    delivery: { address: order.destination_address, city: order.destination_city, country: order.destination_country },
    notes: order.customer_notes,
    express: { stitching: order.express_stitching ? order.express_days : null, shipping: order.express_shipping ? order.express_shipping_days : null, rush: order.priority === 'rush' },
    units,
    timeline,
    earnings,
  });
});

/**
 * GET /api/partner/badges — sidebar counters
 */
export const getPartnerBadges = catchAsync(async (req, res) => {
  const zero = Promise.resolve({ count: 0 });
  const [receiving, qc, warehouse, transfers, messages] = await Promise.all([
    can(req.access, 'receiving.view') ? scoped(req.access, supabaseAdmin.from('orders').select('id', { count: 'exact', head: true }).eq('status', 'submitted')) : zero,
    can(req.access, 'quality.view') ? scoped(req.access, supabaseAdmin.from('job_cards').select('id', { count: 'exact', head: true }).eq('stage', 'qc').eq('qc_passed', false)) : zero,
    can(req.access, 'warehouse.view') ? scoped(req.access, supabaseAdmin.from('orders').select('id', { count: 'exact', head: true }).eq('status', 'paid').is('partner_route', null)) : zero,
    can(req.access, 'warehouse.view') ? scoped(req.access, supabaseAdmin.from('transfers').select('id', { count: 'exact', head: true }).eq('status', 'open')) : zero,
    can(req.access, 'messages.view') ? unreadConversationCount(scopeOf(req.access), { excludeGeneral: !can(req.access, 'general_messages.view') }) : 0,
  ]);
  return ApiResponse.success(res, {
    messages,
    receiving: receiving.count || 0,
    qualityCheck: qc.count || 0,
    warehouse: (warehouse.count || 0) + (transfers.count || 0),
  });
});

// ───────────── parcels that reached the wrong partner ─────────────

const OTHER_PARTNER = 'id, name, short_code, city, receiving_name, receiving_address, receiving_city, receiving_phone';
const firstOf = (v) => (Array.isArray(v) ? v[0] ?? null : v ?? null);

/**
 * GET /api/partner/receiving/elsewhere?q=
 * A parcel arrived but its code is not among this partner's orders: look for it among the orders waiting for their parcel at
 * OTHER partners, so the partner can see where the customer was told to send it and forward it there.
 */
export const findParcelElsewhere = catchAsync(async (req, res) => {
  const q = String(req.query.q ?? '').trim();
  const scope = scopeOf(req.access);
  if (q.length < 3 || scope === undefined) return ApiResponse.success(res, []);
  const rows = unwrap(
    await supabaseAdmin
      .from('orders')
      .select(`id, reference, customer_code, customer_name, tracking_number, status, created_at, partner:partners!orders_partner_id_fkey(${OTHER_PARTNER})`)
      .neq('partner_id', scope)
      .eq('status', 'submitted')
      .or(ilikeAny(['reference', 'customer_code', 'tracking_number'], q))
      .order('created_at', { ascending: false })
      .limit(5),
    'Could not search the other partners'
  );
  return ApiResponse.success(res, rows.map((o) => ({ ...o, partner: firstOf(o.partner) })));
});

/**
 * POST /api/partner/receiving/orders/:orderId/forward
 * This partner got a parcel that belongs to another partner's order and sent it on. The right partner, the admin and the
 * customer are told, and the order's timeline records it. The order itself does not change: the right partner receives it.
 */
export const forwardParcel = catchAsync(async (req, res) => {
  const scope = scopeOf(req.access);
  const order = unwrapOne(
    await supabaseAdmin
      .from('orders')
      .select(`id, reference, status, partner_id, customer_id, customer_name, customer_code, partner:partners!orders_partner_id_fkey(${OTHER_PARTNER})`)
      .eq('id', req.params.orderId)
      .maybeSingle(),
    'Order not found'
  );
  if (scope !== undefined && order.partner_id === scope) throw new BadRequestError('This order belongs to your partner: receive it here as usual.');
  if (order.status !== 'submitted') throw new BadRequestError('This order is not waiting for its parcel any more.');
  const target = firstOf(order.partner);
  if (!target) throw new BadRequestError('This order has no partner yet. Ask the admin to assign one.');

  const fromName = req.access.partner?.name || 'the admin team';
  await addEvent(order.id, order.status, `The parcel reached ${fromName} by mistake and was sent on to ${target.name}.`, req.userId);
  await notifyPartner(
    {
      partnerId: order.partner_id,
      type: 'order',
      title: `Parcel for ${order.reference} is on its way to you`,
      body: `${fromName} received it by mistake and forwarded it. Customer ${order.customer_name} (${order.customer_code}).`,
      link: { partner_staff: `/partner/receiving?search=${order.customer_code}` },
      orderId: order.id,
    },
    null,
    { module: 'receiving' }
  );
  await notifyAdmins({ type: 'order', title: `Parcel for ${order.reference} forwarded`, body: `${fromName} forwarded it to ${target.name}.`, link: `/admin/orders?ref=${order.reference}`, orderId: order.id }, req.userId);
  await notifyUser(order.customer_id, {
    type: 'order',
    title: `Your parcel for ${order.reference} was forwarded`,
    body: `It reached ${fromName} and was sent on to ${target.name}, the partner you chose. There is nothing you need to do.`,
    link: `/app/orders/${order.id}`,
    orderId: order.id,
  });
  return ApiResponse.success(res, { id: order.id, reference: order.reference, forwarded_to: target.name }, `Noted. ${target.name} has been told to expect ${order.reference}.`);
});
