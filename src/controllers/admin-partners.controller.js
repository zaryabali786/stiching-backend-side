import { supabaseAdmin } from '../config/supabase.js';
import { catchAsync, ApiResponse, BadRequestError, ConflictError, NotFoundError } from '../utils/error.helper.js';
import { parseListQuery, sendPage, ilikeAny } from '../utils/pagination.js';
import { unwrap, unwrapOne, startOfMonthISO, sum, round2 } from '../utils/db.js';
import { PARTNER_MODULES, normalizePermissions } from '../config/permissions.js';
import { invalidatePartner } from '../services/access.service.js';
import { invalidatePartnerUsers } from '../middlewares/auth.middleware.js';
import { getTeamWithLoad } from '../services/team.service.js';
import { createUser, listUsers, updateUser, resetPassword, deactivateUser, USER_COLUMNS } from '../services/partner-users.service.js';
import { notifyUser } from '../services/notification.service.js';
import { addEvent, getOrderOr404, STATUS_LABELS } from '../services/order.service.js';

const actorOf = (req) => ({ profile: req.profile, access: req.access });

const cleanName = (value) => {
  const name = String(value ?? '').trim();
  if (name.length < 2 || name.length > 100) throw new BadRequestError('The partner name must be 2 to 100 characters.');
  return name;
};

const cleanPerms = (list) => {
  try {
    return normalizePermissions(list ?? []);
  } catch (err) {
    throw new BadRequestError(err.message);
  }
};

const loadPartnerRow = async (id) => unwrapOne(await supabaseAdmin.from('partners').select('*').eq('id', id).maybeSingle(), 'Partner not found');

/** GET /api/admin/permissions — the module catalogue the permission pickers are built from */
export const getPermissionCatalogue = catchAsync(async (req, res) => ApiResponse.success(res, { modules: PARTNER_MODULES }));

/** GET /api/admin/partners?search&status&page&limit */
export const listPartners = catchAsync(async (req, res) => {
  const q = parseListQuery(req, { defaultLimit: 20, sortable: ['name', 'created_at', 'status'], defaultSort: 'name', defaultDir: 'asc' });
  let query = supabaseAdmin.from('partners').select('*', { count: 'exact' }).order(q.sort, { ascending: q.ascending }).range(q.from, q.to);
  if (['active', 'inactive'].includes(req.query.status)) query = query.eq('status', req.query.status);
  if (q.search) query = query.or(ilikeAny(['name'], q.search));
  const result = await query;
  const partners = unwrap(result, 'Could not load partners');
  const ids = partners.map((p) => p.id);

  const counts = { users: {}, orders: {}, cards: {}, owner: {} };
  if (ids.length) {
    const [users, orders, cards] = await Promise.all([
      supabaseAdmin.from('profiles').select('partner_id, partner_role, full_name, email, is_active').eq('role', 'partner_staff').in('partner_id', ids),
      supabaseAdmin.from('orders').select('partner_id').in('partner_id', ids).not('status', 'in', '(delivered,cancelled)'),
      supabaseAdmin.from('job_cards').select('partner_id').in('partner_id', ids).neq('stage', 'packed'),
    ]);
    for (const u of unwrap(users)) {
      counts.users[u.partner_id] = (counts.users[u.partner_id] || 0) + 1;
      if (u.partner_role === 'owner') counts.owner[u.partner_id] = { full_name: u.full_name, email: u.email, is_active: u.is_active };
    }
    for (const o of unwrap(orders)) counts.orders[o.partner_id] = (counts.orders[o.partner_id] || 0) + 1;
    for (const c of unwrap(cards)) counts.cards[c.partner_id] = (counts.cards[c.partner_id] || 0) + 1;
  }
  const rows = partners.map((p) => ({
    ...p,
    owner: counts.owner[p.id] || null,
    users_count: counts.users[p.id] || 0,
    active_orders: counts.orders[p.id] || 0,
    in_production: counts.cards[p.id] || 0,
  }));
  return sendPage(res, rows, q, result.count, { modules: PARTNER_MODULES });
});

/** GET /api/admin/partners/:id — the partner with its team and figures */
export const getPartner = catchAsync(async (req, res) => {
  const partner = await loadPartnerRow(req.params.id);
  const [team, owner, payable, inProduction, activeOrders] = await Promise.all([
    getTeamWithLoad({ partnerId: partner.id }),
    supabaseAdmin.from('profiles').select(USER_COLUMNS).eq('partner_id', partner.id).eq('partner_role', 'owner').maybeSingle(),
    supabaseAdmin.from('invoices').select('partner_total_pkr, status, order:orders!invoices_order_id_fkey!inner(partner_id)').in('status', ['issued', 'paid']).eq('order.partner_id', partner.id).gte('issued_at', startOfMonthISO(0)),
    supabaseAdmin.from('job_cards').select('id', { count: 'exact', head: true }).eq('partner_id', partner.id).neq('stage', 'packed'),
    supabaseAdmin.from('orders').select('id', { count: 'exact', head: true }).eq('partner_id', partner.id).not('status', 'in', '(delivered,cancelled)'),
  ]);
  const tailors = team.members.filter((m) => m.role === 'tailor');
  const capacity = tailors.reduce((a, t) => a + (t.daily_capacity || 0), 0);
  const assigned = team.members.reduce((a, m) => a + m.assigned, 0);
  const payableRows = unwrap(payable);
  return ApiResponse.success(res, {
    partner,
    owner: owner.data || null,
    stats: {
      activeMasters: team.masters.length,
      activeTailors: tailors.length,
      dailyCapacity: capacity,
      currentLoadPct: capacity ? Math.round((assigned / capacity) * 100) : 0,
      inProduction: inProduction.count || 0,
      activeOrders: activeOrders.count || 0,
      payoutThisMonthPkr: round2(sum(payableRows, 'partner_total_pkr')),
      payoutPaidThisMonthPkr: round2(sum(payableRows.filter((r) => r.status === 'paid'), 'partner_total_pkr')),
    },
    masters: team.masters,
    unassignedTailors: team.unassignedTailors,
    modules: PARTNER_MODULES,
  });
});

/**
 * POST /api/admin/partners
 * body: { name, permissions: ['production.view', ...], is_default?, owner: { email, full_name, phone?, job_title?, password? } }
 * The owner's login is created together with the partner; the temporary password is returned once.
 */
export const createPartner = catchAsync(async (req, res) => {
  const b = req.body || {};
  const name = cleanName(b.name);
  const permissions = cleanPerms(b.permissions);
  if (!permissions.length) throw new BadRequestError('Enable at least one module for this partner.');
  if (!b.owner?.email) throw new BadRequestError('Enter the owner’s email: the partner signs in with it.');

  const dupe = await supabaseAdmin.from('partners').select('id').ilike('name', name.replace(/[%_\\]/g, (c) => `\\${c}`)).maybeSingle();
  if (dupe.data) throw new ConflictError(`A partner called "${name}" already exists.`);

  const { count } = await supabaseAdmin.from('partners').select('id', { count: 'exact', head: true });
  const partner = unwrap(
    await supabaseAdmin.from('partners').insert({ name, permissions, status: 'active', is_default: !count, created_by: req.userId }).select('*').single(),
    'Could not create the partner'
  );
  let created;
  try {
    created = await createUser(actorOf(req), partner.id, b.owner, { owner: true });
  } catch (err) {
    await supabaseAdmin.from('partners').delete().eq('id', partner.id); // no half-created partner without a login
    throw err;
  }
  if (b.is_default === true) await makeDefault(partner.id);
  return ApiResponse.created(
    res,
    { partner: { ...partner, is_default: b.is_default === true || partner.is_default }, owner: created.user, temporaryPassword: created.temporaryPassword },
    `${name} created. Share the owner's temporary password once; they must choose their own at first sign-in.`
  );
});

const makeDefault = async (partnerId) => {
  unwrap(await supabaseAdmin.from('partners').update({ is_default: false }).eq('is_default', true).neq('id', partnerId));
  unwrap(await supabaseAdmin.from('partners').update({ is_default: true, status: 'active' }).eq('id', partnerId));
};

/** PATCH /api/admin/partners/:id  body: { name?, status?, permissions?, is_default? } */
export const updatePartner = catchAsync(async (req, res) => {
  const partner = await loadPartnerRow(req.params.id);
  const b = req.body || {};
  const patch = {};
  if (b.name !== undefined) {
    patch.name = cleanName(b.name);
    const dupe = await supabaseAdmin.from('partners').select('id').ilike('name', patch.name.replace(/[%_\\]/g, (c) => `\\${c}`)).neq('id', partner.id).maybeSingle();
    if (dupe.data) throw new ConflictError(`A partner called "${patch.name}" already exists.`);
  }
  if (b.status !== undefined) {
    if (!['active', 'inactive'].includes(b.status)) throw new BadRequestError('Status must be active or inactive.');
    if (b.status === 'inactive' && partner.is_default) throw new BadRequestError('Choose another default partner before switching this one off.');
    patch.status = b.status;
  }
  if (b.permissions !== undefined) {
    patch.permissions = cleanPerms(b.permissions);
    if (!patch.permissions.length) throw new BadRequestError('Enable at least one module, or switch the partner off instead.');
  }
  if (b.is_default === false && partner.is_default) throw new BadRequestError('Make another partner the default instead.');
  if (!Object.keys(patch).length && b.is_default !== true) throw new BadRequestError('Nothing to update.');

  let updated = partner;
  if (Object.keys(patch).length) updated = unwrap(await supabaseAdmin.from('partners').update(patch).eq('id', partner.id).select('*').single(), 'Could not update the partner');
  if (b.is_default === true && !partner.is_default) {
    if ((patch.status ?? partner.status) !== 'active') throw new BadRequestError('Only an active partner can be the default.');
    await makeDefault(partner.id);
    updated = { ...updated, is_default: true };
  }

  // modules that were taken away from the partner disappear from its users too (they do not silently come back later)
  if (patch.permissions) {
    const ceiling = new Set(patch.permissions);
    const members = unwrap(await supabaseAdmin.from('profiles').select('id, permissions').eq('partner_id', partner.id).eq('partner_role', 'member'));
    for (const m of members) {
      const kept = (m.permissions || []).filter((p) => ceiling.has(p));
      if (kept.length !== (m.permissions || []).length) await supabaseAdmin.from('profiles').update({ permissions: kept }).eq('id', m.id);
    }
  }
  invalidatePartner(partner.id);
  invalidatePartnerUsers(partner.id);

  if (patch.permissions) {
    const owner = (await supabaseAdmin.from('profiles').select('id').eq('partner_id', partner.id).eq('partner_role', 'owner').maybeSingle()).data;
    if (owner) await notifyUser(owner.id, { type: 'update', title: 'Your access was updated', body: 'The admin changed which modules your account can use.', link: '/partner/overview' });
  }
  return ApiResponse.success(res, updated, 'Partner updated.');
});

// ───────────────────────── a partner's users (admin view) ─────────────────────────

export const listAdminPartnerUsers = catchAsync(async (req, res) => {
  const partner = await loadPartnerRow(req.params.id);
  const q = parseListQuery(req, { defaultLimit: 50 });
  const { rows, total } = await listUsers(actorOf(req), partner.id, { search: q.search, from: q.from, to: q.to });
  return sendPage(res, rows, q, total);
});

export const createAdminPartnerUser = catchAsync(async (req, res) => {
  const partner = await loadPartnerRow(req.params.id);
  const { user, temporaryPassword } = await createUser(actorOf(req), partner.id, req.body || {});
  return ApiResponse.created(res, { user, temporaryPassword }, `${user.full_name} can now sign in. Share the temporary password once.`);
});

export const updateAdminPartnerUser = catchAsync(async (req, res) => {
  const partner = await loadPartnerRow(req.params.id);
  return ApiResponse.success(res, await updateUser(actorOf(req), partner.id, req.params.userId, req.body || {}), 'User updated.');
});

export const resetAdminPartnerUserPassword = catchAsync(async (req, res) => {
  const partner = await loadPartnerRow(req.params.id);
  const { user, temporaryPassword } = await resetPassword(actorOf(req), partner.id, req.params.userId);
  return ApiResponse.success(res, { user, temporaryPassword }, 'New temporary password created. Share it once.');
});

export const deactivateAdminPartnerUser = catchAsync(async (req, res) => {
  const partner = await loadPartnerRow(req.params.id);
  const user = await deactivateUser(actorOf(req), partner.id, req.params.userId);
  return ApiResponse.success(res, user, `${user.full_name} can no longer sign in.`);
});

// ───────────────────────── orders <-> partners ─────────────────────────

/**
 * POST /api/admin/orders/:id/partner  body: { partner_id }
 * Move an order that has not started production to another partner.
 */
export const assignOrderToPartner = catchAsync(async (req, res) => {
  const order = await getOrderOr404(req.params.id);
  const partnerId = req.body?.partner_id;
  if (!partnerId) throw new BadRequestError('Choose a partner.');
  const partner = await loadPartnerRow(partnerId);
  if (partner.status !== 'active') throw new BadRequestError(`${partner.name} is switched off.`);
  if (order.partner_id === partner.id) return ApiResponse.success(res, { partner_id: partner.id }, `Already with ${partner.name}.`);

  const started = unwrap(await supabaseAdmin.from('job_cards').select('id').eq('order_id', order.id).or('master_id.not.is.null,tailor_id.not.is.null,stage.neq.to_assign').limit(1));
  if (started.length || ['cancelled', 'delivered', 'shipped'].includes(order.status)) {
    throw new BadRequestError(`Order ${order.reference} is already in progress (${STATUS_LABELS[order.status]}), so it stays with its current partner.`);
  }
  unwrap(await supabaseAdmin.from('orders').update({ partner_id: partner.id, updated_at: new Date().toISOString() }).eq('id', order.id));
  await addEvent(order.id, order.status, `Assigned to partner ${partner.name}`, req.userId);
  return ApiResponse.success(res, { partner_id: partner.id, partner_name: partner.name }, `Order ${order.reference} now belongs to ${partner.name}.`);
});
