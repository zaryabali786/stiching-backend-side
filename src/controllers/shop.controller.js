import { supabaseAdmin } from '../config/supabase.js';
import { catchAsync, ApiResponse, BadRequestError, NotFoundError } from '../utils/error.helper.js';
import { pageMeta, parseListQuery, sendPage, sanitizeSearch } from '../utils/pagination.js';
import { cartView, checkout, getProduct, listProducts, removeCartItem, retryPayment, setCartItem, shopFilters } from '../services/shop.service.js';
import { cancelShopOrder, confirmShopPayment, createBrandOrderInShopify, syncBrandOrder } from '../services/shop-orders.service.js';
import { adminBrands, adminOrder, adminOrders, adminProducts, commissionCsv, commissionReport, createSettlement, customerOrder, customerOrders, listSettlements, setDispute, setProductHidden, updateBrandSettings } from '../services/shop-views.service.js';
import { syncStoreCatalog } from '../services/shop-catalog.service.js';

const str = (v) => (v ? String(v) : undefined);

// ───────────── customer: /api/client/shop ─────────────

export const getShopFilters = catchAsync(async (req, res) => ApiResponse.success(res, await shopFilters()));

export const getShopProducts = catchAsync(async (req, res) => {
  const q = parseListQuery(req, { defaultLimit: 24, maxLimit: 60 });
  const num = (v) => (v === undefined || v === '' ? NaN : Number(v));
  const { rows, total } = await listProducts({
    search: q.search,
    brand: str(req.query.brand),
    category: str(req.query.category),
    collection: str(req.query.collection),
    sort: String(req.query.sort || 'newest'),
    min: num(req.query.min),
    max: num(req.query.max),
    inStock: req.query.in_stock === '1' || req.query.in_stock === 'true',
    from: q.from,
    to: q.to,
  });
  return sendPage(res, rows, q, total);
});

export const getShopProduct = catchAsync(async (req, res) => ApiResponse.success(res, await getProduct(req.params.id)));
export const getShopCart = catchAsync(async (req, res) => ApiResponse.success(res, await cartView(req.userId)));
export const putShopCartItem = catchAsync(async (req, res) => {
  if (!req.body?.variant_id) throw new BadRequestError('Choose a variant.');
  return ApiResponse.success(res, await setCartItem(req.userId, String(req.body.variant_id), req.body.quantity));
});
export const deleteShopCartItem = catchAsync(async (req, res) => ApiResponse.success(res, await removeCartItem(req.userId, req.params.variantId)));
export const postShopCheckout = catchAsync(async (req, res) => ApiResponse.success(res, await checkout({ customerId: req.userId, address: req.body?.address, email: req.body?.email }), 'Order placed: complete the payment.'));
export const postShopConfirmPayment = catchAsync(async (req, res) => {
  await confirmShopPayment({ customerId: req.userId, orderId: req.params.id, paymentIntentId: str(req.body?.payment_intent_id) });
  return ApiResponse.success(res, await customerOrder(req.userId, req.params.id));
});
export const postShopRetryPayment = catchAsync(async (req, res) => ApiResponse.success(res, await retryPayment({ customerId: req.userId, orderId: req.params.id })));
export const getShopOrders = catchAsync(async (req, res) => {
  const q = parseListQuery(req, { defaultLimit: 10 });
  const { rows, total } = await customerOrders(req.userId, q);
  return sendPage(res, rows, q, total);
});
export const getShopOrder = catchAsync(async (req, res) => ApiResponse.success(res, await customerOrder(req.userId, req.params.id)));

// ───────────── admin: /api/admin/shop ─────────────

export const adminShopBrands = catchAsync(async (req, res) => ApiResponse.success(res, await adminBrands()));
export const adminPatchBrand = catchAsync(async (req, res) => ApiResponse.success(res, await updateBrandSettings(req.params.storeId, req.body || {}), 'Saved.'));
export const adminSyncBrand = catchAsync(async (req, res) => {
  const { data: store } = await supabaseAdmin.from('shopify_stores').select('*').eq('id', req.params.storeId).eq('status', 'active').maybeSingle();
  if (!store) throw new NotFoundError('That store is not connected.');
  return ApiResponse.success(res, await syncStoreCatalog(store), 'Sync finished.');
});
export const adminShopProducts = catchAsync(async (req, res) => {
  const q = parseListQuery(req, { defaultLimit: 25 });
  const { rows, total } = await adminProducts({ search: q.search, store: str(req.query.store), availability: String(req.query.availability || ''), visibility: String(req.query.visibility || ''), from: q.from, to: q.to });
  return sendPage(res, rows, q, total);
});
export const adminPatchProduct = catchAsync(async (req, res) => ApiResponse.success(res, await setProductHidden(req.params.id, req.body?.hidden), 'Saved.'));
export const adminShopOrders = catchAsync(async (req, res) => {
  const q = parseListQuery(req, { defaultLimit: 20 });
  const { rows, total } = await adminOrders({ search: q.search, status: str(req.query.status), brand: str(req.query.brand), fromDate: str(req.query.from), toDate: str(req.query.to), from: q.from, to: q.to });
  return sendPage(res, rows, q, total);
});
export const adminShopOrder = catchAsync(async (req, res) => ApiResponse.success(res, await adminOrder(req.params.id)));

const brandOrderOut = async (id) => {
  const { data } = await supabaseAdmin.from('shop_brand_orders').select('shop_order_id').eq('id', id).single();
  return (await adminOrder(data.shop_order_id)).brand_orders.find((b) => b.id === id);
};
export const adminRetryBrandOrder = catchAsync(async (req, res) => {
  await createBrandOrderInShopify(req.params.id, { manual: true });
  return ApiResponse.success(res, await brandOrderOut(req.params.id), 'Tried again.');
});
export const adminSyncBrandOrder = catchAsync(async (req, res) => {
  await syncBrandOrder(req.params.id);
  return ApiResponse.success(res, await brandOrderOut(req.params.id), 'Synced with Shopify.');
});
export const adminCancelOrder = catchAsync(async (req, res) => {
  const result = await cancelShopOrder({ orderId: req.params.id, reason: sanitizeSearch(req.body?.reason) });
  return ApiResponse.success(res, { ...(await adminOrder(req.params.id)), ...result }, result.cancelled ? 'Order cancelled.' : 'Some brand orders could not be cancelled.');
});

const commissionFilters = (req) => ({ store: str(req.query.store), status: str(req.query.status), from: str(req.query.from), to: str(req.query.to) });
export const adminCommissions = catchAsync(async (req, res) => {
  const q = parseListQuery(req, { defaultLimit: 25 });
  const r = await commissionReport({ ...commissionFilters(req), page: q.page, limit: q.limit });
  return ApiResponse.success(res, { summary: r.summary, rows: r.rows }, 'Success', 200, pageMeta(q, r.total));
});
export const adminCommissionCsv = catchAsync(async (req, res) => {
  const csv = await commissionCsv(commissionFilters(req));
  res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="commission-${new Date().toISOString().slice(0, 10)}.csv"` });
  return res.send(csv);
});
export const adminDispute = catchAsync(async (req, res) => ApiResponse.success(res, await setDispute({ brandOrderId: String(req.body?.brand_order_id || ''), disputed: req.body?.disputed !== false, note: req.body?.note }), 'Saved.'));
export const adminCreateSettlement = catchAsync(async (req, res) => ApiResponse.success(res, await createSettlement({ storeId: String(req.body?.store_id || ''), brandOrderIds: req.body?.brand_order_ids, reference: req.body?.reference, note: req.body?.note, adminId: req.userId }), 'Settlement recorded.'));
export const adminSettlements = catchAsync(async (req, res) => {
  const q = parseListQuery(req, { defaultLimit: 25 });
  const { rows, total } = await listSettlements({ store: str(req.query.store), from: q.from, to: q.to });
  return sendPage(res, rows, q, total);
});
