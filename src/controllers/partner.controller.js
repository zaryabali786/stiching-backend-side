import { supabaseAdmin } from '../config/supabase.js';
import { catchAsync, ApiResponse, BadRequestError, ConflictError, ForbiddenError } from '../utils/error.helper.js';
import { createUser } from '../services/partner-users.service.js';
import { invalidateProfile } from '../middlewares/auth.middleware.js';
import { parseListQuery, sendPage, ilikeAny } from '../utils/pagination.js';
import { unwrap, unwrapOne, todayISO, daysAgoISO, startOfMonthISO, sum, round2 } from '../utils/db.js';
import { syncReceiving, setOrderStatus, addEvent, getOrderOr404, STATUS_LABELS } from '../services/order.service.js';
import { getTeamWithLoad, suggestAssignees } from '../services/team.service.js';
import { uploadDataUrls } from '../services/storage.service.js';
import { notifyAdmins, notifyUser } from '../services/notification.service.js';
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
  id, reference, partner_id, brand, brand_order_number, tracking_number, status, has_issue, customer_name, customer_code,
  destination_city, destination_country, priority, due_date, customer_notes, created_at, received_at,
  units:order_units!order_units_order_id_fkey(id, unit_title, stitching_type, notes, quantity, status, issue_type, issue_note, issue_media, received_at, line_no, design, created_at)
`;

/**
 * GET /api/partner/receiving?tab=expected|issues|recent&search&page
 */
export const getReceiving = catchAsync(async (req, res) => {
  const q = parseListQuery(req, { defaultLimit: 10 });
  const tab = ['expected', 'issues', 'recent'].includes(req.query.tab) ? req.query.tab : 'expected';

  const scopeTab = (query) => {
    if (tab === 'expected') return query.eq('status', 'submitted');
    if (tab === 'issues') return query.eq('has_issue', true).not('status', 'in', '(cancelled,delivered)');
    return query.neq('status', 'submitted').gte('received_at', daysAgoISO(7));
  };

  let query = scoped(req.access, scopeTab(supabaseAdmin.from('orders').select(RECEIVING_SELECT, { count: 'exact' })))
    .order(tab === 'recent' ? 'received_at' : 'created_at', { ascending: tab !== 'recent' })
    .range(q.from, q.to);
  if (q.search) query = query.or(ilikeAny(['reference', 'customer_code', 'customer_name', 'brand', 'tracking_number', 'brand_order_number'], q.search));

  const [result, expected, issues, recent] = await Promise.all([
    query,
    scoped(req.access, supabaseAdmin.from('orders').select('id', { count: 'exact', head: true }).eq('status', 'submitted')),
    scoped(req.access, supabaseAdmin.from('orders').select('id', { count: 'exact', head: true }).eq('has_issue', true).not('status', 'in', '(cancelled,delivered)')),
    scoped(req.access, supabaseAdmin.from('orders').select('id', { count: 'exact', head: true }).neq('status', 'submitted').gte('received_at', daysAgoISO(7))),
  ]);
  const rows = unwrap(result).map((o) => ({
    ...o,
    units: (o.units || []).sort((a, b) => a.line_no - b.line_no),
    status_label: STATUS_LABELS[o.status],
  }));
  const suggestion = tab === 'expected' && rows.length ? await suggestAssignees(null, scopeOf(req.access)) : null;

  return sendPage(res, rows, q, result.count, {
    counts: { expected: expected.count || 0, issues: issues.count || 0, recent: recent.count || 0 },
    suggestion,
  });
});

const loadUnit = async (unitId) =>
  unwrapOne(await supabaseAdmin.from('order_units').select('*, order:orders!order_units_order_id_fkey(id, reference, status, customer_id, customer_name)').eq('id', unitId).maybeSingle(), 'Unit not found');

export const receiveUnit = catchAsync(async (req, res) => {
  const unit = await loadUnit(req.params.unitId);
  if (unit.order.status === 'cancelled') throw new BadRequestError('This order was cancelled.');
  unwrap(await supabaseAdmin.from('order_units').update({
    status: 'received', received_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  }).eq('id', unit.id));
  if (unit.status === 'issue') {
    await addEvent(unit.order.id, unit.order.status, `Issue resolved for "${unit.unit_title}" · unit received`, req.userId);
    await logUnitEvent(unit.id, unit.order.id, 'issue_resolved', { actorId: req.userId });
  }
  await logUnitEvent(unit.id, unit.order.id, 'received', { actorId: req.userId });
  const summary = await syncReceiving(unit.order.id, req.userId);
  return ApiResponse.success(res, summary, `${unit.unit_title} received.`);
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
  unwrap(await supabaseAdmin.from('order_units').update({
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
  const summary = await syncReceiving(unit.order.id, req.userId);
  return ApiResponse.success(res, summary, 'Issue reported. The admin team has been notified.');
});

export const receiveAllUnits = catchAsync(async (req, res) => {
  const order = await getOrderOr404(req.params.orderId);
  if (order.status === 'cancelled') throw new BadRequestError('This order was cancelled.');
  const pendingUnits = unwrap(await supabaseAdmin.from('order_units').select('id').eq('order_id', order.id).eq('status', 'pending'));
  for (const u of pendingUnits) await logUnitEvent(u.id, order.id, 'received', { actorId: req.userId });
  unwrap(await supabaseAdmin.from('order_units').update({
    status: 'received', received_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  }).eq('order_id', order.id).eq('status', 'pending'));
  const summary = await syncReceiving(order.id, req.userId);
  return ApiResponse.success(res, summary, 'All pending units received.');
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
    if (!['master', 'tailor'].includes(b.role)) throw new BadRequestError('Role must be master or tailor.');
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
  if (patch.name !== undefined) change.full_name = patch.name;
  if (!Object.keys(change).length) return;
  await supabaseAdmin.from('profiles').update({ ...change, updated_at: new Date().toISOString() }).eq('id', member.user_id);
  invalidateProfile(member.user_id);
};

export const createTeamMember = catchAsync(async (req, res) => {
  const row = cleanMember(req.body || {});
  if (row.role === 'tailor' && !row.master_id) throw new BadRequestError('Choose which master this tailor works under.');
  if (row.role === 'master') row.master_id = null;
  row.partner_id = await partnerForWrite(req.access, req.body?.partner_id);
  if (row.master_id) await assertMemberOfPartner(row.master_id, row.partner_id, 'Master');
  const login = req.body?.login;
  if (login && !can(req.access, 'users.create')) throw new ForbiddenError('You need the Users permission to create a login.');
  const created = unwrap(await supabaseAdmin.from('team_members').insert(row).select('*').single());
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

export const updateTeamMember = catchAsync(async (req, res) => {
  const patch = cleanMember(req.body || {}, true);
  if (patch.master_id) {
    const current = unwrapOne(await supabaseAdmin.from('team_members').select('partner_id').eq('id', req.params.id).maybeSingle(), 'Team member not found');
    await assertMemberOfPartner(patch.master_id, current.partner_id, 'Master');
  }
  const updated = unwrap(await supabaseAdmin.from('team_members').update({ ...patch, updated_at: new Date().toISOString() }).eq('id', req.params.id).select('*').single());
  await syncLogin(updated, patch);
  return ApiResponse.success(res, updated, `${updated.name} updated.`);
});

export const deactivateTeamMember = catchAsync(async (req, res) => {
  const member = unwrapOne(await supabaseAdmin.from('team_members').select('*').eq('id', req.params.id).maybeSingle(), 'Team member not found');
  unwrap(await supabaseAdmin.from('team_members').update({ is_active: false, updated_at: new Date().toISOString() }).eq('id', member.id));
  await syncLogin(member, { is_active: false });
  return ApiResponse.success(res, null, `${member.name} removed from active teams.`);
});

// ─────────────────────────────── Warehouse ───────────────────────────────

const WAREHOUSE_TABS = {
  to_invoice: (q) => q.eq('status', 'packed'),
  awaiting_payment: (q) => q.in('status', ['invoice_issued', 'awaiting_payment']),
  paid: (q) => q.eq('status', 'paid').is('partner_route', null),
  dispatched: (q) => q.not('partner_route', 'is', null).in('status', ['paid', 'partner_dispatch', 'at_admin_warehouse', 'shipped', 'delivered']),
};

const WAREHOUSE_SELECT = `
  id, reference, brand, status, customer_name, customer_code, destination_city, destination_country, destination_address,
  shipping_service, weight_kg, partner_route, packed_at, paid_at, created_at,
  units:order_units!order_units_order_id_fkey(count),
  invoice:invoices!invoices_order_id_fkey(id, number, status, issued_at, total_pkr, currency, total_foreign),
  transfer:transfers!orders_transfer_id_fkey(id, code, status),
  shipment:shipments!shipments_order_id_fkey(id, status, courier, tracking_number, shipped_from)
`;

/**
 * GET /api/partner/warehouse?tab=to_invoice|awaiting_payment|paid|dispatched&search&page
 */
export const getPartnerWarehouse = catchAsync(async (req, res) => {
  const q = parseListQuery(req, { defaultLimit: 10, sortable: ['created_at', 'packed_at', 'paid_at'], defaultSort: 'packed_at' });
  const tab = WAREHOUSE_TABS[req.query.tab] ? req.query.tab : 'paid';

  let query = scoped(req.access, WAREHOUSE_TABS[tab](supabaseAdmin.from('orders').select(WAREHOUSE_SELECT, { count: 'exact' })))
    .order(q.sort, { ascending: q.ascending, nullsFirst: false })
    .range(q.from, q.to);
  if (q.search) query = query.or(ilikeAny(['reference', 'customer_code', 'customer_name', 'destination_city', 'destination_country'], q.search));

  const countFor = (key) => scoped(req.access, WAREHOUSE_TABS[key](supabaseAdmin.from('orders').select('id', { count: 'exact', head: true })));
  const [result, ...counts] = await Promise.all([query, ...Object.keys(WAREHOUSE_TABS).map(countFor)]);

  const rows = unwrap(result).map((o) => ({
    ...o,
    units_count: o.units?.[0]?.count ?? 0,
    units: undefined,
    invoice: one(o.invoice),
    shipment: one(o.shipment),
    status_label: STATUS_LABELS[o.status],
  }));
  const countMap = Object.fromEntries(Object.keys(WAREHOUSE_TABS).map((k, i) => [k, counts[i].count || 0]));
  return sendPage(res, rows, q, result.count, { counts: countMap });
});

export const setOrderWeight = catchAsync(async (req, res) => {
  const weight = Number(req.body?.weight_kg);
  if (!(weight > 0 && weight < 50)) throw new BadRequestError('Enter a weight between 0 and 50 kg.');
  unwrap(await supabaseAdmin.from('orders').update({ weight_kg: weight, updated_at: new Date().toISOString() }).eq('id', req.params.id));
  return ApiResponse.success(res, { weight_kg: weight }, 'Weight saved.');
});

/**
 * POST /api/partner/warehouse/orders/:id/route  body: { route: 'admin_warehouse' | 'direct_dispatch' }
 */
export const setDispatchRoute = catchAsync(async (req, res) => {
  const route = req.body?.route;
  if (!['admin_warehouse', 'direct_dispatch'].includes(route)) throw new BadRequestError('Choose a dispatch route.');
  const order = await getOrderOr404(req.params.id);
  if (order.status !== 'paid' || order.partner_route) throw new BadRequestError('Only paid orders without a route can be dispatched.');

  if (route === 'admin_warehouse') {
    // one open transfer per partner: parcels of different partners are never batched together
    let openQuery = supabaseAdmin.from('transfers').select('*').eq('status', 'open').order('created_at').limit(1);
    openQuery = order.partner_id ? openQuery.eq('partner_id', order.partner_id) : openQuery.is('partner_id', null);
    let transfer = unwrap(await openQuery.maybeSingle());
    if (!transfer) transfer = unwrap(await supabaseAdmin.from('transfers').insert({ created_by: req.userId, partner_id: order.partner_id }).select('*').single());
    unwrap(await supabaseAdmin.from('orders').update({ partner_route: route, transfer_id: transfer.id, updated_at: new Date().toISOString() }).eq('id', order.id));
    await addEvent(order.id, order.status, `Added to transfer ${transfer.code} for the dispatch warehouse`, req.userId);
    return ApiResponse.success(res, { transfer }, `Added to ${transfer.code}. Dispatch the transfer when the batch is ready.`);
  }

  await setOrderStatus(order.id, 'partner_dispatch', { note: 'Partner will dispatch directly to the customer', actorId: req.userId, extra: { partner_route: route } });
  unwrap(await supabaseAdmin.from('shipments').upsert({
    order_id: order.id, shipped_from: 'partner', status: 'needs_label', weight_kg: order.weight_kg, service: order.shipping_service,
  }, { onConflict: 'order_id' }));
  return ApiResponse.success(res, null, 'Marked for direct dispatch. Enter the courier and tracking number once handed over.');
});

/**
 * POST /api/partner/warehouse/orders/:id/ship  body: { courier_id, tracking_number }  (direct dispatch only; courier from Catalogue > Couriers)
 */
export const shipDirect = catchAsync(async (req, res) => {
  const tracking = String(req.body?.tracking_number || '').trim();
  const { name: courier } = await resolveCourier(req.body); // from the managed courier list
  if (!tracking) throw new BadRequestError('Enter the tracking number.');
  const order = await getOrderOr404(req.params.id);
  if (order.status !== 'partner_dispatch') throw new BadRequestError('This order is not marked for direct dispatch.');

  const now = new Date().toISOString();
  unwrap(await supabaseAdmin.from('shipments').upsert({
    order_id: order.id, shipped_from: 'partner', status: 'handed_to_courier', courier, tracking_number: tracking,
    weight_kg: order.weight_kg, label_printed_at: now, handed_at: now, updated_at: now,
  }, { onConflict: 'order_id' }));
  await setOrderStatus(order.id, 'shipped', { note: `Shipped by ${courier} · tracking ${tracking}`, actorId: req.userId, extra: { shipped_at: now } });
  await notifyUser(order.customer_id, {
    type: 'logistics', title: `Shipped: ${order.reference}`, body: `Your order is on its way with ${courier}. Tracking number: ${tracking}.`,
    link: `/app/orders/${order.id}`, orderId: order.id,
  });
  return ApiResponse.success(res, null, 'Marked as shipped. The customer has been notified.');
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
  const rows = unwrap(result).map((r) => ({ ...r, order: r.order ? { ...r.order, units_count: r.order.units?.[0]?.count ?? 0, units: undefined } : null }));
  return sendPage(res, rows, q, result.count);
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
    can(req.access, 'messages.view') ? unreadConversationCount(scopeOf(req.access)) : 0,
  ]);
  return ApiResponse.success(res, {
    messages,
    receiving: receiving.count || 0,
    qualityCheck: qc.count || 0,
    warehouse: (warehouse.count || 0) + (transfers.count || 0),
  });
});
