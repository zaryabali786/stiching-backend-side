import { orderWeightInfo, syncOrderWeight } from '../services/weight.service.js';
import { supabaseAdmin } from '../config/supabase.js';
import { catchAsync, ApiResponse, BadRequestError, ForbiddenError, ConflictError } from '../utils/error.helper.js';
import { parseListQuery, sanitizeSearch, ilikeAny, sendPage } from '../utils/pagination.js';
import { unwrap, unwrapOne, todayISO } from '../utils/db.js';
import { syncOrderFromCards, setOrderStatus, getOrderOr404, addEvent, articleDisplayStatus, STATUS_LABELS } from '../services/order.service.js';
import { scoped, scopeOf, assertMemberOfPartner, can } from '../services/access.service.js';
import { STAGES, STAGE_RANK, STAGE_LABELS, PREVIOUS_STAGE, NEXT_STAGE, SCAN_ROLES, resolveScanRole, permissionForStage, checkReceive, checkComplete, progressFor, articleState, ARTICLE_STATE_LABELS } from '../services/unit-flow.service.js';
import { emitUnitUpdate } from '../services/unit-review.service.js';
import { buildMasterTracking } from '../services/master-tracking.service.js';
import { suggestAssignees } from '../services/team.service.js';
import { uploadDataUrls } from '../services/storage.service.js';
import { notifyUser, notifyPartner } from '../services/notification.service.js';
import { notifyArticleTeam, notifyAssignedMember } from '../services/article-notify.service.js';
import { withSizeSnapshot } from '../utils/measurements.js';
import { cleanVoiceNote, signNoteAudio } from '../services/voice-note.service.js';
import { logUnitEvent } from '../services/order.service.js';
import { attachStageDone, markStageDone, clearStageDone } from '../services/stage-done.service.js';

export { STAGES };
const GAP = 1024;

const CARD_SELECT = `
  *,
  master:team_members!job_cards_master_id_fkey(id, name),
  tailor:team_members!job_cards_tailor_id_fkey(id, name),
  unit:order_units!job_cards_unit_id_fkey(id, code, line_no, unit_title, stitching_type, notes, product_link, product_image_url, quantity, design, reference_images, received_at, notes_audio, issue_audio, size_snapshot, size_chart:size_charts(id, name, person_name, variation, nearest_size, measurements, fit_feedback, notes, notes_audio)),
  order:orders!job_cards_order_id_fkey(id, reference, import_source, brand, customer_id, customer_name, customer_code, destination_country, destination_city, destination_address, destination_phone, status, priority, due_date, received_at, paid_at, change_request, change_request_audio, customer_notes, approval_photos, created_at),
  comments:job_card_comments(count)
`;

const shapeCard = (c) => {
  const today = todayISO();
  const delayed = !!c.due_date && c.due_date < today && c.stage !== 'packed';
  const display = articleDisplayStatus(c.order?.status, c.stage);
  return {
    ...c,
    display_status: display.key,
    display_label: display.label,
    unit: c.unit ? withSizeSnapshot(c.unit) : c.unit,
    comments_count: c.comments?.[0]?.count ?? 0,
    comments: undefined,
    is_delayed: delayed,
    days_late: delayed ? Math.round((new Date(today) - new Date(c.due_date)) / 86_400_000) : 0,
    status: delayed ? 'delayed' : c.priority === 'rush' ? 'rush' : 'on_time',
  };
};

/** A master / tailor was given an article: tell that person (their own login), nobody else. */
const notifyCardAssignee = async (card, memberId, stageLabel, actorId) => {
  const order = await getOrderOr404(card.order_id, 'id, reference');
  await notifyAssignedMember({
    memberId,
    partnerId: card.partner_id,
    exclude: actorId,
    notification: {
      type: 'order',
      title: `New article for you: ${order.reference} · ${card.unit_title}`,
      body: `${stageLabel} · assigned to you.`,
      link: `/partner/production/jobs/${card.id}`,
      orderId: order.id,
      dedupe: true,
    },
  }).catch((err) => console.warn('[Notifications] assignment notice failed:', err.message));
};

const encodeCursor = (card) => `${card.position}|${card.id}`;
const decodeCursor = (cursor) => {
  const [pos, id] = String(cursor || '').split('|');
  const n = Number(pos);
  return Number.isFinite(n) && /^[0-9a-f-]{36}$/i.test(id || '') ? { position: n, id } : null;
};

/**
 * Apply the board filters shared by the board and the per-column endpoints.
 */
const applyFilters = (query, src) => {
  const search = sanitizeSearch(src.search);
  if (search) query = query.or(ilikeAny(['order_reference', 'customer_code', 'unit_title'], search));
  if (src.masterId) query = query.eq('master_id', src.masterId);
  if (src.tailorId) query = query.eq('tailor_id', src.tailorId);
  if (src.priority === 'rush') query = query.eq('priority', 'rush');
  if (src.delayed === 'true') query = query.lt('due_date', todayISO()).neq('stage', 'packed');
  if (src.orderId) query = query.eq('order_id', src.orderId);
  if (src.scopePartner !== undefined) query = query.eq('partner_id', src.scopePartner); // set by the server from the session
  return query;
};

/**
 * An order whose articles are all packed goes to the Warehouse (Waiting for invoice and on). Its tickets leave the board's Packed column then:
 * Packed only shows articles of orders that are still being finished.
 */
const WAREHOUSE_ORDER_STATUSES = ['packed', 'invoice_issued', 'awaiting_payment', 'paid', 'at_admin_warehouse', 'partner_dispatch', 'shipped', 'delivered'];

const fetchColumn = async (stage, src, limit) => {
  const inWarehouseHidden = stage === 'packed';
  let query = supabaseAdmin
    .from('job_cards')
    .select(inWarehouseHidden ? CARD_SELECT.replace('order:orders!job_cards_order_id_fkey(', 'order:orders!job_cards_order_id_fkey!inner(') : CARD_SELECT, { count: 'exact' })
    .eq('stage', stage)
    .order('position', { ascending: true })
    .order('id', { ascending: true })
    .limit(limit);
  query = applyFilters(query, src);
  if (inWarehouseHidden) query = query.not('order.status', 'in', `(${WAREHOUSE_ORDER_STATUSES.join(',')})`);

  const cursor = decodeCursor(src.cursor);
  if (cursor) query = query.or(`position.gt.${cursor.position},and(position.eq.${cursor.position},id.gt.${cursor.id})`);

  const result = await query;
  const rows = (await attachStageDone(unwrap(result, 'Could not load production cards'))).map(shapeCard);
  return {
    stage,
    label: STAGE_LABELS[stage],
    items: rows,
    // count with a cursor applied is "remaining"; the client keeps the total from the first page
    total: result.count ?? rows.length,
    nextCursor: rows.length === limit ? encodeCursor(rows[rows.length - 1]) : null,
  };
};

/**
 * GET /api/partner/production/board?search&masterId&tailorId&priority&delayed&limit=15
 * First page of every column plus totals.
 */
export const getBoard = catchAsync(async (req, res) => {
  const limit = Math.min(50, Math.max(5, parseInt(req.query.limit, 10) || 15));
  const src = { ...req.query, cursor: null, scopePartner: scopeOf(req.access) };
  const columns = await Promise.all(STAGES.map((s) => fetchColumn(s, src, limit)));

  const { count: delayedCount } = await scoped(
    req.access,
    supabaseAdmin.from('job_cards').select('id', { count: 'exact', head: true }).lt('due_date', todayISO()).neq('stage', 'packed')
  );

  return ApiResponse.success(res, { columns, delayedCount: delayedCount || 0 });
});

/**
 * GET /api/partner/production/columns/:stage?cursor=...&limit=15 (+ filters)
 * Next page for one column (infinite scroll inside a column).
 */
export const getColumnPage = catchAsync(async (req, res) => {
  const { stage } = req.params;
  if (!STAGES.includes(stage)) throw new BadRequestError('Unknown stage.');
  const limit = Math.min(50, Math.max(5, parseInt(req.query.limit, 10) || 15));
  return ApiResponse.success(res, await fetchColumn(stage, { ...req.query, scopePartner: scopeOf(req.access) }, limit));
});

const getCard = async (id) => {
  const [card] = await attachStageDone([unwrapOne(await supabaseAdmin.from('job_cards').select(CARD_SELECT).eq('id', id).maybeSingle(), 'Card not found')]);
  return shapeCard(card);
};

const logActivity = async (cardId, req, body, kind = 'activity', audio = null) => {
  await supabaseAdmin.from('job_card_comments').insert({
    notes_audio: audio,
    job_card_id: cardId,
    author_id: req.userId,
    author_name: req.profile.full_name || req.profile.email,
    body,
    kind,
  });
};

/**
 * GET /api/partner/production/cards/:id — card + comments/activity + order timeline
 */
export const getCardDetail = catchAsync(async (req, res) => {
  const card = await getCard(req.params.id);
  const [comments, events, siblings] = await Promise.all([
    supabaseAdmin.from('job_card_comments').select('*').eq('job_card_id', card.id).order('created_at', { ascending: false }).limit(100),
    supabaseAdmin.from('order_events').select('id, status, note, created_at').eq('order_id', card.order_id).order('created_at', { ascending: true }),
    supabaseAdmin.from('job_cards').select('id, stage, unit_title, qc_passed, unit:order_units!job_cards_unit_id_fkey(line_no)').eq('order_id', card.order_id).order('created_at'),
  ]);
  return ApiResponse.success(res, await signNoteAudio({
    ...card,
    activity: unwrap(comments),
    order_events: unwrap(events),
    qc_items: QC_CHECKLIST,
    order_cards: unwrap(siblings),
  }));
});

/**
 * Compute a position between two neighbours. Rebalances the column when gaps get too small.
 */
const computePosition = async (stage, prevId, nextId, movingId, partnerId = null) => {
  const ids = [prevId, nextId].filter(Boolean);
  // neighbours must be tickets of the same partner (a request cannot position against another partner's board)
  const neighbours = ids.length
    ? unwrap(await supabaseAdmin.from('job_cards').select('id, position, stage').in('id', ids).eq('partner_id', partnerId ?? '00000000-0000-0000-0000-000000000000'))
    : [];
  const prev = neighbours.find((n) => n.id === prevId && n.stage === stage);
  const next = neighbours.find((n) => n.id === nextId && n.stage === stage);

  if (prev && next) {
    if (Math.abs(next.position - prev.position) < 1e-6) {
      await rebalanceColumn(stage, partnerId);
      return computePosition(stage, prevId, nextId, movingId, partnerId);
    }
    return (prev.position + next.position) / 2;
  }
  if (prev) return prev.position + GAP;
  if (next) return next.position - GAP;

  let last = supabaseAdmin.from('job_cards').select('position').eq('stage', stage);
  last = partnerId ? last.eq('partner_id', partnerId) : last.is('partner_id', null);
  if (movingId) last = last.neq('id', movingId);
  const { data } = await last.order('position', { ascending: false }).limit(1).maybeSingle();
  return (data?.position ?? 0) + GAP;
};

const rebalanceColumn = async (stage, partnerId = null) => {
  let query = supabaseAdmin.from('job_cards').select('id').eq('stage', stage).order('position').order('id');
  query = partnerId ? query.eq('partner_id', partnerId) : query.is('partner_id', null);
  const rows = unwrap(await query);
  await Promise.all(rows.map((r, i) => supabaseAdmin.from('job_cards').update({ position: (i + 1) * GAP }).eq('id', r.id)));
};

/**
 * Side effects of entering a stage: auto-assign the least-loaded master/tailor, stamp times, reset QC.
 */
const stagePatch = async (card, stage) => {
  const now = new Date().toISOString();
  const patch = { stage };
  const notes = [];

  if (stage === 'to_assign') {
    Object.assign(patch, { master_id: null, tailor_id: null, qc_passed: false, approval_status: 'none' });
  }
  if (stage === 'cutting' || stage === 'stitching') {
    if (!card.master_id) {
      const s = await suggestAssignees(null, card.partner_id);
      if (s.master) {
        patch.master_id = s.master.id;
        notes.push(`Master ${s.master.name} assigned (least busy)`);
      }
    }
    patch.qc_passed = false;
    patch.approval_status = 'none';
  }
  if (stage === 'cutting') patch.cutting_at = card.cutting_at || now;
  if (stage === 'stitching') {
    patch.stitching_at = now;
    if (!card.tailor_id) {
      const s = await suggestAssignees(patch.master_id || card.master_id, card.partner_id);
      if (s.tailor) {
        patch.tailor_id = s.tailor.id;
        notes.push(`Tailor ${s.tailor.name} assigned (least busy)`);
      }
    }
  }
  if (stage === 'qc') Object.assign(patch, { qc_at: now, qc_passed: false, approval_status: 'none' });
  if (stage === 'pressing') Object.assign(patch, { pressing_at: now, qc_passed: true });
  if (stage === 'packed') Object.assign(patch, { packed_at: now, qc_passed: true });
  return { patch, notes };
};

/**
 * PUT /api/partner/production/cards/:id/move  body: { stage, prevId, nextId }
 * prevId/nextId are the cards directly above/below the drop position in the target column.
 */
export const moveCard = catchAsync(async (req, res) => {
  const { stage, prevId = null, nextId = null } = req.body || {};
  if (!STAGES.includes(stage)) throw new BadRequestError('Invalid stage.');

  const card = unwrapOne(await supabaseAdmin.from('job_cards').select('*').eq('id', req.params.id).maybeSingle(), 'Card not found');
  const order = await getOrderOr404(card.order_id, 'id, status, reference');
  if (['paid', 'at_admin_warehouse', 'partner_dispatch', 'shipped', 'delivered', 'cancelled'].includes(order.status) && stage !== 'packed') {
    throw new BadRequestError(`Order ${order.reference} is already ${order.status.replace(/_/g, ' ')} and cannot go back into production.`);
  }

  // forward moves go one stage at a time (a board drop cannot skip Pressing); going back stays possible for corrections
  if (STAGE_RANK[stage] > STAGE_RANK[card.stage]) {
    if (NEXT_STAGE[card.stage] !== stage) {
      throw new BadRequestError(`"${card.unit_title}" is in ${STAGE_LABELS[card.stage]}. It goes to ${STAGE_LABELS[NEXT_STAGE[card.stage]]} next, not straight to ${STAGE_LABELS[stage]}.`);
    }
    if (card.approval_status === 'pending') throw new BadRequestError(`"${card.unit_title}" is waiting for the customer to approve its photos.`);
    if (stage === 'pressing' && !card.qc_passed) throw new BadRequestError(`"${card.unit_title}" has not passed quality check yet.`);
  }

  const position = await computePosition(stage, prevId, nextId, card.id, card.partner_id);
  let patch = { position, updated_at: new Date().toISOString() };
  let notes = [];
  if (stage !== card.stage) {
    const result = await stagePatch(card, stage);
    patch = { ...patch, ...result.patch };
    notes = [`Moved from ${STAGE_LABELS[card.stage]} to ${STAGE_LABELS[stage]}`, ...result.notes];
  }

  unwrap(await supabaseAdmin.from('job_cards').update(patch).eq('id', card.id), 'Could not move card');
  if (stage !== card.stage) await clearStageDone(card.id);
  for (const n of notes) await logActivity(card.id, req, n);
  if (stage !== card.stage) await logUnitEvent(card.unit_id, card.order_id, stage, { actorId: req.userId });

  const updatedOrder = stage !== card.stage ? await syncOrderFromCards(card.order_id, req.userId) : order;
  return ApiResponse.success(res, { card: await getCard(card.id), orderStatus: updatedOrder.status }, notes[0] || 'Card reordered.');
});

/**
 * PATCH /api/partner/production/cards/:id  body: { master_id, tailor_id, due_date, priority }
 */
export const updateCard = catchAsync(async (req, res) => {
  const card = unwrapOne(
    await supabaseAdmin
      .from('job_cards')
      .select('*, master:team_members!job_cards_master_id_fkey(name), tailor:team_members!job_cards_tailor_id_fkey(name)')
      .eq('id', req.params.id)
      .maybeSingle(),
    'Card not found'
  );
  const patch = { updated_at: new Date().toISOString() };
  const notes = [];

  const memberName = async (id) => {
    if (!id) return null;
    return assertMemberOfPartner(id, card.partner_id); // a ticket can only be given to the partner's own people
  };

  if (req.body.master_id !== undefined && req.body.master_id !== card.master_id) {
    const m = await memberName(req.body.master_id);
    if (m && m.role !== 'master') throw new BadRequestError('Selected person is not a master.');
    patch.master_id = req.body.master_id || null;
    notes.push(m ? `Master changed to ${m.name}` : 'Master removed');
  }
  if (req.body.tailor_id !== undefined && req.body.tailor_id !== card.tailor_id) {
    const t = await memberName(req.body.tailor_id);
    if (t && t.role !== 'tailor') throw new BadRequestError('Selected person is not a tailor.');
    patch.tailor_id = req.body.tailor_id || null;
    notes.push(t ? `Tailor changed to ${t.name}` : 'Tailor removed');
  }
  if (req.body.due_date !== undefined && req.body.due_date !== card.due_date) {
    patch.due_date = req.body.due_date || null;
    notes.push(`Due date set to ${req.body.due_date || 'none'}`);
  }
  if (req.body.priority && req.body.priority !== card.priority) {
    if (!['normal', 'rush'].includes(req.body.priority)) throw new BadRequestError('Priority must be normal or rush.');
    patch.priority = req.body.priority;
    notes.push(req.body.priority === 'rush' ? 'Marked as rush' : 'Rush removed');
  }

  unwrap(await supabaseAdmin.from('job_cards').update(patch).eq('id', card.id));
  for (const n of notes) await logActivity(card.id, req, n);
  // a newly chosen master / tailor is told; the one who was replaced is not
  if (patch.master_id) await notifyCardAssignee(card, patch.master_id, 'Cutting', req.userId);
  if (patch.tailor_id) await notifyCardAssignee(card, patch.tailor_id, 'Stitching', req.userId);
  return ApiResponse.success(res, await getCard(card.id), notes.join(' · ') || 'No changes.');
});

/**
 * POST /api/partner/production/cards/:id/assign  body: { master_id? }
 * Assign a master (suggested if omitted) and move the card into Cutting.
 */
export const assignCard = catchAsync(async (req, res) => {
  const card = unwrapOne(await supabaseAdmin.from('job_cards').select('*').eq('id', req.params.id).maybeSingle(), 'Card not found');
  let masterId = req.body?.master_id;
  if (!masterId) {
    const s = await suggestAssignees(null, card.partner_id);
    if (!s.master) throw new BadRequestError('Add a master in Teams before assigning work.');
    masterId = s.master.id;
  }
  const master = await assertMemberOfPartner(masterId, card.partner_id, 'Master');
  if (master.role !== 'master') throw new BadRequestError('Selected person is not a master.');

  const position = await computePosition('cutting', null, null, card.id, card.partner_id);
  unwrap(await supabaseAdmin.from('job_cards').update({
    master_id: master.id,
    stage: 'cutting',
    position,
    cutting_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }).eq('id', card.id));
  await clearStageDone(card.id);
  await logActivity(card.id, req, `Assigned to Master ${master.name} · moved to Cutting`);
  await logUnitEvent(card.unit_id, card.order_id, 'cutting', { actorId: req.userId });
  await notifyCardAssignee(card, master.id, 'Cutting', req.userId);
  const order = await syncOrderFromCards(card.order_id, req.userId);
  return ApiResponse.success(res, { card: await getCard(card.id), orderStatus: order.status }, `Assigned to ${master.name}.`);
});

export const addComment = catchAsync(async (req, res) => {
  const body = String(req.body?.body || '').trim();
  const audio = await cleanVoiceNote(req.body?.notes_audio, req.userId);
  if (!body && !audio) throw new BadRequestError('Write a comment or record a voice note.');
  unwrapOne(await supabaseAdmin.from('job_cards').select('id').eq('id', req.params.id).maybeSingle(), 'Card not found');
  const row = unwrap(
    await supabaseAdmin
      .from('job_card_comments')
      .insert({ job_card_id: req.params.id, author_id: req.userId, author_name: req.profile.full_name || req.profile.email, body: body.slice(0, 2000), kind: 'comment', notes_audio: audio ?? null })
      .select('*')
      .single()
  );
  return ApiResponse.created(res, await signNoteAudio(row), 'Comment added.');
});

export const getSuggestions = catchAsync(async (req, res) =>
  ApiResponse.success(res, await suggestAssignees(req.query.masterId || null, scopeOf(req.access))));

/**
 * GET /api/partner/production/scan?code=SA-1001 or STX-10001
 */
export const scanCards = catchAsync(async (req, res) => {
  const code = sanitizeSearch(req.query.code);
  if (!code) throw new BadRequestError('Enter an article code, order reference or customer code.');
  // an article's own QR code (SA-1001-1) finds that article's card
  const article = (await supabaseAdmin.from('order_units').select('id').ilike('code', code).limit(1).maybeSingle()).data;
  if (article) {
    const one = (await attachStageDone(unwrap(await scoped(req.access, supabaseAdmin.from('job_cards').select(CARD_SELECT).eq('unit_id', article.id).limit(1))))).map(shapeCard);
    return ApiResponse.success(res, one, one.length ? 'Job card found.' : 'That article has no job card yet (it is not released to production).');
  }
  const rows = unwrap(
    await scoped(
      req.access,
      supabaseAdmin
        .from('job_cards')
        .select(CARD_SELECT)
        .or(`order_reference.ilike.${code},customer_code.ilike.${code}`)
        .order('created_at')
        .limit(30)
    )
  ).map(shapeCard);
  return ApiResponse.success(res, rows, rows.length ? `${rows.length} card(s) found.` : 'No job cards found for that code.');
});


// ─────────────────────────────── Receiving an article by scanning its QR code ───────────────────────────────

/** The person's team-member row (master / tailor on the board), when they have one. */
const teamMemberOf = async (userId, partnerId) => {
  if (!userId) return null;
  let q = supabaseAdmin.from('team_members').select('id, name, role, partner_id, master_id').eq('user_id', userId).eq('is_active', true);
  if (partnerId) q = q.eq('partner_id', partnerId);
  const { data } = await q.limit(1).maybeSingle();
  return data || null;
};

/**
 * The stage this person receives for, from their own records: staff type, their team record on the board, or their
 * permissions. Nobody chooses it. An owner or admin has no fixed stage: each scan goes into the stage after the article's.
 */
const scanRoleFor = async (req) => {
  const supervisor = req.access.isAdmin || req.profile.partner_role === 'owner';
  const member = await teamMemberOf(req.userId, req.access.partnerId || null);
  const qualityOnly = can(req.access, 'quality.scan') && !can(req.access, 'production.scan') && !req.access.isAdmin;
  const r = resolveScanRole({ staffType: req.profile.staff_type, memberRole: member?.role, qualityOnly, isSupervisor: supervisor });
  if (!r.ok) throw new ForbiddenError(r.message);
  if (r.permission && !can(req.access, r.permission)) throw new ForbiddenError('You do not have permission to receive articles for your stage.');
  return { ...r, member };
};

/** Progress of one or more orders at one stage, for the receiving screen. */
const receivingProgress = async ({ orderIds, stage, userId, member, role }) => {
  if (!orderIds.length) return [];
  const [orders, units, cards, receipts] = await Promise.all([
    supabaseAdmin.from('orders').select('id, reference, customer_name, customer_code, brand').in('id', orderIds),
    supabaseAdmin.from('order_units').select('id, order_id, code, line_no, unit_title, status, review_status').in('order_id', orderIds).order('line_no'),
    supabaseAdmin.from('job_cards').select('id, unit_id, order_id, stage, qc_passed, approval_status, master_id, tailor_id').in('order_id', orderIds),
    supabaseAdmin.from('unit_stage_receipts').select('unit_id, order_id, stage, role, user_id, user_name, received_at').in('order_id', orderIds).eq('stage', stage).order('received_at'),
  ].map((p) => p.then((r) => unwrap(r))));
  await attachStageDone(cards);
  return orders.map((o) => progressFor({
    order: o, stage, userId, member, role,
    units: units.filter((u) => u.order_id === o.id), cards: cards.filter((c) => c.order_id === o.id), receipts: receipts.filter((r) => r.order_id === o.id),
  }));
};

/**
 * POST /api/partner/production/scan-receive  body: { code }
 * `code` is what the article's QR code holds (its permanent code, e.g. SA-1061-1). The article is received for the stage of
 * the person who scanned (their own records decide it): a master into Cutting, a tailor into Stitching, QA into Quality
 * check, pressing into Pressing, packing into Packed. Every scan receives ONE article. The move is checked (role,
 * permission, assignment, previous stage) and applied in one conditional update, so a second scan or two people scanning
 * at once cannot receive it twice. Each receipt is saved with who and when, the confirmed result is broadcast with
 * Socket.IO, and the reply carries the order's updated progress (received / remaining).
 */
export const scanReceive = catchAsync(async (req, res) => {
  const code = String(req.body?.code || '').trim().slice(0, 80);
  if (!code) throw new BadRequestError('Scan an article QR code or type its code.');
  const role = await scanRoleFor(req);

  const unit = (await supabaseAdmin.from('order_units').select('id, code, unit_title, order_id, status, review_status, line_no').ilike('code', code.replace(/[%_]/g, '\\$&')).limit(1).maybeSingle()).data;
  if (!unit) {
    // an order QR: show that order's progress instead of receiving blindly
    const order = (await supabaseAdmin.from('orders').select('id, reference').ilike('reference', code.replace(/[%_]/g, '\\$&')).limit(1).maybeSingle()).data;
    if (!order) throw new BadRequestError('No article or order has that code.');
    const stage = role.stage || 'cutting';
    const [progress] = await receivingProgress({ orderIds: [order.id], stage, userId: req.userId, member: role.member, role: role.role });
    return ApiResponse.success(res, { kind: 'order', order: { id: order.id, reference: order.reference }, stage, progress }, progress?.awaiting ? `${progress.awaiting} article(s) of ${order.reference} can be received. Scan each article's QR code.` : `No article of ${order.reference} is waiting for ${STAGE_LABELS[stage]}.`);
  }

  const card = (await supabaseAdmin.from('job_cards').select('*').eq('unit_id', unit.id).maybeSingle()).data;
  if (!card) {
    const why = unit.status !== 'received' ? 'has not been received yet' : unit.review_status === 'pending' ? 'is waiting for the customer to approve it' : unit.review_status === 'rejected' ? 'was rejected by the customer' : 'is not in production yet';
    throw new BadRequestError(`${unit.code || unit.unit_title} ${why}.`);
  }
  if (!req.access.isAdmin && card.partner_id !== req.access.partnerId) throw new ForbiddenError('This article belongs to another partner.');
  await attachStageDone([card]);

  // an owner / admin receives the article into the stage that follows the one it is in
  const stage = role.stage || NEXT_STAGE[card.stage];
  if (!stage) throw new ConflictError(`${unit.code || unit.unit_title} is already packed.`);
  if (role.supervisor) {
    const need = permissionForStage(stage);
    if (need && !can(req.access, need)) throw new ForbiddenError('You do not have permission to receive articles for that stage.');
  }

  const member = role.supervisor ? null : role.member || (await teamMemberOf(req.userId, card.partner_id));
  const verdict = checkReceive({ role: role.role, stage, card, member, title: unit.code || unit.unit_title });
  if (!verdict.ok) {
    if (verdict.code === 'duplicate' || verdict.code === 'invalid_transition') throw new ConflictError(verdict.message);
    if (verdict.code === 'forbidden') throw new ForbiddenError(verdict.message);
    throw new BadRequestError(verdict.message);
  }

  const order = await getOrderOr404(card.order_id);
  if (['paid', 'at_admin_warehouse', 'partner_dispatch', 'shipped', 'delivered', 'cancelled'].includes(order.status) && stage !== 'packed') {
    throw new BadRequestError(`Order ${order.reference} is already ${order.status.replace(/_/g, ' ')}.`);
  }

  const entering = await stagePatch(card, stage);
  const position = await computePosition(stage, null, null, card.id, card.partner_id);
  const patch = { ...entering.patch, ...verdict.assign, position, updated_at: new Date().toISOString() };
  // the stage is part of the condition: only the first scan wins
  const { data: moved, error } = await supabaseAdmin.from('job_cards').update(patch).eq('id', card.id).eq('stage', card.stage).select('id');
  if (error) throw error;
  if (!moved?.length) throw new ConflictError(`${unit.code || unit.unit_title} was just received by someone else.`);
  await clearStageDone(card.id);

  const userName = req.profile.full_name || req.profile.email;
  const receipt = unwrap(await supabaseAdmin.from('unit_stage_receipts').insert({
    order_id: card.order_id, unit_id: unit.id, card_id: card.id, partner_id: card.partner_id, stage, role: role.role,
    user_id: req.userId, user_name: userName, team_member_id: member?.id ?? null, received_at: new Date().toISOString(),
  }).select('*').single());
  await logActivity(card.id, req, `Received for ${STAGE_LABELS[stage]} by ${userName} (scan)`);
  await logUnitEvent(unit.id, card.order_id, stage, { actorId: req.userId });
  const updatedOrder = await syncOrderFromCards(card.order_id, req.userId);

  emitUnitUpdate(
    { ...order, status: updatedOrder.status, partner_id: card.partner_id },
    unit,
    { state: 'in_production', stage, stageLabel: STAGE_LABELS[stage], receivedBy: userName, role: role.role, receivedAt: receipt.received_at, cardId: card.id },
  );
  const [progress] = await receivingProgress({ orderIds: [card.order_id], stage, userId: req.userId, member, role: role.role });
  return ApiResponse.success(
    res,
    { kind: 'article', card: await getCard(card.id), receipt, orderStatus: updatedOrder.status, stage, progress },
    `${unit.code || unit.unit_title} received for ${STAGE_LABELS[stage]}.${progress ? ` ${progress.received} of ${progress.total} received.` : ''}`,
  );
});

/**
 * POST /api/partner/production/scan-complete  body: { code }
 * The person who holds the article scans it again when their work is finished. This only marks the stage as completed
 * (who and when are saved and written to the Activity); the article stays where it is until the next person scans it to
 * receive. Master: cutting, tailor: stitching, QA: quality check, pressing: pressing. Owners / admins may complete any stage.
 */
export const scanComplete = catchAsync(async (req, res) => {
  const code = String(req.body?.code || '').trim().slice(0, 80);
  if (!code) throw new BadRequestError('Scan an article QR code or type its code.');
  const role = await scanRoleFor(req);

  const unit = (await supabaseAdmin.from('order_units').select('id, code, unit_title, order_id').ilike('code', code.replace(/[%_]/g, '\\$&')).limit(1).maybeSingle()).data;
  if (!unit) throw new BadRequestError('No article has that code. Scan the QR code of one article.');
  const card = (await supabaseAdmin.from('job_cards').select('*').eq('unit_id', unit.id).maybeSingle()).data;
  if (!card) throw new BadRequestError(`${unit.code || unit.unit_title} is not in production yet.`);
  if (!req.access.isAdmin && card.partner_id !== req.access.partnerId) throw new ForbiddenError('This article belongs to another partner.');
  await attachStageDone([card]);

  if (role.supervisor) {
    const need = permissionForStage(card.stage);
    if (need && !can(req.access, need)) throw new ForbiddenError('You do not have permission to complete that stage.');
  }
  const member = role.supervisor ? null : role.member || (await teamMemberOf(req.userId, card.partner_id));
  const title = unit.code || unit.unit_title;
  const verdict = checkComplete({ role: role.role, card, member, title });
  if (!verdict.ok) {
    if (verdict.code === 'duplicate' || verdict.code === 'invalid_transition') throw new ConflictError(verdict.message);
    if (verdict.code === 'forbidden') throw new ForbiddenError(verdict.message);
    throw new BadRequestError(verdict.message);
  }

  const userName = req.profile.full_name || req.profile.email;
  const mark = await markStageDone(card, { userId: req.userId, name: userName });
  if (Object.keys(verdict.assign).length) unwrap(await supabaseAdmin.from('job_cards').update({ ...verdict.assign, updated_at: mark.at }).eq('id', card.id));
  await logActivity(card.id, req, `${STAGE_LABELS[card.stage]} completed by ${userName} (scan)`);
  const [progress] = await receivingProgress({ orderIds: [card.order_id], stage: card.stage, userId: req.userId, member, role: role.role });
  const next = NEXT_STAGE[card.stage];
  // the next stage's people (of this partner) can pick the article up now: only they are told
  if (next) {
    const order = await getOrderOr404(card.order_id, 'id, reference');
    await notifyPartner({
      type: 'order',
      title: `Ready for ${STAGE_LABELS[next]}: ${order.reference} · ${unit.unit_title}`,
      body: `${STAGE_LABELS[card.stage]} was completed by ${userName}.`,
      link: `/partner/production/jobs/${card.id}`,
      orderId: order.id,
      partnerId: card.partner_id,
      dedupe: true,
    }, req.userId, { module: next === 'qc' ? 'quality' : 'production' }).catch((err) => console.warn('[Notifications] stage notice failed:', err.message));
  }
  return ApiResponse.success(
    res,
    { kind: 'complete', card: await getCard(card.id), stage: card.stage, done: mark, progress },
    `${title} completed in ${STAGE_LABELS[card.stage]}. ${next ? `${STAGE_LABELS[next]} can receive it now.` : ''}`.trim(),
  );
});

/**
 * GET /api/partner/production/receiving
 * The receiving screen: the person's stage (found automatically) and, for every order that has articles for them, how many
 * are received, how many remain, and who received each one. Owners / admins see one entry per order and stage.
 */
export const getProductionReceiving = catchAsync(async (req, res) => {
  const role = await scanRoleFor(req);
  const stages = role.stage ? [role.stage] : Object.keys(PREVIOUS_STAGE);
  const entries = [];
  for (const stage of stages) {
    const from = PREVIOUS_STAGE[stage];
    const rows = unwrap(await scoped(req.access, supabaseAdmin.from('job_cards').select('order_id, stage').eq('stage', from).limit(300)));
    const orderIds = [...new Set(rows.map((r) => r.order_id))].slice(0, 30);
    // orders where the person already received some articles at this stage and has more to scan belong on the screen too
    const recent = unwrap(await scoped(req.access, supabaseAdmin.from('unit_stage_receipts').select('order_id').eq('stage', stage).order('received_at', { ascending: false }).limit(60), 'partner_id'));
    const ids = [...new Set([...orderIds, ...recent.map((r) => r.order_id)])].slice(0, 40);
    const progress = await receivingProgress({ orderIds: ids, stage, userId: req.userId, member: role.member, role: role.role });
    for (const p of progress) if (p.awaiting > 0 || (p.received > 0 && p.remaining > 0)) entries.push(p);
  }
  entries.sort((a, b) => (b.awaiting > 0) - (a.awaiting > 0) || a.reference.localeCompare(b.reference));
  return ApiResponse.success(res, { role: role.role, supervisor: role.supervisor, stage: role.stage, stageLabel: role.stage ? STAGE_LABELS[role.stage] : null, orders: entries });
});

/**
 * GET /api/partner/production/orders?search&page
 * Each order as a parent with ALL its articles under it: where each one is, and who received it at which stage.
 */
export const getProductionOrders = catchAsync(async (req, res) => {
  const q = parseListQuery(req, { defaultLimit: 10, defaultSort: 'updated_at', defaultDir: 'desc', sortable: ['updated_at', 'created_at'] });
  let query = scoped(
    req.access,
    supabaseAdmin
      .from('orders')
      .select(`id, reference, brand, customer_name, customer_code, status, due_date, updated_at, partner_id,
        units:order_units!order_units_order_id_fkey(id, code, line_no, unit_title, status, review_status, return_status, card:job_cards(id, stage, qc_passed, approval_status, master:team_members!job_cards_master_id_fkey(name), tailor:team_members!job_cards_tailor_id_fkey(name)))`, { count: 'exact' })
      .not('status', 'in', '(draft,cancelled,submitted)')
      .order(q.sort, { ascending: q.ascending })
      .range(q.from, q.to),
  );
  if (q.search) query = query.or(ilikeAny(['reference', 'customer_code', 'customer_name', 'brand'], q.search));
  const result = await query;
  const orders = unwrap(result);
  const ids = orders.map((o) => o.id);
  const receipts = ids.length ? unwrap(await supabaseAdmin.from('unit_stage_receipts').select('unit_id, stage, role, user_name, received_at').in('order_id', ids).order('received_at')) : [];
  const byUnit = new Map();
  for (const r of receipts) byUnit.set(r.unit_id, [...(byUnit.get(r.unit_id) || []), r]);

  const rows = orders.map((o) => {
    const units = (o.units || []).sort((a, b) => a.line_no - b.line_no).map((u) => {
      const card = Array.isArray(u.card) ? u.card[0] : u.card;
      const state = articleState({ unit: u, card, order: o });
      return {
        id: u.id, code: u.code, line_no: u.line_no, title: u.unit_title, state, state_label: ARTICLE_STATE_LABELS[state],
        stage: card?.stage ?? null, stage_label: card ? STAGE_LABELS[card.stage] : null, card_id: card?.id ?? null,
        master: (Array.isArray(card?.master) ? card.master[0] : card?.master)?.name ?? null,
        tailor: (Array.isArray(card?.tailor) ? card.tailor[0] : card?.tailor)?.name ?? null,
        receipts: byUnit.get(u.id) || [],
      };
    });
    const count = (state) => units.filter((u) => u.state === state).length;
    return {
      id: o.id, reference: o.reference, brand: o.brand, customer_name: o.customer_name, customer_code: o.customer_code,
      status: o.status, status_label: STATUS_LABELS[o.status], due_date: o.due_date, updated_at: o.updated_at, units,
      progress: { total: units.length, in_production: count('in_production'), completed: count('completed'), waiting: units.filter((u) => ['pending_approval', 'rejected', 'return_requested', 'returned', 'pending_receipt'].includes(u.state)).length },
    };
  });
  return sendPage(res, rows, q, result.count);
});

// ─────────────────────────────── Master-wise tracking ───────────────────────────────

/**
 * GET /api/partner/production/master-tracking?master_id=
 * One master and the tailors who work under them: every order with an article assigned to the team, how many of its
 * articles were picked up (received) and which ones still wait to be picked up, plus each member's received / pending /
 * completed numbers.
 *   - a master sees their own team
 *   - a tailor sees only what is assigned to them (never another master's data)
 *   - the partner's owner / managers (and admins) choose any master of their partner
 */
export const getMasterTracking = catchAsync(async (req, res) => {
  const viewer = await teamMemberOf(req.userId, req.access.partnerId || null);
  const manager = req.access.isAdmin || req.profile.partner_role === 'owner' || (!viewer && can(req.access, 'teams.view'));
  const memberColumns = 'id, name, role, master_id, daily_capacity, partner_id, is_active';
  let master = null;
  let onlyMemberId = null;
  let masters = [];

  if (manager) {
    const scope = scopeOf(req.access);
    let mq = supabaseAdmin.from('team_members').select(memberColumns).eq('role', 'master').eq('is_active', true).order('name');
    if (scope !== undefined) mq = mq.eq('partner_id', scope);
    masters = unwrap(await mq);
    const wanted = String(req.query.master_id || '');
    if (wanted && !masters.some((m) => m.id === wanted)) throw new ForbiddenError('That master is not in your partner.');
    master = masters.find((m) => m.id === wanted) ?? masters[0] ?? null;
  } else if (viewer?.role === 'master') {
    master = unwrapOne(await supabaseAdmin.from('team_members').select(memberColumns).eq('id', viewer.id).maybeSingle(), 'Master not found');
  } else if (viewer?.role === 'tailor' && viewer.master_id) {
    master = unwrapOne(await supabaseAdmin.from('team_members').select(memberColumns).eq('id', viewer.master_id).maybeSingle(), 'Master not found');
    onlyMemberId = viewer.id; // a tailor sees only their own work
  } else {
    throw new ForbiddenError("Only a master, a tailor on a master's team, or a manager can open master tracking.");
  }
  const viewerRole = manager ? 'manager' : viewer.role;
  if (!master) {
    return ApiResponse.success(res, { master: null, members: [], orders: [], totals: { orders: 0, articles: 0, received: 0, remaining: 0, completed: 0 }, masters, viewer: viewerRole });
  }

  const tailors = unwrap(await supabaseAdmin.from('team_members').select(memberColumns).eq('role', 'tailor').eq('master_id', master.id).eq('is_active', true).order('name'));
  const tailorIds = tailors.map((t) => t.id);
  // every ticket assigned to the master or to one of their tailors, then the whole of each of those orders
  let mine = supabaseAdmin.from('job_cards').select('order_id, master_id, tailor_id').eq('partner_id', master.partner_id).limit(500);
  mine = tailorIds.length ? mine.or(`master_id.eq.${master.id},tailor_id.in.(${tailorIds.join(',')})`) : mine.eq('master_id', master.id);
  const orderIds = [...new Set(unwrap(await mine).filter((c) => c.master_id === master.id || tailorIds.includes(c.tailor_id)).map((c) => c.order_id))].slice(0, 60);
  let result = { master, tailors, cards: [], units: [], orders: [], receipts: [] };
  if (orderIds.length) {
    const [orders, cards, units, receipts] = await Promise.all([
      supabaseAdmin.from('orders').select('id, reference, customer_name, brand, due_date, status').in('id', orderIds).not('status', 'in', '(cancelled,delivered,draft)'),
      supabaseAdmin.from('job_cards').select('id, order_id, unit_id, stage, master_id, tailor_id, unit_title').in('order_id', orderIds),
      supabaseAdmin.from('order_units').select('id, order_id, code, line_no, unit_title').in('order_id', orderIds),
      supabaseAdmin.from('unit_stage_receipts').select('unit_id, stage, role, user_id, user_name, received_at').in('order_id', orderIds).in('stage', ['cutting', 'stitching']).order('received_at'),
    ].map((p) => p.then((r) => unwrap(r))));
    result = { master, tailors, cards, units, orders, receipts };
  }
  const tracking = buildMasterTracking({ ...result, onlyMemberId });
  return ApiResponse.success(res, { ...tracking, masters: manager ? masters.map((m) => ({ id: m.id, name: m.name })) : [], viewer: viewerRole });
});

// ─────────────────────────────── Quality check ───────────────────────────────

/**
 * GET /api/partner/qc?status=pending|passed&search&page
 */
export const getQcQueue = catchAsync(async (req, res) => {
  const q = parseListQuery(req, { defaultLimit: 12, defaultSort: 'qc_at', defaultDir: 'asc', sortable: ['qc_at', 'due_date'] });
  let query = supabaseAdmin
    .from('job_cards')
    .select(CARD_SELECT, { count: 'exact' })
    .eq('stage', 'qc')
    .eq('qc_passed', req.query.status === 'passed')
    .order(q.sort, { ascending: q.ascending, nullsFirst: false })
    .range(q.from, q.to);
  query = scoped(req.access, query);
  if (q.search) query = query.or(ilikeAny(['order_reference', 'customer_code', 'unit_title'], q.search));
  const result = await query;

  const [{ count: pending }, { count: passed }] = await Promise.all([
    scoped(req.access, supabaseAdmin.from('job_cards').select('id', { count: 'exact', head: true }).eq('stage', 'qc').eq('qc_passed', false)),
    scoped(req.access, supabaseAdmin.from('job_cards').select('id', { count: 'exact', head: true }).eq('stage', 'qc').eq('qc_passed', true)),
  ]);
  return sendPage(res, await signNoteAudio(unwrap(result).map(shapeCard)), q, result.count, { counts: { pending: pending || 0, passed: passed || 0 } });
});

export const passQc = catchAsync(async (req, res) => {
  const card = unwrapOne(await supabaseAdmin.from('job_cards').select('*').eq('id', req.params.id).maybeSingle(), 'Card not found');
  if (card.stage !== 'qc') throw new BadRequestError('Only cards in Quality check can be passed.');
  const notes = String(req.body?.notes || '').trim() || null;
  unwrap(await supabaseAdmin.from('job_cards').update({ qc_passed: true, qc_notes: notes, updated_at: new Date().toISOString() }).eq('id', card.id));
  await logActivity(card.id, req, `QC passed${notes ? `: ${notes}` : ''}`);
  await logUnitEvent(card.unit_id, card.order_id, 'qc_passed', { actorId: req.userId });
  const ref = { id: card.order_id, reference: card.order_reference };
  const order = await syncOrderFromCards(card.order_id, req.userId);
  // good news for the people who made it, the QC team of that partner (they send the photos next) and the admins
  await notifyArticleTeam({
    order: ref,
    unitId: card.unit_id,
    stages: ['stitching'],
    module: 'quality',
    exclude: req.userId,
    notification: {
      type: 'update',
      title: `QC passed: ${ref.reference} · ${card.unit_title}`,
      body: notes || 'Quality check passed. Photos can go to the customer.',
      link: { admin: `/admin/orders?ref=${ref.reference}`, partner_staff: `/partner/production/jobs/${card.id}` },
      orderId: ref.id,
      dedupe: true,
    },
  }).catch((err) => console.warn('[Notifications] QC notice failed:', err.message));
  return ApiResponse.success(res, { card: await getCard(card.id), orderStatus: order.status }, 'QC passed.');
});

export const failQc = catchAsync(async (req, res) => {
  const notes = String(req.body?.notes || '').trim();
  const audio = await cleanVoiceNote(req.body?.notes_audio, req.userId);
  if (!notes && !audio) throw new BadRequestError('Write what needs fixing (or record a voice note) so the tailor knows.');
  const card = unwrapOne(await supabaseAdmin.from('job_cards').select('*').eq('id', req.params.id).maybeSingle(), 'Card not found');
  if (card.stage !== 'qc') throw new BadRequestError('Only cards in Quality check can be sent back.');
  const position = await computePosition('stitching', null, null, card.id, card.partner_id);
  unwrap(await supabaseAdmin.from('job_cards').update({
    stage: 'stitching', position, qc_passed: false, approval_status: 'none', qc_notes: notes || 'Voice note', qc_notes_audio: audio ?? null, stitching_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  }).eq('id', card.id));
  await logActivity(card.id, req, `Sent back to stitching: ${notes || 'voice note'}`, 'activity', audio ?? null);
  await logUnitEvent(card.unit_id, card.order_id, 'qc_failed', { actorId: req.userId }); // the QC note stays internal
  const ref = { id: card.order_id, reference: card.order_reference };
  const order = await syncOrderFromCards(card.order_id, req.userId);
  // back to the tailor who stitched it (and that partner's production people) and the admins; the customer is not told
  await notifyArticleTeam({
    order: ref,
    unitId: card.unit_id,
    stages: ['stitching'],
    module: 'production',
    exclude: req.userId,
    notification: {
      type: 'alert',
      title: `QC failed: ${ref.reference} · ${card.unit_title}`,
      body: notes || 'The QC team left a voice note. Please fix and send it back to quality check.',
      link: { admin: `/admin/orders?ref=${ref.reference}`, partner_staff: `/partner/production/jobs/${card.id}` },
      orderId: ref.id,
      dedupe: true,
    },
  }).catch((err) => console.warn('[Notifications] QC notice failed:', err.message));
  return ApiResponse.success(res, { orderStatus: order.status }, 'Sent back to the tailor.');
});

/**
 * POST /api/partner/qc/cards/:id/request-approval  body: { photos: [{ name, dataUrl }] }
 * Send finished photos of ONE article (one ticket) to the customer. Each article is approved on its own,
 * so two different products get their own photos and their own Approve / Request changes.
 */
export const requestCardApproval = catchAsync(async (req, res) => {
  const card = unwrapOne(
    await supabaseAdmin
      .from('job_cards')
      .select('*, order:orders!job_cards_order_id_fkey(id, reference, status, customer_id)')
      .eq('id', req.params.id)
      .maybeSingle(),
    'Card not found'
  );
  const order = card.order;
  if (!(card.stage === 'qc' && card.qc_passed)) throw new BadRequestError('Pass QC for this article first.');
  if (card.approval_status === 'approved') throw new BadRequestError('The customer already approved this article.');
  const photos = req.body?.photos || [];
  if (!photos.length) throw new BadRequestError('Add at least one photo of this article for the customer.');
  const uploaded = await uploadDataUrls(`approvals/${order.id}/${card.id}`, photos);

  unwrap(await supabaseAdmin.from('job_cards').update({
    approval_status: 'pending',
    approval_photos: uploaded,
    approval_requested_at: new Date().toISOString(),
    approval_decided_at: null,
    change_request: null,
    change_request_audio: null,
    updated_at: new Date().toISOString(),
  }).eq('id', card.id));
  await logActivity(card.id, req, `${uploaded.length} photo(s) sent to the customer for approval`);
  await logUnitEvent(card.unit_id, order.id, 'approval_requested', { actorId: req.userId });
  await addEvent(order.id, order.status, `Photos of "${card.unit_title}" sent to the customer for approval`, req.userId);
  await notifyUser(order.customer_id, {
    type: 'approval',
    title: `Approval needed: ${order.reference} · ${card.unit_title}`,
    body: `Your "${card.unit_title}" is stitched. Please review the photos and approve, or request a change.`,
    link: `/app/orders/${order.id}?focus=approval&unit=${card.unit_id}`,
    orderId: order.id,
  });
  const updated = await syncOrderFromCards(order.id, req.userId);
  return ApiResponse.success(res, { photos: uploaded, approval_status: 'pending', orderStatus: updated.status }, `Photos of "${card.unit_title}" sent to the customer.`);
});

/**
 * POST /api/partner/qc/orders/:orderId/request-approval  body: { photos }
 * Older shortcut: sends the same photos for the articles that have passed QC (the others do not block it).
 * Prefer the per-article endpoint above.
 */
export const requestCustomerApproval = catchAsync(async (req, res) => {
  const order = await getOrderOr404(req.params.orderId);
  const cards = unwrap(await supabaseAdmin.from('job_cards').select('id, stage, qc_passed, approval_status, unit_title, unit_id').eq('order_id', order.id));
  const photos = req.body?.photos || [];
  if (!photos.length) throw new BadRequestError('Add at least one photo for the customer.');
  // articles that have passed QC are sent now; the others follow when they pass (each one is approved on its own)
  const targets = cards.filter((c) => c.stage === 'qc' && c.qc_passed && c.approval_status !== 'approved');
  if (!targets.length) throw new BadRequestError('No article has passed QC yet (or they are all approved already).');
  const uploaded = await uploadDataUrls(`approvals/${order.id}`, photos);
  for (const c of targets) {
    unwrap(await supabaseAdmin.from('job_cards').update({
      approval_status: 'pending', approval_photos: uploaded, approval_requested_at: new Date().toISOString(),
      approval_decided_at: null, change_request: null, change_request_audio: null, updated_at: new Date().toISOString(),
    }).eq('id', c.id));
    await logActivity(c.id, req, `${uploaded.length} photo(s) sent to the customer for approval`);
    await logUnitEvent(c.unit_id, order.id, 'approval_requested', { actorId: req.userId });
  }
  await addEvent(order.id, order.status, `${uploaded.length} photo(s) sent to the customer for approval`, req.userId);
  await notifyUser(order.customer_id, {
    type: 'approval',
    title: `Approval needed: ${order.reference}`,
    body: 'Your outfit is stitched. Please review the photos and approve, or request a change.',
    link: `/app/orders/${order.id}?focus=approval`,
    orderId: order.id,
  });
  const updated = await syncOrderFromCards(order.id, req.userId);
  return ApiResponse.success(res, { photos: uploaded, orderStatus: updated.status }, 'Photos sent to the customer.');
});

/**
 * POST /api/partner/qc/orders/:orderId/pressing
 * Every article that passed quality check (and is not waiting for the customer) moves on to Pressing. Packing comes after it.
 */
export const sendOrderToPressing = catchAsync(async (req, res) => {
  const order = await getOrderOr404(req.params.orderId);
  const cards = unwrap(await supabaseAdmin.from('job_cards').select('id, unit_id, stage, qc_passed, approval_status, unit_title').eq('order_id', order.id));
  const waiting = cards.filter((c) => c.approval_status === 'pending');
  if (waiting.length) throw new BadRequestError(`Waiting for the customer to approve: ${waiting.map((c) => c.unit_title).join(', ')}.`);
  const ready = cards.filter((c) => c.stage === 'qc' && c.qc_passed);
  if (!ready.length) throw new BadRequestError('No article of this order has passed quality check and is waiting for Pressing.');
  let position = await computePosition('pressing', null, null, null, order.partner_id);
  for (const c of ready) {
    unwrap(await supabaseAdmin.from('job_cards').update({
      stage: 'pressing', qc_passed: true, pressing_at: new Date().toISOString(), position, updated_at: new Date().toISOString(),
    }).eq('id', c.id));
    position += GAP;
    await logActivity(c.id, req, 'Moved from Quality check to Pressing');
    await logUnitEvent(c.unit_id, order.id, 'pressing', { actorId: req.userId });
  }
  const updated = await syncOrderFromCards(order.id, req.userId);
  return ApiResponse.success(res, { orderStatus: updated.status, moved: ready.length }, `${ready.length} article${ready.length === 1 ? '' : 's'} of ${order.reference} moved to Pressing.`);
});

/**
 * POST /api/partner/qc/orders/:orderId/pack
 * Packs the order. Every article must have finished Pressing first. The parcel weight is not asked here: it is the total of the
 * article weights entered in Receiving, and the invoice reads it from there.
 */
export const packOrder = catchAsync(async (req, res) => {
  const order = await getOrderOr404(req.params.orderId);
  const cards = unwrap(await supabaseAdmin.from('job_cards').select('id, unit_id, stage, qc_passed, approval_status, unit_title').eq('order_id', order.id));
  const waiting = cards.filter((c) => c.approval_status === 'pending');
  if (waiting.length) throw new BadRequestError(`Waiting for the customer to approve: ${waiting.map((c) => c.unit_title).join(', ')}.`);
  if (!cards.length) throw new BadRequestError('This order has no articles in production.');
  const notPressed = cards.filter((c) => c.stage !== 'pressing' && c.stage !== 'packed');
  if (notPressed.length) {
    throw new BadRequestError(`Every article must finish Pressing before packing. Still to do: ${notPressed.map((c) => `${c.unit_title} (${STAGE_LABELS[c.stage]})`).join(', ')}.`);
  }

  let position = await computePosition('packed', null, null, null, order.partner_id);
  for (const c of cards.filter((x) => x.stage !== 'packed')) {
    unwrap(await supabaseAdmin.from('job_cards').update({
      stage: 'packed', qc_passed: true, packed_at: new Date().toISOString(), position, updated_at: new Date().toISOString(),
    }).eq('id', c.id));
    position += GAP;
    await logActivity(c.id, req, 'Packed');
    await logUnitEvent(c.unit_id, order.id, 'packed', { actorId: req.userId });
  }
  // keep the order's weight equal to the total of its articles (Receiving); nothing is typed here
  await syncOrderWeight(order);
  const updated = await syncOrderFromCards(order.id, req.userId);
  return ApiResponse.success(res, { orderStatus: updated.status }, `Order ${order.reference} packed.`);
});

// ─────────────────────────────── Job detail extras ───────────────────────────────

export const QC_CHECKLIST = [
  { key: 'measurements', label: 'Measurements match the chart' },
  { key: 'seams', label: 'Seams and finishing' },
  { key: 'threads', label: 'Loose threads removed' },
  { key: 'notes', label: 'Matches customer notes' },
];

/**
 * PATCH /api/partner/production/cards/:id/qc-checklist  body: { checklist: { measurements: true, ... } }
 */
export const updateQcChecklist = catchAsync(async (req, res) => {
  const card = unwrapOne(await supabaseAdmin.from('job_cards').select('id, qc_checklist').eq('id', req.params.id).maybeSingle(), 'Card not found');
  const input = req.body?.checklist || {};
  const checklist = { ...(card.qc_checklist || {}) };
  for (const item of QC_CHECKLIST) if (input[item.key] !== undefined) checklist[item.key] = !!input[item.key];
  unwrap(await supabaseAdmin.from('job_cards').update({ qc_checklist: checklist, updated_at: new Date().toISOString() }).eq('id', card.id));
  return ApiResponse.success(res, { qc_checklist: checklist, items: QC_CHECKLIST }, 'Checklist saved.');
});

/**
 * POST /api/partner/production/cards/:id/ask-customer  body: { message }
 * Sends the customer a question about this article; it shows in their notifications and order timeline.
 */
export const askCustomer = catchAsync(async (req, res) => {
  const message = String(req.body?.message || '').trim();
  if (message.length < 3) throw new BadRequestError('Write your question for the customer.');
  const card = unwrapOne(
    await supabaseAdmin.from('job_cards').select('id, unit_title, order:orders!job_cards_order_id_fkey(id, reference, status, customer_id)').eq('id', req.params.id).maybeSingle(),
    'Card not found'
  );
  await notifyUser(card.order.customer_id, {
    type: 'approval',
    title: `Question about ${card.order.reference}`,
    body: `${card.unit_title}: ${message}`,
    link: `/app/orders/${card.order.id}`,
    orderId: card.order.id,
  });
  await addEvent(card.order.id, card.order.status, `Tailor asked: ${message}`, req.userId);
  await logActivity(card.id, req, `Asked customer: ${message}`, 'comment');
  return ApiResponse.success(res, null, 'Question sent to the customer.');
});
