import { supabaseAdmin } from '../config/supabase.js';
import { catchAsync, ApiResponse, BadRequestError } from '../utils/error.helper.js';
import { parseListQuery, sanitizeSearch, ilikeAny, sendPage } from '../utils/pagination.js';
import { unwrap, unwrapOne, todayISO } from '../utils/db.js';
import { syncOrderFromCards, setOrderStatus, getOrderOr404, addEvent, articleDisplayStatus } from '../services/order.service.js';
import { scoped, scopeOf, assertMemberOfPartner } from '../services/access.service.js';
import { suggestAssignees } from '../services/team.service.js';
import { uploadDataUrls } from '../services/storage.service.js';
import { notifyUser } from '../services/notification.service.js';
import { withSizeSnapshot } from '../utils/measurements.js';
import { cleanVoiceNote, signNoteAudio } from '../services/voice-note.service.js';
import { logUnitEvent } from '../services/order.service.js';

export const STAGES = ['to_assign', 'cutting', 'stitching', 'qc', 'packed'];
const STAGE_LABELS = { to_assign: 'To assign', cutting: 'Cutting', stitching: 'Stitching', qc: 'Quality check', packed: 'Packed' };
const GAP = 1024;

const CARD_SELECT = `
  *,
  master:team_members!job_cards_master_id_fkey(id, name),
  tailor:team_members!job_cards_tailor_id_fkey(id, name),
  unit:order_units!job_cards_unit_id_fkey(id, line_no, unit_title, stitching_type, notes, product_link, quantity, design, reference_images, received_at, notes_audio, issue_audio, size_snapshot, size_chart:size_charts(id, name, person_name, variation, nearest_size, measurements, fit_feedback, notes, notes_audio)),
  order:orders!job_cards_order_id_fkey(id, reference, brand, customer_id, customer_name, customer_code, destination_country, destination_city, status, priority, due_date, received_at, paid_at, change_request, change_request_audio, customer_notes, approval_photos, created_at),
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

const fetchColumn = async (stage, src, limit) => {
  let query = supabaseAdmin
    .from('job_cards')
    .select(CARD_SELECT, { count: 'exact' })
    .eq('stage', stage)
    .order('position', { ascending: true })
    .order('id', { ascending: true })
    .limit(limit);
  query = applyFilters(query, src);

  const cursor = decodeCursor(src.cursor);
  if (cursor) query = query.or(`position.gt.${cursor.position},and(position.eq.${cursor.position},id.gt.${cursor.id})`);

  const result = await query;
  const rows = unwrap(result, 'Could not load production cards').map(shapeCard);
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

const getCard = async (id) =>
  shapeCard(unwrapOne(await supabaseAdmin.from('job_cards').select(CARD_SELECT).eq('id', id).maybeSingle(), 'Card not found'));

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

  const position = await computePosition(stage, prevId, nextId, card.id, card.partner_id);
  let patch = { position, updated_at: new Date().toISOString() };
  let notes = [];
  if (stage !== card.stage) {
    const result = await stagePatch(card, stage);
    patch = { ...patch, ...result.patch };
    notes = [`Moved from ${STAGE_LABELS[card.stage]} to ${STAGE_LABELS[stage]}`, ...result.notes];
  }

  unwrap(await supabaseAdmin.from('job_cards').update(patch).eq('id', card.id), 'Could not move card');
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
  await logActivity(card.id, req, `Assigned to Master ${master.name} · moved to Cutting`);
  await logUnitEvent(card.unit_id, card.order_id, 'cutting', { actorId: req.userId });
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
  if (!code) throw new BadRequestError('Enter an order reference or customer code.');
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
  const order = await syncOrderFromCards(card.order_id, req.userId);
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
  const order = await syncOrderFromCards(card.order_id, req.userId);
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
 * POST /api/partner/qc/orders/:orderId/pack  body: { weight_kg }
 */
export const packOrder = catchAsync(async (req, res) => {
  const order = await getOrderOr404(req.params.orderId);
  const cards = unwrap(await supabaseAdmin.from('job_cards').select('id, unit_id, stage, qc_passed, approval_status, unit_title').eq('order_id', order.id));
  const waiting = cards.filter((c) => c.approval_status === 'pending');
  if (waiting.length) throw new BadRequestError(`Waiting for the customer to approve: ${waiting.map((c) => c.unit_title).join(', ')}.`);
  if (!cards.length || !cards.every((c) => c.stage === 'packed' || (c.stage === 'qc' && c.qc_passed))) {
    throw new BadRequestError('Every article must pass QC before packing.');
  }
  const weight = Number(req.body?.weight_kg);
  if (!(weight > 0 && weight < 50)) throw new BadRequestError('Enter the parcel weight in kg.');

  let position = await computePosition('packed', null, null, null, order.partner_id);
  for (const c of cards.filter((x) => x.stage !== 'packed')) {
    unwrap(await supabaseAdmin.from('job_cards').update({
      stage: 'packed', qc_passed: true, packed_at: new Date().toISOString(), position, updated_at: new Date().toISOString(),
    }).eq('id', c.id));
    position += GAP;
    await logActivity(c.id, req, 'Packed');
    await logUnitEvent(c.unit_id, order.id, 'packed', { actorId: req.userId });
  }
  unwrap(await supabaseAdmin.from('orders').update({ weight_kg: weight }).eq('id', order.id));
  await addEvent(order.id, order.status, `Parcel weighed: ${weight} kg`, req.userId);
  const updated = await syncOrderFromCards(order.id, req.userId);
  return ApiResponse.success(res, { orderStatus: updated.status }, `Order ${order.reference} packed.`);
});

// ─────────────────────────────── Job detail extras ───────────────────────────────

export const QC_CHECKLIST = [
  { key: 'measurements', label: 'Measurements match the chart' },
  { key: 'seams', label: 'Seams and finishing' },
  { key: 'threads', label: 'Loose threads removed' },
  { key: 'pressed', label: 'Pressed and folded' },
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
