import { supabaseAdmin } from '../config/supabase.js';
import { config } from '../config/env.js';
import { isStripeEnabled } from '../services/stripe.service.js';
import { catchAsync, ApiResponse, BadRequestError, ConflictError, NotFoundError, ForbiddenError } from '../utils/error.helper.js';
import { parseListQuery, sendPage, ilikeAny } from '../utils/pagination.js';
import { unwrap, unwrapOne, round2 } from '../utils/db.js';
import { STATUS_GROUPS, STATUS_LABELS, setOrderStatus, addEvent, notifyPartnerAboutOrder, syncOrderFromCards, logUnitEvent, buildUnitTimeline } from '../services/order.service.js';
import { notifyStaff, notifyAdmins, notifyPartner, notifyUser } from '../services/notification.service.js';
import { uploadDataUrls, withSignedUrl } from '../services/storage.service.js';
import { resolveOrderRefs, resolveUnitArticles, saveUnitArticles } from '../services/order-input.service.js';
import { createMessage } from '../services/chat.service.js';
import { cleanVoiceNote, signNoteAudio } from '../services/voice-note.service.js';
import { linkImportToOrder } from '../services/order-import.service.js';
import { readProductLink } from '../services/product-page.service.js';
import { cleanMeasurements as cleanMeasurementsRaw, cleanNearestSize as cleanNearestRaw, sizeSnapshotOf, withSizeSnapshot } from '../utils/measurements.js';

const one = (v) => (Array.isArray(v) ? v[0] ?? null : v ?? null);

const ORDER_DETAIL_SELECT = `
  *,
  brand_ref:brands!orders_brand_id_fkey(id, name),
  courier:couriers!orders_courier_id_fkey(id, name, requires_tracking),
  units:order_units!order_units_order_id_fkey(
    *,
    size_chart:size_charts(id, name, person_name, variation, nearest_size, measurements, notes, notes_audio),
    picks:order_unit_articles(article_type_id, article_id, type:article_types(id, name, sort_order), article:articles(id, name, image_url)),
    card:job_cards(id, stage, qc_passed, cutting_at, stitching_at, qc_at, packed_at, approval_status, approval_photos, approval_requested_at, approval_decided_at, change_request, change_request_audio),
    unit_events:order_unit_events(status, note, created_at)
  ),
  events:order_events!order_events_order_id_fkey(id, status, note, created_at),
  invoice:invoices!invoices_order_id_fkey(*, lines:invoice_lines(*)),
  shipment:shipments!shipments_order_id_fkey(*),
  payments:payments!payments_order_id_fkey(*)
`;

const loadOwnOrder = async (req, select = '*') => {
  const order = unwrapOne(
    await supabaseAdmin.from('orders').select(select).eq('id', req.params.id).eq('customer_id', req.userId).maybeSingle(),
    'Order not found'
  );
  return order;
};

/** The articles picked for a piece, flat and in the partner's type order. Never carries a price. */
/** What the customer sees about one piece's approval (its own photos and decision). */
const shapeApproval = (card) => ({
  status: card?.approval_status || 'none',
  photos: card?.approval_photos || [],
  requested_at: card?.approval_requested_at || null,
  decided_at: card?.approval_decided_at || null,
  change_request: card?.change_request || null,
  change_request_audio: card?.change_request_audio || null,
});

const shapeUnit = ({ picks, unit_price, currency, card, unit_events, ...unit }) => ({
  approval: shapeApproval(one(card)),
  timeline: buildUnitTimeline(unit, one(card), unit_events),
  // the order keeps its own copy of the sizes (later edits to the chart don't change it)
  ...withSizeSnapshot(unit),
  selected_articles: (picks || [])
    .map((p) => ({
      article_type_id: p.article_type_id,
      type_name: one(p.type)?.name ?? null,
      type_sort: one(p.type)?.sort_order ?? 0,
      article_id: p.article_id,
      name: one(p.article)?.name ?? null,
      image_url: one(p.article)?.image_url ?? null,
    }))
    .sort((a, b) => a.type_sort - b.type_sort)
    .map(({ type_sort, ...rest }) => rest),
});

const shapeOrderDetail = (order) => {
  const invoice = one(order.invoice);
  return {
    ...order,
    status_label: STATUS_LABELS[order.status],
    units: (order.units || []).sort((a, b) => a.line_no - b.line_no).map(shapeUnit),
    events: (order.events || []).sort((a, b) => a.created_at.localeCompare(b.created_at)),
    // customers only ever see issued or paid invoices
    invoice: invoice && ['issued', 'paid'].includes(invoice.status)
      ? { ...invoice, lines: (invoice.lines || []).sort((a, b) => a.sort_order - b.sort_order).map(({ partner_amount, ...l }) => l), partner_total_pkr: undefined }
      : null,
    shipment: one(order.shipment),
  };
};

/** Order detail for the customer, with a short-lived link to the uploaded brand invoice. */
const orderDetailResponse = async (order) => signNoteAudio({ ...shapeOrderDetail(order), brand_invoice: await withSignedUrl(order.brand_invoice) });

// ─────────────────────────────── Overview ───────────────────────────────

export const getClientOverview = catchAsync(async (req, res) => {
  const period = req.query.period === 'all' ? 'all' : 'year';
  let q = supabaseAdmin
    .from('orders')
    .select('id, reference, brand, status, created_at, packed_at, shipped_at, delivered_at, units:order_units!order_units_order_id_fkey(id, size_chart:size_charts(person_name, name))')
    .eq('customer_id', req.userId);
  if (period === 'year') q = q.gte('created_at', `${new Date().getUTCFullYear()}-01-01`);
  const allOrders = unwrap(await q);
  const drafts = allOrders.filter((o) => o.status === 'draft');
  const orders = allOrders.filter((o) => o.status !== 'draft');

  const finished = new Set(['packed', 'invoice_issued', 'awaiting_payment', 'paid', 'at_admin_warehouse', 'partner_dispatch', 'shipped', 'delivered']);
  const inProgress = new Set(STATUS_GROUPS.production);

  let articlesStitched = 0;
  let articlesInProgress = 0;
  const people = {};
  const turnaround = [];

  for (const o of orders) {
    const n = o.units.length;
    if (finished.has(o.status)) articlesStitched += n;
    if (inProgress.has(o.status) || o.status === 'submitted') articlesInProgress += n;
    for (const u of o.units) {
      const who = u.size_chart?.person_name || u.size_chart?.name || 'No size chart';
      people[who] = (people[who] || 0) + 1;
    }
    const end = o.packed_at || o.shipped_at;
    if (end) turnaround.push((new Date(end) - new Date(o.created_at)) / 86_400_000);
  }

  // Articles finished per month, last 6 months
  const monthly = [];
  const now = new Date();
  for (let i = 5; i >= 0; i--) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    const key = d.toISOString().slice(0, 7);
    const count = orders
      .filter((o) => (o.packed_at || '').startsWith(key))
      .reduce((acc, o) => acc + o.units.length, 0);
    monthly.push({ month: d.toLocaleString('en-GB', { month: 'short', timeZone: 'UTC' }), key, count });
  }
  const maxMonthly = Math.max(1, ...monthly.map((m) => m.count));
  const peopleTotal = Math.max(1, ...Object.values(people));

  const { count: unread } = await supabaseAdmin
    .from('notifications').select('id', { count: 'exact', head: true }).eq('user_id', req.userId).is('read_at', null);

  return ApiResponse.success(res, {
    period,
    ordersCount: orders.length,
    articlesStitched,
    articlesInProgress,
    avgTurnaroundDays: turnaround.length ? Math.round(turnaround.reduce((a, b) => a + b, 0) / turnaround.length) : null,
    monthly: monthly.map((m) => ({ ...m, pct: Math.round((m.count / maxMonthly) * 100) })),
    whoYouStitchFor: Object.entries(people)
      .map(([name, count]) => ({ name, count, pct: Math.round((count / peopleTotal) * 100) }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 5),
    actionNeeded: orders
      .filter((o) => ['awaiting_payment', 'invoice_issued', 'customer_approval'].includes(o.status))
      .concat(drafts)
      .map((o) => ({ id: o.id, reference: o.reference, brand: o.brand, status: o.status, status_label: STATUS_LABELS[o.status] })),
    unreadNotifications: unread || 0,
  });
});

// ─────────────────────────────── Orders ───────────────────────────────

/**
 * GET /api/client/orders?page&limit&search&status=active|completed|all|<status>
 */
export const getClientOrders = catchAsync(async (req, res) => {
  const q = parseListQuery(req, { defaultLimit: 10, sortable: ['created_at', 'reference'] });
  let query = supabaseAdmin
    .from('orders')
    .select('id, reference, brand, brand_order_number, tracking_number, status, has_issue, import_source, created_at, destination_city, destination_country, units:order_units!order_units_order_id_fkey(count)', { count: 'exact' })
    .eq('customer_id', req.userId)
    .order(q.sort, { ascending: q.ascending })
    .range(q.from, q.to);

  const status = req.query.status;
  if (status === 'active') query = query.in('status', ['draft', ...STATUS_GROUPS.active]);
  else if (status && STATUS_GROUPS[status]) query = query.in('status', STATUS_GROUPS[status]);
  else if (status && STATUS_LABELS[status]) query = query.eq('status', status);
  if (q.search) query = query.or(ilikeAny(['reference', 'brand', 'brand_order_number', 'tracking_number'], q.search));

  const result = await query;
  const rows = unwrap(result, 'Could not load orders').map((o) => ({
    ...o,
    units_count: o.units?.[0]?.count ?? 0,
    units: undefined,
    status_label: STATUS_LABELS[o.status],
  }));
  return sendPage(res, rows, q, result.count);
});

export const getClientOrder = catchAsync(async (req, res) => {
  const order = await loadOwnOrder(req, ORDER_DETAIL_SELECT);
  return ApiResponse.success(res, await orderDetailResponse(order));
});

/** The customer's own charts by id (full rows, used for the order's frozen copy). */
const loadChartsFor = async (userId, ids) => {
  if (!ids.length) return new Map();
  const rows = unwrap(await supabaseAdmin.from('size_charts').select('*').eq('user_id', userId).in('id', ids), 'Could not load the size charts');
  return new Map(rows.map((c) => [c.id, c]));
};

const cleanHttpUrl = (v) => {
  const s = String(v || '').trim();
  return /^https?:\/\/\S+$/i.test(s) ? s.slice(0, 1000) : null;
};

const cleanUnit = (u, i) => {
  const title = String(u.unit_title || u.title || '').trim();
  if (!title) throw new BadRequestError(`Article ${i + 1} needs a product name (e.g. "Embroidered lawn 3-piece").`);
  const link = String(u.product_link || '').trim();
  if (link && !cleanHttpUrl(link)) throw new BadRequestError(`Article ${i + 1}: the product link must start with https://`);
  return {
    unit_title: title.slice(0, 160),
    product_link: link ? link.slice(0, 500) : null,
    product_image_url: cleanHttpUrl(u.product_image_url),
    brand_sku: u.brand_sku ? String(u.brand_sku).slice(0, 80) : null,
    stitching_type: u.stitching_type ? String(u.stitching_type).slice(0, 120) : null,
    size_chart_id: u.size_chart_id || null,
    notes: u.notes ? String(u.notes).slice(0, 2000) : null,
    quantity: Math.max(1, Math.min(20, parseInt(u.quantity, 10) || 1)),
  };
};

/**
 * POST /api/client/orders
 * body: {
 *   brand_id, courier_id, tracking_number, international_shipping (true|false), brand_order_number?, note?,
 *   destination_country?, destination_city?, destination_address?,
 *   units: [{ unit_title, product_link?, product_image_url?, stitching_type?, size_chart_id?, notes?, quantity,
 *             article_ids: [uuid], reference_uploads? }]
 * }
 * Shipping type is derived: international => express, otherwise standard. There is no rush option.
 */
export const createClientOrder = catchAsync(async (req, res) => {
  const body = req.body || {};
  const refs = await resolveOrderRefs(body);
  if (!Array.isArray(body.units) || body.units.length === 0) throw new BadRequestError('Add at least one article.');
  if (body.units.length > 30) throw new BadRequestError('An order can have at most 30 articles.');

  const units = body.units.map(cleanUnit);
  const uploads = body.units.map((u) => (Array.isArray(u.reference_uploads) ? u.reference_uploads.slice(0, 4) : []));
  const picks = await resolveUnitArticles(body.units);
  const noteAudios = await Promise.all(body.units.map((u) => cleanVoiceNote(u.notes_audio, req.userId)));

  // Size charts must belong to this customer
  const chartIds = [...new Set(units.map((u) => u.size_chart_id).filter(Boolean))];
  if (chartIds.length) {
    const own = unwrap(await supabaseAdmin.from('size_charts').select('id').eq('user_id', req.userId).in('id', chartIds));
    if (own.length !== chartIds.length) throw new BadRequestError('One of the selected size charts was not found.');
  }

  const charts = await loadChartsFor(req.userId, chartIds);
  const note = String(body.note ?? body.customer_notes ?? '').trim().slice(0, 2000) || null;
  const due = new Date();
  due.setUTCDate(due.getUTCDate() + 12);
  const p = req.profile;

  const order = unwrap(
    await supabaseAdmin
      .from('orders')
      .insert({
        customer_id: req.userId,
        customer_name: p.full_name || p.email,
        customer_code: p.customer_code,
        ...refs,
        brand_order_number: body.brand_order_number?.trim() || null,
        customer_notes: note,
        priority: 'normal',
        due_date: due.toISOString().slice(0, 10),
        destination_country: (body.destination_country || p.country || '').trim() || (refs.international_shipping === false ? 'Pakistan' : null),
        destination_city: (body.destination_city || p.city || '').trim() || null,
        destination_address: (body.destination_address || p.address || '').trim() || null,
      })
      .select('*')
      .single(),
    'Could not create order'
  );

  const undo = async () => supabaseAdmin.from('orders').delete().eq('id', order.id); // cascades to the pieces
  const insertedUnits = await supabaseAdmin
    .from('order_units')
    .insert(units.map((u, i) => ({ ...u, design: picks[i].design, size_snapshot: sizeSnapshotOf(charts.get(u.size_chart_id)), notes_audio: noteAudios[i] ?? null, line_no: i + 1, order_id: order.id })))
    .select('*');
  if (insertedUnits.error) {
    await undo();
    unwrap(insertedUnits, 'Could not save articles');
  }

  const savedUnits = [...insertedUnits.data].sort((a, b) => a.line_no - b.line_no);
  try {
    for (const [i, unit] of savedUnits.entries()) {
      await saveUnitArticles(unit.id, picks[i].rows);
      // Optional reference photos per article (lace, neckline ideas, etc.)
      if (uploads[i]?.length) {
        const refsUploaded = await uploadDataUrls(`references/${order.id}`, uploads[i]);
        await supabaseAdmin.from('order_units').update({ reference_images: refsUploaded }).eq('id', unit.id);
      }
    }
  } catch (err) {
    await undo();
    throw err;
  }

  // The note becomes the first message of the order's conversation
  if (note) {
    await createMessage({ order, profile: p, kind: 'text', body: note, clientMsgId: `order-note-${order.id}`, silent: true }).catch((err) => console.warn('[Order] note message failed:', err.message));
  }

  await addEvent(order.id, 'submitted', `Order created with ${units.length} article(s) from ${order.brand}`, req.userId);
  await announceNewOrder(order, units.length, req.userId);
  if (body.import_id) await linkImportToOrder(req.userId, order.id, body.import_id); // order made from an email / invoice / links draft

  const full = unwrap(await supabaseAdmin.from('orders').select(ORDER_DETAIL_SELECT).eq('id', order.id).single());
  return ApiResponse.created(res, await orderDetailResponse(full), `Order ${order.reference} created.`);
});

/** A new order (or a draft the customer just submitted) reaches the partner and admin, and the customer is told what to do next. */
const announceNewOrder = async (order, unitsCount, userId) => {
  if (!order.partner_id) {
    // manual mode (or no partner can take it): the admin must choose a partner before anyone can receive the parcel
    await notifyAdmins({ type: 'alert', title: `New order ${order.reference} needs a partner`, body: `${order.customer_name} (${order.customer_code}) · ${unitsCount} article(s) from ${order.brand}. Choose which partner receives it.`, link: `/admin/orders?ref=${order.reference}`, orderId: order.id });
  } else await notifyStaff({
    type: 'order',
    title: `New order ${order.reference}`,
    body: `${order.customer_name} (${order.customer_code}) · ${unitsCount} article(s) from ${order.brand}${order.international_shipping ? ' · international (express)' : ' · local (standard)'}. Parcel expected${order.tracking_number ? ` · tracking ${order.tracking_number}` : ''}.`,
    link: { admin: `/admin/orders?ref=${order.reference}`, partner_staff: `/partner/receiving?search=${order.customer_code}` },
    orderId: order.id,
  }, null, { module: 'receiving' });
  await notifyUser(userId, {
    type: 'order',
    title: `Order ${order.reference} created`,
    body: `Ship your parcel to our address with your code ${order.customer_code} on the label so we can match it.`,
    link: `/app/orders/${order.id}`,
    orderId: order.id,
  });

};

/**
 * PATCH /api/client/orders/:id — editable only while the parcel has not arrived (status submitted).
 * Same body as create; brand/courier/shipping fields are re-validated together.
 */
export const updateClientOrder = catchAsync(async (req, res) => {
  const order = await loadOwnOrder(req);
  // a draft made from an email is completed here: saving it submits it, like a newly created order
  const isDraft = order.status === 'draft';
  if (order.status !== 'submitted' && !isDraft) throw new ForbiddenError('This order can no longer be edited because the parcel has arrived.');
  const body = req.body || {};

  const patch = {};
  if (isDraft || body.brand_id !== undefined || body.courier_id !== undefined || body.international_shipping !== undefined || body.tracking_number !== undefined) {
    // validate the shipping block as a whole, filling gaps from the current order
    Object.assign(
      patch,
      await resolveOrderRefs(
        {
          brand_id: body.brand_id ?? order.brand_id,
          courier_id: body.courier_id ?? order.courier_id,
          tracking_number: body.tracking_number ?? order.tracking_number,
          international_shipping: body.international_shipping ?? order.international_shipping,
        },
        { order }
      )
    );
  }
  if (body.brand_order_number !== undefined) patch.brand_order_number = String(body.brand_order_number || '').trim() || null;
  const noteChanged = body.note !== undefined || body.customer_notes !== undefined;
  if (noteChanged) patch.customer_notes = String(body.note ?? body.customer_notes ?? '').trim().slice(0, 2000) || null;
  for (const key of ['destination_country', 'destination_city', 'destination_address']) {
    if (body[key] !== undefined) patch[key] = String(body[key] || '').trim() || null;
  }
  if (Object.keys(patch).length) unwrap(await supabaseAdmin.from('orders').update({ ...patch, updated_at: new Date().toISOString() }).eq('id', order.id));

  if (Array.isArray(body.units)) {
    if (!body.units.length) throw new BadRequestError('Add at least one article.');
    if (body.units.length > 30) throw new BadRequestError('An order can have at most 30 articles.');
    const existing = unwrap(await supabaseAdmin.from('order_units').select('id, reference_images, picks:order_unit_articles(article_id)').eq('order_id', order.id));
    const keepIds = new Set(body.units.map((u) => u.id).filter((id) => existing.some((e) => e.id === id)));

    // articles an existing piece already has stay valid even if the partner switched them off since
    const already = body.units.map((u) => new Set((existing.find((e) => e.id === u.id)?.picks || []).map((x) => x.article_id)));
    const cleaned = body.units.map(cleanUnit);
    const picks = await resolveUnitArticles(body.units, already);
    const noteAudios = await Promise.all(body.units.map((u) => cleanVoiceNote(u.notes_audio, req.userId)));
    const editCharts = await loadChartsFor(req.userId, [...new Set(cleaned.map((u) => u.size_chart_id).filter(Boolean))]);

    // Articles removed in the edit
    const removed = existing.filter((e) => !keepIds.has(e.id)).map((e) => e.id);
    if (removed.length) unwrap(await supabaseAdmin.from('order_units').delete().in('id', removed));

    // Update kept articles in place (keeps their photos), insert new ones
    for (const [i, raw] of body.units.entries()) {
      const unit = { ...cleaned[i], design: picks[i].design, size_snapshot: sizeSnapshotOf(editCharts.get(cleaned[i].size_chart_id)), line_no: i + 1, updated_at: new Date().toISOString(), ...(noteAudios[i] !== undefined ? { notes_audio: noteAudios[i] } : {}) };
      const prev = existing.find((e) => e.id === raw.id);
      const uploads = Array.isArray(raw.reference_uploads) ? raw.reference_uploads.slice(0, 4) : [];
      const refsUploaded = uploads.length ? await uploadDataUrls(`references/${order.id}`, uploads) : [];
      let unitId;
      if (prev && keepIds.has(prev.id)) {
        const kept = Array.isArray(raw.reference_images) ? raw.reference_images : prev.reference_images || [];
        unwrap(await supabaseAdmin.from('order_units').update({ ...unit, reference_images: [...kept, ...refsUploaded].slice(0, 8) }).eq('id', prev.id));
        unitId = prev.id;
      } else {
        const created = unwrap(await supabaseAdmin.from('order_units').insert({ ...unit, order_id: order.id, reference_images: refsUploaded }).select('id').single());
        unitId = created.id;
      }
      await saveUnitArticles(unitId, picks[i].rows);
    }
  }
  if (isDraft) {
    const { count } = await supabaseAdmin.from('order_units').select('id', { count: 'exact', head: true }).eq('order_id', order.id);
    if (!count) throw new BadRequestError('Add at least one article.');
    // the partner is chosen by the database as the status leaves "draft" (Settings > Orders)
    const submitted = unwrap(await supabaseAdmin.from('orders').update({ status: 'submitted', updated_at: new Date().toISOString() }).eq('id', order.id).eq('status', 'draft').select('*').single(), 'Could not submit the order');
    await addEvent(order.id, 'submitted', `Draft submitted with ${count} article(s) from ${submitted.brand}`, req.userId);
    if (submitted.customer_notes) {
      await createMessage({ order: submitted, profile: req.profile, kind: 'text', body: submitted.customer_notes, clientMsgId: `order-note-${order.id}`, silent: true }).catch((err) => console.warn('[Order] note message failed:', err.message));
    }
    await announceNewOrder(submitted, count, req.userId);
  } else {
    await addEvent(order.id, 'submitted', 'Order details updated by customer', req.userId);
  }

  const full = unwrap(await supabaseAdmin.from('orders').select(ORDER_DETAIL_SELECT).eq('id', order.id).single());
  return ApiResponse.success(res, await orderDetailResponse(full), isDraft ? `Order ${full.reference} submitted.` : 'Order updated.');
});

// ─────────────────────────────── Product link preview ───────────────────────────────

const previewHits = new Map();

/**
 * POST /api/client/products/preview { url }
 * Reads the product page the customer pasted (name + picture) so the form can fill itself in.
 * The price is deliberately not returned. Limited to 10 reads a minute per customer.
 */
export const previewProduct = catchAsync(async (req, res) => {
  const url = String(req.body?.url || '').trim();
  if (!/^https?:\/\/\S+$/i.test(url)) throw new BadRequestError('Paste a full product link starting with https://');
  const now = Date.now();
  const hits = (previewHits.get(req.userId) || []).filter((t) => now - t < 60_000);
  if (hits.length >= 10) throw new BadRequestError('Too many link checks. Wait a minute and try again.');
  previewHits.set(req.userId, [...hits, now]);

  const r = await readProductLink(url);
  return ApiResponse.success(res, { url: r.url, ok: r.ok, title: r.title, image_url: r.image_url, brand: r.brand, error: r.error });
});

/**
 * DELETE /api/client/orders/:id — discard a draft made from an email. The email's order draft becomes available again.
 */
export const deleteClientDraft = catchAsync(async (req, res) => {
  const order = await loadOwnOrder(req);
  if (order.status !== 'draft') throw new ForbiddenError('Only a draft can be discarded. Cancel a submitted order instead.');
  await supabaseAdmin.from('order_imports').update({ status: 'ready', order_id: null, updated_at: new Date().toISOString() }).eq('order_id', order.id);
  unwrap(await supabaseAdmin.from('orders').delete().eq('id', order.id).eq('status', 'draft'), 'Could not discard the draft');
  return ApiResponse.success(res, null, 'Draft discarded.');
});

export const cancelClientOrder = catchAsync(async (req, res) => {
  const order = await loadOwnOrder(req);
  if (order.status !== 'submitted') throw new ForbiddenError('Only orders whose parcel has not arrived can be cancelled.');
  await setOrderStatus(order.id, 'cancelled', { note: 'Cancelled by customer', actorId: req.userId });
  await notifyStaff({ type: 'alert', title: `Order ${order.reference} cancelled`, body: 'The customer cancelled before the parcel arrived.', orderId: order.id }, req.userId, { module: 'receiving' });
  return ApiResponse.success(res, null, 'Order cancelled.');
});

/** The order's tickets that are waiting for this customer (all of them, or just one piece). */
const pendingCards = async (order, unitId) => {
  let q = supabaseAdmin.from('job_cards').select('*').eq('order_id', order.id).eq('approval_status', 'pending');
  if (unitId) q = q.eq('unit_id', unitId);
  return unwrap(await q);
};

const cardActivity = (card, req, body) =>
  supabaseAdmin.from('job_card_comments').insert({
    job_card_id: card.id,
    author_id: req.userId,
    author_name: req.profile.full_name || req.profile.email,
    body,
    kind: 'activity',
  });

/**
 * POST /api/client/orders/:id/approve  body: { unit_id? }
 * Approve the photos of one piece (unit_id) or, without unit_id, of every piece that is waiting.
 */
export const approveClientOrder = catchAsync(async (req, res) => {
  const order = await loadOwnOrder(req);
  const unitId = req.body?.unit_id || null;
  const cards = await pendingCards(order, unitId);
  if (!cards.length) throw new BadRequestError(unitId ? 'This article is not waiting for your approval.' : 'Nothing is waiting for your approval.');

  const now = new Date().toISOString();
  for (const c of cards) {
    unwrap(await supabaseAdmin.from('job_cards').update({ approval_status: 'approved', approval_decided_at: now, updated_at: now }).eq('id', c.id));
    await cardActivity(c, req, 'Photos approved by the customer');
    await logUnitEvent(c.unit_id, order.id, 'approved', { actorId: req.userId });
    await notifyPartner({ type: 'update', title: `Approved: ${order.reference} · ${c.unit_title}`, body: 'The customer approved the photos. You can pack once every article is ready.', link: `/partner/production/jobs/${c.id}`, orderId: order.id }, req.userId, { module: 'production' });
  }
  await addEvent(order.id, order.status, `Photos approved by the customer: ${cards.map((c) => c.unit_title).join(', ')}`, req.userId);
  await syncOrderFromCards(order.id, req.userId);
  const left = (await pendingCards(order)).length;
  return ApiResponse.success(res, { approved: cards.length, stillWaiting: left }, left ? `Approved. ${left} more ${left === 1 ? 'article is' : 'articles are'} waiting for your approval.` : 'Thank you! Your outfit will now be packed.');
});

/**
 * POST /api/client/orders/:id/request-changes  body: { unit_id?, note?, audio? }
 * Ask for changes on one piece (unit_id) or on every piece that is waiting. Only those tickets go back to stitching.
 */
export const requestChanges = catchAsync(async (req, res) => {
  const note = String(req.body?.note || '').trim();
  const audio = await cleanVoiceNote(req.body?.audio, req.userId);
  if (note.length < 3 && !audio) throw new BadRequestError('Please describe the change you need (type it or record a voice note).');
  const order = await loadOwnOrder(req);
  const unitId = req.body?.unit_id || null;
  const cards = await pendingCards(order, unitId);
  if (!cards.length) throw new BadRequestError('Changes can only be requested for an article that is waiting for your approval.');

  const now = new Date().toISOString();
  const text = note || 'Voice note';
  for (const c of cards) {
    unwrap(await supabaseAdmin.from('job_cards').update({
      stage: 'stitching', qc_passed: false, stitching_at: now, updated_at: now,
      approval_status: 'changes_requested', approval_decided_at: now, change_request: text, change_request_audio: audio ?? null,
    }).eq('id', c.id));
    await cardActivity(c, req, `Change requested by the customer: ${text}`);
    await logUnitEvent(c.unit_id, order.id, 'changes_requested', { note: text, actorId: req.userId });
  }
  const titles = cards.map((c) => c.unit_title).join(', ');
  await addEvent(order.id, order.status, `Change requested by customer (${titles}): ${text}`, req.userId);
  await syncOrderFromCards(order.id, req.userId);
  await notifyPartner({ type: 'update', title: `Change request: ${order.reference} · ${titles}`, body: note || 'The customer left a voice note.', link: cards.length === 1 ? `/partner/production/jobs/${cards[0].id}` : `/partner/production?search=${order.reference}`, orderId: order.id }, req.userId, { module: 'production' });
  await notifyAdmins({ type: 'alert', title: `Change request: ${order.reference}`, body: `${titles}: ${note || 'voice note'}`, link: `/admin/orders?ref=${order.reference}`, orderId: order.id });
  return ApiResponse.success(res, { changed: cards.length }, 'Your change request was sent to the tailor.');
});

/**
 * POST /api/client/orders/:id/pay
 * The card gateway is not chosen yet (see project brief). This records a TEST card payment.
 */
export const payClientOrder = catchAsync(async (req, res) => {
  // This simulated payment charges nothing. It exists only for local development without Stripe keys.
  if (isStripeEnabled()) throw new BadRequestError('Please pay with your card using the payment form.');
  if (config.nodeEnv === 'production') throw new BadRequestError('Payments are not available right now.');
  const order = await loadOwnOrder(req, '*, invoice:invoices!invoices_order_id_fkey(*)');
  const invoice = one(order.invoice);
  if (!invoice || invoice.status !== 'issued') throw new BadRequestError('There is no unpaid invoice for this order.');
  if (!['awaiting_payment', 'invoice_issued'].includes(order.status)) throw new BadRequestError('This order is not awaiting payment.');

  const now = new Date().toISOString();
  unwrap(await supabaseAdmin.from('payments').insert({
    invoice_id: invoice.id,
    order_id: order.id,
    amount_pkr: invoice.total_pkr,
    amount_foreign: invoice.total_foreign,
    currency: invoice.currency,
    method: 'card',
    provider_ref: `TEST-${Date.now()}`,
    status: 'succeeded',
    created_by: req.userId,
  }));
  unwrap(await supabaseAdmin.from('invoices').update({ status: 'paid', paid_at: now, updated_at: now }).eq('id', invoice.id));
  await setOrderStatus(order.id, 'paid', {
    note: `Payment received · ${invoice.currency} ${round2(invoice.total_foreign)} (invoice ${invoice.number})`,
    actorId: req.userId,
    extra: { paid_at: now },
  });

  await notifyUser(req.userId, { type: 'invoice', title: `Payment confirmed: ${order.reference}`, body: `Thank you! Invoice ${invoice.number} is paid. We will dispatch your order soon.`, link: `/app/orders/${order.id}`, orderId: order.id });
  await notifyPartner({ type: 'invoice', title: `Paid: ${order.reference}`, body: 'Choose the dispatch route in Warehouse.', link: '/partner/warehouse?tab=paid', orderId: order.id }, null, { module: 'warehouse' });
  await notifyAdmins({ type: 'invoice', title: `Payment received: ${order.reference}`, body: `${invoice.currency} ${round2(invoice.total_foreign)} · ${order.customer_name}`, link: `/admin/invoices?tab=paid`, orderId: order.id });

  return ApiResponse.success(res, null, 'Payment successful.');
});

// ─────────────────────────────── Size charts ───────────────────────────────

const cleanMeasurements = (m) => cleanMeasurementsRaw(m, (msg) => new BadRequestError(msg));
const cleanNearestSize = (v) => cleanNearestRaw(v, (msg) => new BadRequestError(msg));

export const getClientSizes = catchAsync(async (req, res) => {
  const q = parseListQuery(req, { defaultLimit: 50, sortable: ['created_at', 'name', 'person_name'], defaultSort: 'person_name', defaultDir: 'asc' });
  let query = supabaseAdmin
    .from('size_charts')
    .select('*', { count: 'exact' })
    .eq('user_id', req.userId)
    .order(q.sort, { ascending: q.ascending })
    .order('created_at', { ascending: true })
    .range(q.from, q.to);
  if (q.search) query = query.or(ilikeAny(['name', 'person_name', 'variation'], q.search));
  const result = await query;
  return sendPage(res, await signNoteAudio(unwrap(result)), q, result.count);
});

/** Case-insensitive: does this customer already have <person> / <variation>? */
const findChart = async (userId, person, variation) => {
  const { data } = await supabaseAdmin.from('size_charts').select('id, person_name, variation').eq('user_id', userId);
  return (
    (data || []).find(
      (c) => String(c.person_name || '').trim().toLowerCase() === person.toLowerCase() && String(c.variation || 'Standard').trim().toLowerCase() === variation.toLowerCase()
    ) || null
  );
};

/** POST /api/client/sizes { person_name, variation, nearest_size?, measurements, notes } */
export const createClientSize = catchAsync(async (req, res) => {
  const person = String(req.body.person_name || '').replace(/\s+/g, ' ').trim();
  if (!person) throw new BadRequestError('Who is this size chart for? (e.g. Me, Mother)');
  if (person.length > 60) throw new BadRequestError('The person name must be 60 characters or fewer.');
  const variation = String(req.body.variation || 'Standard').replace(/\s+/g, ' ').trim() || 'Standard';
  if (variation.length > 60) throw new BadRequestError('The variation name must be 60 characters or fewer.');
  if (await findChart(req.userId, person, variation)) {
    throw new ConflictError(`${person} already has a "${variation}" size. Choose another variation name or edit that one.`);
  }
  const row = unwrap(
    await supabaseAdmin
      .from('size_charts')
      .insert({
        user_id: req.userId,
        person_name: person,
        variation,
        name: `${person} · ${variation}`,
        nearest_size: cleanNearestSize(req.body.nearest_size) ?? null,
        measurements: cleanMeasurements(req.body.measurements),
        notes: String(req.body.notes ?? '').trim().slice(0, 2000) || null,
        notes_audio: (await cleanVoiceNote(req.body.notes_audio, req.userId)) ?? null,
      })
      .select('*')
      .single()
  );
  return ApiResponse.created(res, await signNoteAudio(row), 'Size chart saved.');
});

export const updateClientSize = catchAsync(async (req, res) => {
  const existing = unwrapOne(
    await supabaseAdmin.from('size_charts').select('*').eq('id', req.params.id).eq('user_id', req.userId).maybeSingle(),
    'Size chart not found'
  );
  const person = req.body.person_name !== undefined ? String(req.body.person_name).replace(/\s+/g, ' ').trim() : existing.person_name;
  const variation = req.body.variation !== undefined ? String(req.body.variation).replace(/\s+/g, ' ').trim() || 'Standard' : existing.variation;
  if (!person) throw new BadRequestError('Who is this size chart for? (e.g. Me, Mother)');
  const dupe = await findChart(req.userId, person, variation || 'Standard');
  if (dupe && dupe.id !== existing.id) throw new ConflictError(`${person} already has a "${variation}" size. Choose another variation name.`);
  const nearest = cleanNearestSize(req.body.nearest_size);
  const voice = await cleanVoiceNote(req.body.notes_audio, req.userId);
  const row = unwrap(
    await supabaseAdmin
      .from('size_charts')
      .update({
        person_name: person,
        variation,
        name: `${person} · ${variation}`,
        nearest_size: nearest === undefined ? existing.nearest_size : nearest,
        measurements: req.body.measurements ? cleanMeasurements(req.body.measurements) : existing.measurements,
        notes: req.body.notes !== undefined ? String(req.body.notes ?? '').trim().slice(0, 2000) || null : existing.notes,
        notes_audio: voice === undefined ? existing.notes_audio : voice,
        updated_at: new Date().toISOString(),
      })
      .eq('id', existing.id)
      .select('*')
      .single()
  );
  // Orders whose parcel has not arrived yet follow the corrected sizes; orders already in work keep their copy
  const { data: open } = await supabaseAdmin
    .from('order_units')
    .select('id, order:orders!order_units_order_id_fkey!inner(status)')
    .eq('size_chart_id', existing.id)
    .eq('order.status', 'submitted');
  if (open?.length) await supabaseAdmin.from('order_units').update({ size_snapshot: sizeSnapshotOf(row) }).in('id', open.map((u) => u.id));
  return ApiResponse.success(res, await signNoteAudio(row), 'Size chart updated.');
});

export const deleteClientSize = catchAsync(async (req, res) => {
  const { data, error } = await supabaseAdmin.from('size_charts').delete().eq('id', req.params.id).eq('user_id', req.userId).select('id');
  if (error) unwrap({ error });
  if (!data?.length) throw new NotFoundError('Size chart not found');
  return ApiResponse.success(res, null, 'Size chart deleted.');
});
