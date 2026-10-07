import { supabaseAdmin } from '../config/supabase.js';
import { catchAsync, ApiResponse, BadRequestError } from '../utils/error.helper.js';
import { parseListQuery, sendPage, ilikeAny } from '../utils/pagination.js';
import { unwrap, unwrapOne, todayISO, round2, sum } from '../utils/db.js';
import { setOrderStatus, addEvent, getOrderOr404, STATUS_LABELS } from '../services/order.service.js';
import { notifyUser, notifyPartner, notifyAdmins } from '../services/notification.service.js';
import { resolveCourier } from '../services/courier.service.js';
import { inActivePartner } from '../services/access.service.js';

const one = (v) => (Array.isArray(v) ? v[0] ?? null : v ?? null);

const CURRENCY_BY_COUNTRY = [
  [/^(uk|united kingdom|england|scotland|wales|great britain|gb)$/i, 'GBP'],
  [/^(us|usa|united states|america)$/i, 'USD'],
  [/^(ca|canada)$/i, 'CAD'],
  [/^(ae|uae|united arab emirates|dubai)$/i, 'AED'],
  [/^(sa|saudi arabia|ksa)$/i, 'SAR'],
  [/^(au|australia)$/i, 'AUD'],
  [/^(pk|pakistan)$/i, 'PKR'],
  [/^(ie|ireland|de|germany|fr|france|nl|netherlands|it|italy|es|spain|be|belgium)$/i, 'EUR'],
];
const currencyFor = (country) => CURRENCY_BY_COUNTRY.find(([re]) => re.test(String(country || '').trim()))?.[1] || 'PKR';

/** Ids of orders matching a free-text search (used to search tables that only hold order_id). */
const orderIdsMatching = async (search) => {
  const rows = unwrap(
    await supabaseAdmin.from('orders').select('id').or(ilikeAny(['reference', 'customer_name', 'customer_code', 'destination_city', 'destination_country'], search)).limit(300)
  );
  return rows.map((r) => r.id);
};

// ─────────────────────────────── Price list ───────────────────────────────

const PRICE_CATEGORIES = ['stitching', 'accessory', 'accessory_stitching', 'finishing', 'other'];

export const getPriceItems = catchAsync(async (req, res) => {
  const q = parseListQuery(req, { defaultLimit: 20, sortable: ['name', 'category', 'customer_price', 'partner_cost', 'created_at'], defaultSort: 'category', defaultDir: 'asc' });
  let query = supabaseAdmin.from('price_items').select('*', { count: 'exact' })
    .order(q.sort, { ascending: q.ascending }).order('name').range(q.from, q.to);
  if (PRICE_CATEGORIES.includes(req.query.category)) query = query.eq('category', req.query.category);
  if (req.query.active === 'true') query = query.eq('is_active', true);
  if (q.search) query = query.or(ilikeAny(['name', 'unit'], q.search));
  const result = await query;
  return sendPage(res, unwrap(result).map((p) => ({ ...p, margin: round2(p.customer_price - p.partner_cost) })), q, result.count);
});

const cleanPriceItem = (b, partial) => {
  const out = {};
  if (!partial || b.name !== undefined) {
    if (!String(b.name || '').trim()) throw new BadRequestError('Item name is required.');
    out.name = String(b.name).trim().slice(0, 160);
  }
  if (!partial || b.category !== undefined) {
    if (!PRICE_CATEGORIES.includes(b.category)) throw new BadRequestError('Choose a valid category.');
    out.category = b.category;
  }
  for (const key of ['partner_cost', 'customer_price']) {
    if (!partial || b[key] !== undefined) {
      const n = Number(b[key]);
      if (!(n >= 0)) throw new BadRequestError(`${key.replace('_', ' ')} must be 0 or more.`);
      out[key] = round2(n);
    }
  }
  if (b.unit !== undefined) out.unit = String(b.unit || 'per article').slice(0, 40);
  if (b.is_active !== undefined) out.is_active = !!b.is_active;
  return out;
};

export const createPriceItem = catchAsync(async (req, res) =>
  ApiResponse.created(res, unwrap(await supabaseAdmin.from('price_items').insert(cleanPriceItem(req.body || {}, false)).select('*').single()), 'Price item added.'));

export const updatePriceItem = catchAsync(async (req, res) =>
  ApiResponse.success(res, unwrapOne(await supabaseAdmin.from('price_items').update({ ...cleanPriceItem(req.body || {}, true), updated_at: new Date().toISOString() }).eq('id', req.params.id).select('*').maybeSingle(), 'Price item not found'), 'Price item updated.'));

export const deletePriceItem = catchAsync(async (req, res) => {
  // Keep history intact: items used on invoices are deactivated instead of deleted
  const { count } = await supabaseAdmin.from('invoice_lines').select('id', { count: 'exact', head: true }).eq('price_item_id', req.params.id);
  if (count) {
    unwrap(await supabaseAdmin.from('price_items').update({ is_active: false }).eq('id', req.params.id));
    return ApiResponse.success(res, null, 'Item is used on invoices, so it was deactivated instead of deleted.');
  }
  unwrap(await supabaseAdmin.from('price_items').delete().eq('id', req.params.id));
  return ApiResponse.success(res, null, 'Price item deleted.');
});

// ─────────────────────────────── Shipping rates ───────────────────────────────

export const getShippingRates = catchAsync(async (req, res) => {
  const q = parseListQuery(req, { defaultLimit: 20, sortable: ['courier', 'zone', 'base_rate', 'created_at'], defaultSort: 'courier', defaultDir: 'asc' });
  let query = supabaseAdmin.from('shipping_rates').select('*', { count: 'exact' }).order(q.sort, { ascending: q.ascending }).order('zone').range(q.from, q.to);
  if (q.search) query = query.or(ilikeAny(['courier', 'zone', 'transit_time'], q.search));
  if (req.query.active === 'true') query = query.eq('is_active', true);
  const result = await query;
  return sendPage(res, unwrap(result), q, result.count);
});

const cleanRate = (b, partial) => {
  const out = {};
  for (const key of ['courier', 'zone']) {
    if (!partial || b[key] !== undefined) {
      if (!String(b[key] || '').trim()) throw new BadRequestError(`${key} is required.`);
      out[key] = String(b[key]).trim().slice(0, 120);
    }
  }
  if (b.countries !== undefined) {
    const list = Array.isArray(b.countries) ? b.countries : String(b.countries || '').split(',');
    out.countries = list.map((c) => String(c).trim()).filter(Boolean).slice(0, 60);
  }
  if (b.service !== undefined) out.service = b.service === 'standard' ? 'standard' : 'express';
  if (b.transit_time !== undefined) out.transit_time = String(b.transit_time || '').slice(0, 60);
  for (const key of ['max_weight_kg', 'base_rate', 'per_extra_kg', 'ddp_fee']) {
    if (!partial || b[key] !== undefined) {
      const n = Number(b[key] ?? 0);
      if (!(n >= 0)) throw new BadRequestError(`${key.replace(/_/g, ' ')} must be 0 or more.`);
      out[key] = round2(n);
    }
  }
  if (b.ddp_available !== undefined) out.ddp_available = !!b.ddp_available;
  if (b.is_active !== undefined) out.is_active = !!b.is_active;
  return out;
};

export const createShippingRate = catchAsync(async (req, res) =>
  ApiResponse.created(res, unwrap(await supabaseAdmin.from('shipping_rates').insert(cleanRate(req.body || {}, false)).select('*').single()), 'Shipping rate added.'));

export const updateShippingRate = catchAsync(async (req, res) =>
  ApiResponse.success(res, unwrapOne(await supabaseAdmin.from('shipping_rates').update({ ...cleanRate(req.body || {}, true), updated_at: new Date().toISOString() }).eq('id', req.params.id).select('*').maybeSingle(), 'Rate not found'), 'Shipping rate updated.'));

export const deleteShippingRate = catchAsync(async (req, res) => {
  const { count } = await supabaseAdmin.from('shipments').select('id', { count: 'exact', head: true }).eq('shipping_rate_id', req.params.id);
  if (count) {
    unwrap(await supabaseAdmin.from('shipping_rates').update({ is_active: false }).eq('id', req.params.id));
    return ApiResponse.success(res, null, 'Rate is used by shipments, so it was deactivated instead of deleted.');
  }
  unwrap(await supabaseAdmin.from('shipping_rates').delete().eq('id', req.params.id));
  return ApiResponse.success(res, null, 'Shipping rate deleted.');
});

/** Rates that serve a country, priced for a weight. */
const ratesFor = async (country, weightKg, service) => {
  const all = unwrap(await supabaseAdmin.from('shipping_rates').select('*').eq('is_active', true));
  const c = String(country || '').trim().toLowerCase();
  const matching = all.filter((r) => !r.countries?.length || r.countries.some((x) => x.toLowerCase() === c));
  const w = Number(weightKg || 0);
  return matching
    .map((r) => ({
      ...r,
      price_pkr: round2(Number(r.base_rate) + Math.max(0, Math.ceil(w - Number(r.max_weight_kg))) * Number(r.per_extra_kg)),
      recommended: false,
    }))
    .sort((a, b) => (a.service === service ? 0 : 1) - (b.service === service ? 0 : 1) || a.price_pkr - b.price_pkr)
    .map((r, i) => ({ ...r, recommended: i === 0 }));
};

// ─────────────────────────────── Invoices ───────────────────────────────

const INVOICE_TABS = ['to_invoice', 'issued', 'paid'];

/**
 * GET /api/admin/invoices?tab=to_invoice|issued|paid&search&page
 * Rows are always { order, invoice } so the UI can treat every tab the same way.
 */
export const getAdminInvoices = catchAsync(async (req, res) => {
  const tab = INVOICE_TABS.includes(req.query.tab) ? req.query.tab : 'to_invoice';
  const q = parseListQuery(req, { defaultLimit: 12 });
  const orderCols = 'id, reference, brand, status, customer_name, customer_code, destination_city, destination_country, weight_kg, packed_at, units:order_units!order_units_order_id_fkey(count)';

  let rows;
  let total;
  if (tab === 'to_invoice') {
    let query = inActivePartner(req.access, supabaseAdmin.from('orders')
      .select(`${orderCols}, invoice:invoices!invoices_order_id_fkey(id, number, status, total_pkr, currency, total_foreign)`, { count: 'exact' })
      .eq('status', 'packed').order('packed_at', { ascending: true, nullsFirst: false }).range(q.from, q.to));
    if (q.search) query = query.or(ilikeAny(['reference', 'customer_name', 'customer_code', 'destination_country'], q.search));
    const result = await query;
    rows = unwrap(result).map(({ invoice, ...order }) => ({ order: { ...order, units_count: order.units?.[0]?.count ?? 0, units: undefined }, invoice: one(invoice) }));
    total = result.count;
  } else {
    let query = inActivePartner(req.access, supabaseAdmin.from('invoices')
      .select(`*, order:orders!invoices_order_id_fkey!inner(${orderCols}, partner_id)`, { count: 'exact' })
      .eq('status', tab)
      .order(tab === 'paid' ? 'paid_at' : 'issued_at', { ascending: false, nullsFirst: false })
      .range(q.from, q.to), 'order.partner_id');
    if (q.search) {
      const ids = await orderIdsMatching(q.search);
      query = query.or(ids.length ? `number.ilike.%${q.search}%,order_id.in.(${ids.join(',')})` : `number.ilike.%${q.search}%`);
    }
    const result = await query;
    rows = unwrap(result).map(({ order, ...invoice }) => ({ order: order ? { ...order, units_count: order.units?.[0]?.count ?? 0, units: undefined } : null, invoice }));
    total = result.count;
  }

  const [toInvoice, issued, paid, issuedTotal] = await Promise.all([
    inActivePartner(req.access, supabaseAdmin.from('orders').select('id', { count: 'exact', head: true }).eq('status', 'packed')),
    inActivePartner(req.access, supabaseAdmin.from('invoices').select('id, order:orders!invoices_order_id_fkey!inner(partner_id)', { count: 'exact', head: true }).eq('status', 'issued'), 'order.partner_id'),
    inActivePartner(req.access, supabaseAdmin.from('invoices').select('id, order:orders!invoices_order_id_fkey!inner(partner_id)', { count: 'exact', head: true }).eq('status', 'paid'), 'order.partner_id'),
    inActivePartner(req.access, supabaseAdmin.from('invoices').select('total_pkr, order:orders!invoices_order_id_fkey!inner(partner_id)').eq('status', 'issued'), 'order.partner_id'),
  ]);
  return sendPage(res, rows, q, total, {
    counts: { to_invoice: toInvoice.count || 0, issued: issued.count || 0, paid: paid.count || 0 },
    outstandingPkr: round2(sum(unwrap(issuedTotal), 'total_pkr')),
  });
});

const suggestLines = async (order, priceItems, shippingOptions) => {
  // Pricing comes from the articles the customer picked for each piece (Partner > Articles); the price list is the fallback.
  const unitIds = order.units.map((u) => u.id);
  const picks = unitIds.length
    ? unwrap(await supabaseAdmin.from('order_unit_articles').select('unit_id, article:articles(id, name, customer_price, partner_cost), type:article_types(name, sort_order)').in('unit_id', unitIds))
    : [];
  const stitching = priceItems.filter((p) => p.category === 'stitching');
  const lines = [];
  for (const [i, u] of order.units.entries()) {
    const qty = u.quantity || 1;
    const priced = picks
      .filter((p) => p.unit_id === u.id && one(p.article) && Number(one(p.article).customer_price) > 0)
      .sort((a, b) => (one(a.type)?.sort_order ?? 0) - (one(b.type)?.sort_order ?? 0));
    if (priced.length) {
      for (const p of priced) {
        const art = one(p.article);
        lines.push({
          kind: 'stitching',
          label: art.name,
          description: `Article ${i + 1} · ${u.unit_title}${one(p.type)?.name ? ` · ${one(p.type).name}` : ''}`,
          unit_id: u.id,
          price_item_id: null,
          quantity: qty,
          customer_amount: round2(Number(art.customer_price) * qty),
          partner_amount: round2(Number(art.partner_cost || 0) * qty),
        });
      }
      continue;
    }
    const match = u.stitching_type && stitching.find((p) => p.name.toLowerCase().includes(u.stitching_type.toLowerCase()));
    lines.push({
      kind: 'stitching',
      label: match ? match.name : 'Stitching',
      description: `Article ${i + 1} · ${u.unit_title}`,
      unit_id: u.id,
      price_item_id: match?.id || null,
      quantity: qty,
      customer_amount: match ? round2(match.customer_price * qty) : 0,
      partner_amount: match ? round2(match.partner_cost * qty) : 0,
    });
  }
  const ship = shippingOptions.find((r) => r.recommended);
  if (ship) {
    lines.push({ kind: 'shipping', label: `${ship.courier} · ${ship.zone}`, description: `${order.weight_kg || '?'} kg · ${ship.transit_time || ''}`.trim(), quantity: 1, customer_amount: ship.price_pkr, partner_amount: 0 });
    if (ship.ddp_available && Number(ship.ddp_fee) > 0) {
      lines.push({ kind: 'duties', label: 'Duties paid (DDP)', description: 'No charges at the door', quantity: 1, customer_amount: round2(ship.ddp_fee), partner_amount: 0 });
    }
  }
  return lines.map((l, i) => ({ ...l, sort_order: i }));
};

/**
 * GET /api/admin/invoices/builder/:orderId
 */
export const getInvoiceBuilder = catchAsync(async (req, res) => {
  const order = unwrapOne(
    await supabaseAdmin.from('orders')
      .select('*, units:order_units!order_units_order_id_fkey(id, unit_title, stitching_type, quantity, notes, line_no, created_at), invoice:invoices!invoices_order_id_fkey(*, lines:invoice_lines(*)), customer:profiles!orders_customer_id_fkey(full_name, email, phone, customer_code)')
      .eq('id', req.params.orderId).maybeSingle(),
    'Order not found'
  );
  order.units.sort((a, b) => a.line_no - b.line_no);
  const invoice = one(order.invoice);
  const [priceItems, shippingOptions] = await Promise.all([
    supabaseAdmin.from('price_items').select('*').eq('is_active', true).order('category').order('name'),
    ratesFor(order.destination_country, order.weight_kg, order.shipping_service),
  ]);
  const items = unwrap(priceItems);
  const currency = invoice?.currency || currencyFor(order.destination_country);

  // Suggest the FX rate last used for this currency (admin confirms it; it is locked at issue)
  const { data: lastFx } = await supabaseAdmin.from('invoices').select('fx_rate').eq('currency', currency).neq('status', 'draft').order('issued_at', { ascending: false }).limit(1).maybeSingle();

  return ApiResponse.success(res, {
    order: { ...order, invoice: undefined, status_label: STATUS_LABELS[order.status] },
    invoice: invoice ? { ...invoice, lines: (invoice.lines || []).sort((a, b) => a.sort_order - b.sort_order) } : null,
    suggestedLines: invoice ? null : await suggestLines(order, items, shippingOptions),
    priceItems: items,
    shippingOptions,
    currency,
    suggestedFxRate: currency === 'PKR' ? 1 : lastFx?.fx_rate ?? null,
  });
});

const LINE_KINDS = ['stitching', 'accessory', 'accessory_stitching', 'shipping', 'duties', 'discount', 'other'];

const computeTotals = (lines, fxRate) => {
  const charges = lines.filter((l) => l.kind !== 'discount');
  const discounts = lines.filter((l) => l.kind === 'discount');
  const subtotal = round2(sum(charges, 'customer_amount'));
  const discount = round2(sum(discounts, 'customer_amount'));
  const total = round2(Math.max(0, subtotal - discount));
  return {
    subtotal_pkr: subtotal,
    discount_pkr: discount,
    total_pkr: total,
    partner_total_pkr: round2(sum(lines, 'partner_amount')),
    total_foreign: fxRate > 0 ? round2(total / fxRate) : 0,
  };
};

/**
 * PUT /api/admin/invoices/builder/:orderId  body: { currency, fx_rate, notes, lines: [...] }
 * Saves (or replaces) the draft invoice.
 */
export const saveInvoiceDraft = catchAsync(async (req, res) => {
  const order = await getOrderOr404(req.params.orderId);
  if (order.status !== 'packed') throw new BadRequestError(`Invoices can only be built for packed orders (this order is ${STATUS_LABELS[order.status]}).`);

  const b = req.body || {};
  const currency = String(b.currency || 'PKR').toUpperCase().slice(0, 3);
  const fxRate = currency === 'PKR' ? 1 : Number(b.fx_rate);
  if (!(fxRate > 0)) throw new BadRequestError(`Enter the exchange rate (PKR per 1 ${currency}).`);
  if (!Array.isArray(b.lines) || !b.lines.length) throw new BadRequestError('Add at least one charge.');

  const lines = b.lines.map((l, i) => {
    if (!LINE_KINDS.includes(l.kind)) throw new BadRequestError(`Line ${i + 1}: unknown charge type.`);
    if (!String(l.label || '').trim()) throw new BadRequestError(`Line ${i + 1}: description is required.`);
    const customer = Number(l.customer_amount);
    const partner = Number(l.partner_amount || 0);
    if (!(customer >= 0) || !(partner >= 0)) throw new BadRequestError(`Line ${i + 1}: amounts must be 0 or more.`);
    return {
      kind: l.kind,
      label: String(l.label).trim().slice(0, 160),
      description: l.description ? String(l.description).slice(0, 300) : null,
      unit_id: l.unit_id || null,
      price_item_id: l.price_item_id || null,
      quantity: Number(l.quantity) > 0 ? Number(l.quantity) : 1,
      customer_amount: round2(customer),
      partner_amount: l.kind === 'discount' ? 0 : round2(partner),
      sort_order: i,
    };
  });
  const totals = computeTotals(lines, fxRate);

  const existing = unwrap(await supabaseAdmin.from('invoices').select('*').eq('order_id', order.id).maybeSingle());
  if (existing && existing.status !== 'draft') throw new BadRequestError(`Invoice ${existing.number} is already ${existing.status}.`);

  const payload = { order_id: order.id, currency, fx_rate: fxRate, notes: b.notes?.trim() || null, ...totals, updated_at: new Date().toISOString() };
  const invoice = existing
    ? unwrap(await supabaseAdmin.from('invoices').update(payload).eq('id', existing.id).select('*').single())
    : unwrap(await supabaseAdmin.from('invoices').insert({ ...payload, status: 'draft', created_by: req.userId }).select('*').single());

  unwrap(await supabaseAdmin.from('invoice_lines').delete().eq('invoice_id', invoice.id));
  const saved = unwrap(await supabaseAdmin.from('invoice_lines').insert(lines.map((l) => ({ ...l, invoice_id: invoice.id }))).select('*'));
  return ApiResponse.success(res, { ...invoice, lines: saved.sort((a, b) => a.sort_order - b.sort_order) }, `Draft ${invoice.number} saved.`);
});

/**
 * POST /api/admin/invoices/:id/issue
 */
export const issueInvoice = catchAsync(async (req, res) => {
  const invoice = unwrapOne(await supabaseAdmin.from('invoices').select('*').eq('id', req.params.id).maybeSingle(), 'Invoice not found');
  if (invoice.status !== 'draft') throw new BadRequestError(`Invoice ${invoice.number} is already ${invoice.status}.`);
  if (!(Number(invoice.total_pkr) > 0)) throw new BadRequestError('The invoice total must be more than zero.');
  const order = await getOrderOr404(invoice.order_id);
  if (order.status !== 'packed') throw new BadRequestError('Only packed orders can be invoiced.');

  const now = new Date().toISOString();
  unwrap(await supabaseAdmin.from('invoices').update({ status: 'issued', issued_at: now, updated_at: now }).eq('id', invoice.id));
  await setOrderStatus(order.id, 'awaiting_payment', {
    note: `Invoice ${invoice.number} issued · ${invoice.currency} ${round2(invoice.total_foreign)} (PKR ${round2(invoice.total_pkr)})`,
    actorId: req.userId,
  });
  await notifyUser(order.customer_id, {
    type: 'invoice',
    title: `Invoice ready: ${order.reference}`,
    body: `Your order is packed. Total ${invoice.currency} ${round2(invoice.total_foreign)}. Pay to release dispatch.`,
    link: `/app/orders/${order.id}`,
    orderId: order.id,
  });
  await notifyPartner({ type: 'invoice', title: `Invoiced: ${order.reference}`, body: `Invoice ${invoice.number} issued. Awaiting customer payment.`, link: '/partner/warehouse?tab=awaiting_payment', orderId: order.id }, null, { module: 'warehouse' });
  return ApiResponse.success(res, null, `Invoice ${invoice.number} issued. The customer has been notified.`);
});

/**
 * POST /api/admin/invoices/:id/reopen — issued but unpaid invoice goes back to draft
 */
export const reopenInvoice = catchAsync(async (req, res) => {
  const invoice = unwrapOne(await supabaseAdmin.from('invoices').select('*').eq('id', req.params.id).maybeSingle(), 'Invoice not found');
  if (invoice.status !== 'issued') throw new BadRequestError('Only issued, unpaid invoices can be reopened.');
  unwrap(await supabaseAdmin.from('invoices').update({ status: 'draft', issued_at: null, updated_at: new Date().toISOString() }).eq('id', invoice.id));
  await setOrderStatus(invoice.order_id, 'packed', { note: `Invoice ${invoice.number} withdrawn for correction`, actorId: req.userId });
  return ApiResponse.success(res, null, `Invoice ${invoice.number} is a draft again.`);
});

/**
 * POST /api/admin/invoices/:id/mark-paid  body: { method: 'bank_transfer' | 'manual', reference }
 */
export const markInvoicePaid = catchAsync(async (req, res) => {
  const invoice = unwrapOne(await supabaseAdmin.from('invoices').select('*').eq('id', req.params.id).maybeSingle(), 'Invoice not found');
  if (invoice.status !== 'issued') throw new BadRequestError('Only issued invoices can be marked paid.');
  const order = await getOrderOr404(invoice.order_id);
  const now = new Date().toISOString();
  const method = ['bank_transfer', 'manual', 'card'].includes(req.body?.method) ? req.body.method : 'manual';

  unwrap(await supabaseAdmin.from('payments').insert({
    invoice_id: invoice.id, order_id: order.id, amount_pkr: invoice.total_pkr, amount_foreign: invoice.total_foreign,
    currency: invoice.currency, method, provider_ref: req.body?.reference?.trim() || null, status: 'succeeded', created_by: req.userId,
  }));
  unwrap(await supabaseAdmin.from('invoices').update({ status: 'paid', paid_at: now, updated_at: now }).eq('id', invoice.id));
  await setOrderStatus(order.id, 'paid', { note: `Payment recorded by admin (${method.replace('_', ' ')})`, actorId: req.userId, extra: { paid_at: now } });
  await notifyUser(order.customer_id, { type: 'invoice', title: `Payment confirmed: ${order.reference}`, body: `We received your payment for invoice ${invoice.number}.`, link: `/app/orders/${order.id}`, orderId: order.id });
  await notifyPartner({ type: 'invoice', title: `Paid: ${order.reference}`, body: 'Choose the dispatch route in Warehouse.', link: '/partner/warehouse?tab=paid', orderId: order.id }, null, { module: 'warehouse' });
  return ApiResponse.success(res, null, 'Payment recorded.');
});

// ─────────────────────────────── Admin warehouse ───────────────────────────────

/** Count query on shipments, limited to the admin's selected partner (through the shipment's order). */
const shipmentsOf = (req) => inActivePartner(req.access, supabaseAdmin.from('shipments').select('id, order:orders!shipments_order_id_fkey!inner(partner_id)', { count: 'exact', head: true }), 'order.partner_id');

export const getWarehouseSummary = catchAsync(async (req, res) => {
  const startToday = `${todayISO()}T00:00:00.000Z`;
  const [transfers, needsLabel, labelled, shippedToday] = await Promise.all([
    inActivePartner(req.access, supabaseAdmin.from('transfers').select('id, orders:orders!orders_transfer_id_fkey(id)').eq('status', 'in_transit')),
    shipmentsOf(req).eq('shipped_from', 'admin_warehouse').eq('status', 'needs_label'),
    shipmentsOf(req).eq('shipped_from', 'admin_warehouse').eq('status', 'labelled'),
    shipmentsOf(req).gte('handed_at', startToday),
  ]);
  const t = unwrap(transfers);
  return ApiResponse.success(res, {
    transfersInTransit: t.length,
    parcelsInTransit: t.reduce((a, x) => a + (x.orders?.length || 0), 0),
    needsLabel: needsLabel.count || 0,
    readyForCourier: labelled.count || 0,
    shippedToday: shippedToday.count || 0,
  });
});

export const getAdminTransfers = catchAsync(async (req, res) => {
  const q = parseListQuery(req, { defaultLimit: 10 });
  const status = ['open', 'in_transit', 'received'].includes(req.query.status) ? req.query.status : 'in_transit';
  let query = inActivePartner(req.access, supabaseAdmin.from('transfers')
    .select('*, orders:orders!orders_transfer_id_fkey(id, reference, customer_name, customer_code, destination_city, destination_country, weight_kg, status)', { count: 'exact' })
    .eq('status', status).order('dispatched_at', { ascending: false, nullsFirst: false }).range(q.from, q.to));
  if (q.search) query = query.ilike('code', `%${q.search}%`);
  const result = await query;
  return sendPage(res, unwrap(result), q, result.count);
});

/**
 * POST /api/admin/warehouse/transfers/:id/receive
 */
export const receiveTransfer = catchAsync(async (req, res) => {
  const transfer = unwrapOne(
    await supabaseAdmin.from('transfers').select('*, orders:orders!orders_transfer_id_fkey(id, reference, customer_id, weight_kg, shipping_service, status)').eq('id', req.params.id).maybeSingle(),
    'Transfer not found'
  );
  if (transfer.status === 'received') throw new BadRequestError(`${transfer.code} was already received.`);
  const now = new Date().toISOString();
  unwrap(await supabaseAdmin.from('transfers').update({ status: 'received', received_at: now, updated_at: now }).eq('id', transfer.id));

  for (const o of transfer.orders || []) {
    if (o.status !== 'paid') continue;
    await setOrderStatus(o.id, 'at_admin_warehouse', { note: `Received at the dispatch warehouse (${transfer.code})`, actorId: req.userId });
    unwrap(await supabaseAdmin.from('shipments').upsert({
      order_id: o.id, shipped_from: 'admin_warehouse', status: 'needs_label', weight_kg: o.weight_kg, service: o.shipping_service, updated_at: now,
    }, { onConflict: 'order_id' }));
  }
  return ApiResponse.success(res, null, `${transfer.code} received · ${transfer.orders?.length || 0} parcel(s) need a label.`);
});

const PARCEL_SELECT = `*, order:orders!shipments_order_id_fkey!inner(partner_id, id, reference, customer_id, customer_name, customer_code, destination_city, destination_country, destination_address, shipping_service, weight_kg, paid_at, status)`;

/**
 * GET /api/admin/warehouse/parcels?status=needs_label|labelled|handed_to_courier|delivered&search&page
 */
export const getParcels = catchAsync(async (req, res) => {
  const q = parseListQuery(req, { defaultLimit: 12 });
  const status = ['needs_label', 'labelled', 'handed_to_courier', 'delivered'].includes(req.query.status) ? req.query.status : 'needs_label';
  let query = inActivePartner(req.access, supabaseAdmin.from('shipments').select(PARCEL_SELECT, { count: 'exact' })
    .eq('status', status)
    .order('updated_at', { ascending: status === 'needs_label' || status === 'labelled' })
    .range(q.from, q.to), 'order.partner_id');
  if (status === 'needs_label' || status === 'labelled') query = query.eq('shipped_from', 'admin_warehouse');
  if (q.search) {
    const ids = await orderIdsMatching(q.search);
    query = query.or(ids.length ? `tracking_number.ilike.%${q.search}%,order_id.in.(${ids.join(',')})` : `tracking_number.ilike.%${q.search}%`);
  }
  const result = await query;
  return sendPage(res, unwrap(result), q, result.count);
});

export const getCourierOptions = catchAsync(async (req, res) => {
  const shipment = unwrapOne(await supabaseAdmin.from('shipments').select(PARCEL_SELECT).eq('id', req.params.id).maybeSingle(), 'Parcel not found');
  const w = shipment.weight_kg || shipment.order?.weight_kg;
  return ApiResponse.success(res, await ratesFor(shipment.order?.destination_country, w, shipment.order?.shipping_service));
});

/**
 * POST /api/admin/warehouse/parcels/:id/label  body: { shipping_rate_id?, courier_id (when no rate; from Catalogue > Couriers), tracking_number, rate_pkr?, dimensions?, weight_kg? }
 */
export const labelParcel = catchAsync(async (req, res) => {
  const shipment = unwrapOne(await supabaseAdmin.from('shipments').select(PARCEL_SELECT).eq('id', req.params.id).maybeSingle(), 'Parcel not found');
  if (!['needs_label', 'labelled'].includes(shipment.status)) throw new BadRequestError('This parcel has already left the warehouse.');
  const b = req.body || {};
  let rate = null;
  if (b.shipping_rate_id) rate = unwrapOne(await supabaseAdmin.from('shipping_rates').select('*').eq('id', b.shipping_rate_id).maybeSingle(), 'Shipping rate not found');
  // a courier of a chosen shipping rate keeps its own name; anything entered by hand must come from the courier list
  const courier = b.courier_id || !rate ? (await resolveCourier(b)).name : rate.courier;
  const tracking = String(b.tracking_number || '').trim();
  if (!courier) throw new BadRequestError('Choose a courier.');
  if (!tracking) throw new BadRequestError('Paste the tracking number from the courier label.');

  const now = new Date().toISOString();
  unwrap(await supabaseAdmin.from('shipments').update({
    status: 'labelled',
    courier,
    service: rate?.service || shipment.service,
    shipping_rate_id: rate?.id || null,
    tracking_number: tracking,
    rate_pkr: b.rate_pkr !== undefined ? round2(b.rate_pkr) : rate ? round2(rate.base_rate) : null,
    dimensions: b.dimensions?.trim() || shipment.dimensions,
    weight_kg: Number(b.weight_kg) > 0 ? Number(b.weight_kg) : shipment.weight_kg,
    label_printed_at: now,
    updated_at: now,
  }).eq('id', shipment.id));
  await addEvent(shipment.order_id, shipment.order.status, `Label created · ${courier} ${tracking}`, req.userId);
  return ApiResponse.success(res, null, 'Label saved. Hand the parcel to the courier next.');
});

export const markParcelHanded = catchAsync(async (req, res) => {
  const shipment = unwrapOne(await supabaseAdmin.from('shipments').select(PARCEL_SELECT).eq('id', req.params.id).maybeSingle(), 'Parcel not found');
  if (shipment.status !== 'labelled') throw new BadRequestError('Create the label before handing over to the courier.');
  const now = new Date().toISOString();
  unwrap(await supabaseAdmin.from('shipments').update({ status: 'handed_to_courier', handed_at: now, updated_at: now }).eq('id', shipment.id));
  await setOrderStatus(shipment.order_id, 'shipped', { note: `Shipped with ${shipment.courier} · tracking ${shipment.tracking_number}`, actorId: req.userId, extra: { shipped_at: now } });
  await notifyUser(shipment.order.customer_id, {
    type: 'logistics',
    title: `Shipped: ${shipment.order.reference}`,
    body: `Your order is on its way with ${shipment.courier}. Tracking number: ${shipment.tracking_number}.`,
    link: `/app/orders/${shipment.order_id}`,
    orderId: shipment.order_id,
  });
  return ApiResponse.success(res, null, 'Handed to courier. The customer has the tracking number.');
});

export const markParcelDelivered = catchAsync(async (req, res) => {
  const shipment = unwrapOne(await supabaseAdmin.from('shipments').select(PARCEL_SELECT).eq('id', req.params.id).maybeSingle(), 'Parcel not found');
  if (shipment.status !== 'handed_to_courier') throw new BadRequestError('Only shipped parcels can be marked delivered.');
  const now = new Date().toISOString();
  unwrap(await supabaseAdmin.from('shipments').update({ status: 'delivered', delivered_at: now, updated_at: now }).eq('id', shipment.id));
  await setOrderStatus(shipment.order_id, 'delivered', { note: 'Delivered to the customer', actorId: req.userId, extra: { delivered_at: now } });
  await notifyUser(shipment.order.customer_id, { type: 'update', title: `Delivered: ${shipment.order.reference}`, body: 'Your order was delivered. We hope you love it!', link: `/app/orders/${shipment.order_id}`, orderId: shipment.order_id });
  await notifyAdmins({ type: 'update', title: `Delivered: ${shipment.order.reference}`, body: shipment.order.customer_name, orderId: shipment.order_id }, req.userId);
  return ApiResponse.success(res, null, 'Marked as delivered.');
});
