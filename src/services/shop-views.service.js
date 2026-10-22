import { supabaseAdmin } from '../config/supabase.js';
import { BadRequestError, ConflictError, NotFoundError } from '../utils/error.helper.js';
import { round2 } from './shop.service.js';
import { statusLabel } from './shop-orders.service.js';

/** What the customer and the administrator SEE of Shop orders, products, brands and commission. Customers never get commission or Shopify ids. */

const gidTail = (v) => String(v || '').split('/').pop();
const brandName = (store) => store?.brand?.name || String(store?.shop_domain || '').replace(/\.myshopify\.com$/, '');
const shopifyUrl = (store, id) => (store?.shop_domain && id ? `https://admin.shopify.com/store/${String(store.shop_domain).replace(/\.myshopify\.com$/, '')}/orders/${gidTail(id)}` : null);
const BRAND_ORDER_LABELS = { pending: 'Waiting to be placed', creating: 'Being placed', created: 'Placed with the brand', failed: 'Needs attention', cancelled: 'Cancelled' };
const brandOrderLabel = (b) => {
  if (b.state === 'created') {
    if (b.fulfillment_status === 'delivered') return 'Delivered';
    if (b.fulfillment_status === 'dispatched') return 'Dispatched';
    if (b.fulfillment_status === 'partial') return 'Partly dispatched';
    return 'Confirmed by the brand';
  }
  return BRAND_ORDER_LABELS[b.state] || b.state;
};

const BO_SELECT = '*, store:shopify_stores(id, shop_domain, brand:brands(name))';
const itemOut = (i) => ({ title: i.title, variant_title: i.variant_title && i.variant_title !== 'Default Title' ? i.variant_title : null, sku: i.sku, quantity: i.quantity, unit_price: Number(i.unit_price), line_total: Number(i.line_total), image_url: i.image_url });

const loadDetail = async (order) => {
  const [{ data: bos }, { data: items }, { data: events }] = await Promise.all([
    supabaseAdmin.from('shop_brand_orders').select(BO_SELECT).eq('shop_order_id', order.id).order('created_at'),
    supabaseAdmin.from('shop_order_items').select('*').eq('shop_order_id', order.id).order('title'),
    supabaseAdmin.from('shop_order_events').select('created_at, text').eq('shop_order_id', order.id).order('created_at'),
  ]);
  return { bos: bos || [], items: items || [], events: events || [] };
};

const parentOut = (o, bos) => ({
  id: o.id,
  reference: o.reference,
  status: o.status,
  status_label: statusLabel(o.status),
  payment_status: o.payment_status,
  total: Number(o.total),
  subtotal: Number(o.subtotal),
  shipping_total: Number(o.shipping_total),
  tax_total: Number(o.tax_total),
  discount_total: Number(o.discount_total),
  currency: o.currency,
  created_at: o.created_at,
  delivery_verified: bos.length > 0 && bos.filter((b) => b.state !== 'cancelled').every((b) => b.delivery_verified),
});

// ───────────── customer ─────────────

export const customerOrders = async (customerId, { from, to }) => {
  const { data, count, error } = await supabaseAdmin.from('shop_orders').select('*', { count: 'exact' }).eq('customer_id', customerId).order('created_at', { ascending: false }).range(from, to);
  if (error) throw error;
  const ids = (data || []).map((o) => o.id);
  const { data: bos } = ids.length ? await supabaseAdmin.from('shop_brand_orders').select(BO_SELECT).in('shop_order_id', ids) : { data: [] };
  const { data: items } = ids.length ? await supabaseAdmin.from('shop_order_items').select('shop_order_id, quantity').in('shop_order_id', ids) : { data: [] };
  const rows = (data || []).map((o) => {
    const mine = (bos || []).filter((b) => b.shop_order_id === o.id);
    return { ...parentOut(o, mine), items_count: (items || []).filter((i) => i.shop_order_id === o.id).reduce((a, i) => a + i.quantity, 0), brands: [...new Set(mine.map((b) => brandName(b.store)))] };
  });
  return { rows, total: count || 0 };
};

const CUSTOMER_HIDDEN = /stripe|administrator|brand's store|could not|refund the customer/i;

export const customerOrder = async (customerId, id) => {
  const { data: order } = await supabaseAdmin.from('shop_orders').select('*').eq('id', id).eq('customer_id', customerId).maybeSingle();
  if (!order) throw new NotFoundError('Order not found.');
  const { bos, items, events } = await loadDetail(order);
  return {
    ...parentOut(order, bos),
    address: order.address,
    items: items.map(itemOut),
    brand_orders: bos.map((b) => ({
      id: b.id,
      brand: { id: b.store_id, name: brandName(b.store) },
      state: b.state === 'failed' ? 'pending' : b.state, // a failure is ours to fix, not the customer's worry
      status_label: b.state === 'failed' ? 'Being placed' : brandOrderLabel(b),
      fulfillment_status: b.fulfillment_status,
      delivery_verified: !!b.delivery_verified,
      tracking: b.tracking || [],
      items: items.filter((i) => i.brand_order_id === b.id).map(itemOut),
      subtotal: Number(b.subtotal),
      shipping: Number(b.shipping),
      total: Number(b.total),
    })),
    timeline: events.filter((e) => !CUSTOMER_HIDDEN.test(e.text)).map((e) => ({ at: e.created_at, text: e.text })),
  };
};

// ───────────── admin: brands ─────────────

export const adminBrands = async () => {
  const { data: stores } = await supabaseAdmin.from('shopify_stores').select('id, shop_domain, status, scopes, settings, brand:brands(name)').order('created_at');
  const ids = (stores || []).map((s) => s.id);
  const [{ data: settings }, { data: products }, { data: bos }] = await Promise.all([
    supabaseAdmin.from('shop_brand_settings').select('*').in('store_id', ids.length ? ids : ['00000000-0000-0000-0000-000000000000']),
    supabaseAdmin.from('shop_products').select('store_id, hidden, sellable').in('store_id', ids.length ? ids : ['00000000-0000-0000-0000-000000000000']).limit(20000),
    supabaseAdmin.from('shop_brand_orders').select('store_id, state, last_error, updated_at').in('store_id', ids.length ? ids : ['00000000-0000-0000-0000-000000000000']),
  ]);
  return (stores || []).map((s) => {
    const st = (settings || []).find((x) => x.store_id === s.id) || {};
    const mine = (products || []).filter((p) => p.store_id === s.id && p.sellable);
    const orders = (bos || []).filter((b) => b.store_id === s.id);
    const failed = orders.filter((b) => b.state === 'failed');
    const scopes = String(s.scopes || '').split(',').map((x) => x.trim());
    // a write permission includes the matching read permission
    const has = (n) => scopes.includes(n) || scopes.includes(n.replace(/^read_/, 'write_'));
    const inventoryOk = has('read_inventory') || st.inventory_known === true;
    const missing = [...['read_products', 'write_orders'].filter((n) => !has(n)), ...(inventoryOk ? [] : ['read_inventory'])];
    return {
      store_id: s.id,
      brand_name: brandName(s),
      shop_domain: s.shop_domain,
      status: s.status,
      approved: !!st.approved,
      commission_model: st.commission_model || 'percent',
      commission_rate: Number(st.commission_rate || 0),
      commission_fixed: Number(st.commission_fixed || 0),
      shipping_flat: Number(st.shipping_flat || 0),
      currency: st.currency || null,
      catalog: { status: st.catalog_status || 'never', synced_at: st.catalog_synced_at || null, error: st.catalog_error || null, products: mine.length, hidden: mine.filter((p) => p.hidden).length },
      orders: { status: failed.length ? 'attention' : orders.length ? 'ok' : 'never', failed: failed.length, last_error: failed.sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)))[0]?.last_error || null },
      permissions: { products: has('read_products'), orders: has('write_orders'), inventory: inventoryOk, missing },
    };
  });
};

export const updateBrandSettings = async (storeId, body) => {
  const patch = {};
  if (body.approved !== undefined) patch.approved = !!body.approved;
  if (body.commission_model !== undefined) {
    if (!['percent', 'fixed'].includes(body.commission_model)) throw new BadRequestError('Commission model must be percent or fixed.');
    patch.commission_model = body.commission_model;
  }
  const num = (v, label, max) => {
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0 || n > max) throw new BadRequestError(`${label} is not valid.`);
    return n;
  };
  if (body.commission_rate !== undefined) patch.commission_rate = num(body.commission_rate, 'Commission rate', 100);
  if (body.commission_fixed !== undefined) patch.commission_fixed = num(body.commission_fixed, 'Fixed commission', 1_000_000);
  if (body.shipping_flat !== undefined) patch.shipping_flat = num(body.shipping_flat, 'Shipping charge', 1_000_000);
  const { data: store } = await supabaseAdmin.from('shopify_stores').select('id').eq('id', storeId).maybeSingle();
  if (!store) throw new NotFoundError('Store not found.');
  await supabaseAdmin.from('shop_brand_settings').upsert({ store_id: storeId, ...patch, updated_at: new Date().toISOString() }, { onConflict: 'store_id' });
  return (await adminBrands()).find((b) => b.store_id === storeId);
};

// ───────────── admin: products ─────────────

export const adminProducts = async ({ search, store, availability, visibility, from, to }) => {
  let q = supabaseAdmin.from('shop_products').select('*, store:shopify_stores(id, shop_domain, brand:brands(name))', { count: 'exact' }).order('title').order('id').range(from, to);
  if (store) q = q.eq('store_id', store);
  if (search) q = q.ilike('title', `%${search.replace(/[%,]/g, ' ')}%`);
  if (availability === 'in_stock') q = q.eq('in_stock', true);
  if (availability === 'out') q = q.eq('in_stock', false);
  if (visibility === 'hidden') q = q.eq('hidden', true);
  if (visibility === 'visible') q = q.eq('hidden', false).eq('sellable', true);
  const { data, count, error } = await q;
  if (error) throw error;
  const ids = (data || []).map((p) => p.id);
  const { data: vs } = ids.length ? await supabaseAdmin.from('shop_variants').select('product_id').in('product_id', ids) : { data: [] };
  const rows = (data || []).map((p) => ({
    id: p.id,
    title: p.title,
    brand: { id: p.store_id, name: brandName(p.store) },
    image_url: p.image_url,
    price_min: p.price_min === null ? null : Number(p.price_min),
    price_max: p.price_max === null ? null : Number(p.price_max),
    currency: p.currency,
    in_stock: !!p.in_stock,
    variants_count: (vs || []).filter((v) => v.product_id === p.id).length,
    hidden: !!p.hidden,
    shopify_status: p.sellable ? p.shopify_status : `${p.shopify_status || 'removed'} (not for sale)`,
    synced_at: p.synced_at,
  }));
  return { rows, total: count || 0 };
};

export const setProductHidden = async (id, hidden) => {
  const { data, error } = await supabaseAdmin.from('shop_products').update({ hidden: !!hidden }).eq('id', id).select('id, hidden').maybeSingle();
  if (error) throw error;
  if (!data) throw new NotFoundError('Product not found.');
  return data;
};

// ───────────── admin: orders ─────────────

export const adminOrders = async ({ search, status, brand, fromDate, toDate, from, to }) => {
  let ids = null;
  const intersect = (list) => {
    ids = ids === null ? new Set(list) : new Set(list.filter((x) => ids.has(x)));
  };
  if (brand) intersect(((await supabaseAdmin.from('shop_brand_orders').select('shop_order_id').eq('store_id', brand)).data || []).map((r) => r.shop_order_id));
  if (search) {
    const s = search.replace(/[%,]/g, ' ').trim();
    const found = new Set();
    for (const r of (await supabaseAdmin.from('shop_orders').select('id').ilike('reference', `%${s}%`)).data || []) found.add(r.id);
    for (const r of (await supabaseAdmin.from('shop_brand_orders').select('shop_order_id').ilike('shopify_order_name', `%${s.replace(/^#/, '')}%`)).data || []) found.add(r.shop_order_id);
    const { data: people } = await supabaseAdmin.from('profiles').select('id').or(`full_name.ilike.%${s}%,email.ilike.%${s}%`).limit(200);
    if (people?.length) for (const r of (await supabaseAdmin.from('shop_orders').select('id').in('customer_id', people.map((p) => p.id))).data || []) found.add(r.id);
    const { data: brandStores } = await supabaseAdmin.from('shopify_stores').select('id, brand:brands(name)').or(`shop_domain.ilike.%${s}%`);
    const { data: namedBrands } = await supabaseAdmin.from('brands').select('id').ilike('name', `%${s}%`);
    const storeIds = new Set((brandStores || []).map((b) => b.id));
    if (namedBrands?.length) for (const r of (await supabaseAdmin.from('shopify_stores').select('id').in('brand_id', namedBrands.map((b) => b.id))).data || []) storeIds.add(r.id);
    if (storeIds.size) for (const r of (await supabaseAdmin.from('shop_brand_orders').select('shop_order_id').in('store_id', [...storeIds])).data || []) found.add(r.shop_order_id);
    intersect([...found]);
  }
  if (ids && !ids.size) return { rows: [], total: 0 };
  let q = supabaseAdmin.from('shop_orders').select('*, customer:profiles(full_name, email)', { count: 'exact' }).order('created_at', { ascending: false }).range(from, to);
  if (ids) q = q.in('id', [...ids]);
  if (status) q = q.eq('status', status);
  if (fromDate) q = q.gte('created_at', fromDate);
  if (toDate) q = q.lte('created_at', `${toDate}T23:59:59.999Z`);
  const { data, count, error } = await q;
  if (error) throw error;
  const orderIds = (data || []).map((o) => o.id);
  const { data: bos } = orderIds.length ? await supabaseAdmin.from('shop_brand_orders').select(BO_SELECT).in('shop_order_id', orderIds) : { data: [] };
  return {
    rows: (data || []).map((o) => {
      const mine = (bos || []).filter((b) => b.shop_order_id === o.id);
      return { ...parentOut(o, mine), customer: { name: o.customer?.full_name || '', email: o.customer?.email || o.email || '' }, brands: [...new Set(mine.map((b) => brandName(b.store)))], brand_orders_count: mine.length };
    }),
    total: count || 0,
  };
};

export const adminOrder = async (id) => {
  const { data: order } = await supabaseAdmin.from('shop_orders').select('*, customer:profiles(full_name, email)').eq('id', id).maybeSingle();
  if (!order) throw new NotFoundError('Order not found.');
  const { bos, items, events } = await loadDetail(order);
  const { data: payments } = await supabaseAdmin.from('shop_payments').select('*').eq('shop_order_id', id).order('created_at', { ascending: false });
  const paid = (payments || []).find((p) => p.status === 'succeeded');
  return {
    ...parentOut(order, bos),
    customer: { name: order.customer?.full_name || '', email: order.customer?.email || order.email || '' },
    address: order.address,
    items: items.map((i) => ({ ...itemOut(i), brand_order_id: i.brand_order_id })),
    brand_orders: bos.map((b) => ({
      id: b.id,
      brand: { id: b.store_id, name: brandName(b.store) },
      shop_domain: b.store?.shop_domain,
      state: b.state,
      status_label: brandOrderLabel(b),
      last_error: b.last_error,
      shopify_order_id: b.shopify_order_id,
      shopify_order_name: b.shopify_order_name,
      shopify_order_url: shopifyUrl(b.store, b.shopify_order_id),
      financial_status: b.financial_status,
      fulfillment_status: b.fulfillment_status,
      delivery_verified: !!b.delivery_verified,
      tracking: b.tracking || [],
      subtotal: Number(b.subtotal),
      shipping: Number(b.shipping),
      total: Number(b.total),
      commission_model: b.commission_model,
      commission_rate: Number(b.commission_rate),
      commission_fixed: Number(b.commission_fixed),
      commission_amount: Number(b.commission_amount),
      brand_payable: Number(b.brand_payable),
      commission_status: b.commission_status,
      refunded_amount: Number(b.refunded_amount),
      settled_at: b.settled_at,
      items: items.filter((i) => i.brand_order_id === b.id).map(itemOut),
    })),
    payment: { status: order.payment_status, intent_id: order.payment_intent_id, paid_at: order.paid_at, refunded_amount: Number(order.refunded_total || 0), attempts: (payments || []).length, last_failure: (payments || []).find((p) => p.failure_message)?.failure_message || null, succeeded_ref: paid?.provider_ref || null },
    timeline: events.map((e) => ({ at: e.created_at, text: e.text })),
  };
};

// ───────────── admin: commission & reconciliation ─────────────

const COMMISSION_SELECT = '*, order:shop_orders!inner(reference, currency, payment_status, created_at), store:shopify_stores(id, shop_domain, brand:brands(name))';

const commissionQuery = ({ store, status, from, to }) => {
  let q = supabaseAdmin.from('shop_brand_orders').select(COMMISSION_SELECT, { count: 'exact' }).order('created_at', { ascending: false });
  if (store) q = q.eq('store_id', store);
  if (status) q = q.eq('commission_status', status);
  if (from) q = q.gte('created_at', from);
  if (to) q = q.lte('created_at', `${to}T23:59:59.999Z`);
  return q;
};

const rowOut = (b) => ({
  id: b.id,
  store_id: b.store_id,
  order_reference: b.order?.reference,
  shopify_order_name: b.shopify_order_name,
  brand: brandName(b.store),
  created_at: b.created_at,
  currency: b.order?.currency,
  gross: Number(b.total),
  subtotal: Number(b.subtotal),
  shipping: Number(b.shipping),
  rate_text: b.commission_model === 'fixed' ? `${Number(b.commission_fixed).toFixed(2)} fixed` : `${Number(b.commission_rate)}%`,
  commission_amount: Number(b.commission_amount),
  brand_payable: Number(b.brand_payable),
  commission_status: b.commission_status,
  dispute_note: b.dispute_note,
  refunded_amount: Number(b.refunded_amount),
  settlement_id: b.settlement_id || null,
  payment_status: b.order?.payment_status,
  state: b.state,
});

export const commissionReport = async ({ store, status, from, to, page, limit }) => {
  // summary over everything that matches (not only the page): commission is only ever "settled" when a settlement was recorded
  const all = await commissionQuery({ store, status, from, to }).limit(20000);
  if (all.error) throw all.error;
  const rowsAll = (all.data || []).map(rowOut);
  const counted = rowsAll.filter((r) => r.state !== 'cancelled' && r.payment_status === 'paid');
  const sum = (arr, k) => round2(arr.reduce((a, r) => a + Number(r[k] || 0), 0));
  const by = (s) => rowsAll.filter((r) => r.commission_status === s);
  const currencies = new Set(rowsAll.map((r) => r.currency).filter(Boolean));
  const summary = {
    gross: sum(counted, 'gross'),
    brand_subtotal: sum(counted, 'subtotal'),
    shipping: sum(counted, 'shipping'),
    refunds: sum(rowsAll, 'refunded_amount'),
    commission_estimated: sum(by('estimated'), 'commission_amount'),
    commission_pending: sum(by('pending'), 'commission_amount'),
    commission_settled: sum(by('settled'), 'commission_amount'),
    commission_reversed: sum(by('reversed'), 'commission_amount'),
    commission_disputed: sum(by('disputed'), 'commission_amount'),
    brand_payable_pending: sum(by('pending'), 'brand_payable'),
    currency: currencies.size === 1 ? [...currencies][0] : null,
    mixed_currencies: currencies.size > 1,
  };
  const start = (page - 1) * limit;
  return { summary, rows: rowsAll.slice(start, start + limit), total: rowsAll.length };
};

export const commissionCsv = async (filters) => {
  const { data, error } = await commissionQuery(filters).limit(20000);
  if (error) throw error;
  const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const head = ['Order', 'Brand order', 'Brand', 'Date', 'Currency', 'Gross', 'Items subtotal', 'Shipping', 'Commission terms', 'Commission', 'Brand payable', 'Refunded', 'Commission status', 'Settlement'];
  const lines = (data || []).map(rowOut).map((r) => [r.order_reference, r.shopify_order_name || '', r.brand, String(r.created_at).slice(0, 10), r.currency, r.gross.toFixed(2), r.subtotal.toFixed(2), r.shipping.toFixed(2), r.rate_text, r.commission_amount.toFixed(2), r.brand_payable.toFixed(2), r.refunded_amount.toFixed(2), r.commission_status, r.settlement_id || ''].map(esc).join(','));
  return [head.map(esc).join(','), ...lines].join('\r\n');
};

export const setDispute = async ({ brandOrderId, disputed, note }) => {
  const { data: bo } = await supabaseAdmin.from('shop_brand_orders').select('*').eq('id', brandOrderId).maybeSingle();
  if (!bo) throw new NotFoundError('Brand order not found.');
  if (disputed) {
    if (!['pending', 'settled', 'estimated'].includes(bo.commission_status)) throw new ConflictError('Only an open or settled commission can be disputed.');
    await supabaseAdmin.from('shop_brand_orders').update({ commission_status: 'disputed', dispute_note: String(note || '').slice(0, 500) || null, updated_at: new Date().toISOString() }).eq('id', bo.id);
  } else {
    if (bo.commission_status !== 'disputed') throw new ConflictError('This commission is not disputed.');
    const back = bo.settlement_id ? 'settled' : bo.state === 'created' ? 'pending' : 'estimated';
    await supabaseAdmin.from('shop_brand_orders').update({ commission_status: back, dispute_note: null, updated_at: new Date().toISOString() }).eq('id', bo.id);
  }
  return rowOut((await supabaseAdmin.from('shop_brand_orders').select(COMMISSION_SELECT).eq('id', bo.id).single()).data);
};

/** Records that the platform paid a brand for these brand orders. Only PENDING ones (paid, placed, not yet settled) can be settled, once. */
export const createSettlement = async ({ storeId, brandOrderIds, reference, note, adminId }) => {
  if (!reference || !String(reference).trim()) throw new BadRequestError('Enter the payment reference of this settlement.');
  if (!Array.isArray(brandOrderIds) || !brandOrderIds.length) throw new BadRequestError('Choose the orders to settle.');
  const { data: rows } = await supabaseAdmin.from('shop_brand_orders').select('id, brand_payable, commission_status, store_id, order:shop_orders(currency)').in('id', brandOrderIds).eq('store_id', storeId).eq('commission_status', 'pending').is('settlement_id', null);
  if (!rows?.length) throw new ConflictError('None of these orders can be settled (they are not pending, belong to another brand, or are already settled).');
  const currencies = new Set(rows.map((r) => r.order?.currency));
  if (currencies.size > 1) throw new BadRequestError('A settlement can only cover one currency.');
  const ins = await supabaseAdmin.from('shop_settlements').insert({ store_id: storeId, amount: 0, currency: [...currencies][0], reference: String(reference).trim(), note: note || null, created_by: adminId || null }).select('*').single();
  if (ins.error) throw ins.error;
  const upd = await supabaseAdmin.from('shop_brand_orders').update({ commission_status: 'settled', settlement_id: ins.data.id, settled_at: new Date().toISOString(), updated_at: new Date().toISOString() }).in('id', rows.map((r) => r.id)).eq('commission_status', 'pending').is('settlement_id', null).select('id, brand_payable');
  if (upd.error || !upd.data?.length) {
    await supabaseAdmin.from('shop_settlements').delete().eq('id', ins.data.id);
    throw new ConflictError('Those orders were settled in the meantime.');
  }
  const amount = round2(upd.data.reduce((a, r) => a + Number(r.brand_payable), 0));
  await supabaseAdmin.from('shop_settlements').update({ amount }).eq('id', ins.data.id);
  return { ...ins.data, amount, orders_count: upd.data.length };
};

export const listSettlements = async ({ store, from, to }) => {
  let q = supabaseAdmin.from('shop_settlements').select('*, store:shopify_stores(id, shop_domain, brand:brands(name))', { count: 'exact' }).order('settled_at', { ascending: false }).range(from, to);
  if (store) q = q.eq('store_id', store);
  const { data, count, error } = await q;
  if (error) throw error;
  const ids = (data || []).map((s) => s.id);
  const { data: counts } = ids.length ? await supabaseAdmin.from('shop_brand_orders').select('settlement_id').in('settlement_id', ids) : { data: [] };
  return {
    rows: (data || []).map((s) => ({ id: s.id, brand: brandName(s.store), amount: Number(s.amount), currency: s.currency, reference: s.reference, note: s.note, settled_at: s.settled_at, orders_count: (counts || []).filter((c) => c.settlement_id === s.id).length })),
    total: count || 0,
  };
};
