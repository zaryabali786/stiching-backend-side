import { supabaseAdmin } from '../config/supabase.js';
import { catchAsync, ApiResponse, BadRequestError, ConflictError, NotFoundError } from '../utils/error.helper.js';
import { parseListQuery, sendPage } from '../utils/pagination.js';
import { unwrap, unwrapOne, round2 } from '../utils/db.js';
import { uploadCatalogueImage, removeStoredFile } from '../services/storage.service.js';

/**
 * Catalogues managed from the partner portal and consumed by the customer order form:
 *   brands · couriers · article types (neckline, sleeves, trouser, collar, ...) · articles
 * Partner/admin routes (/partner/...) see everything incl. prices; customer routes (/client/...) only
 * get active rows with no price. Every list is searchable and paginated on the server.
 */

const STATUSES = ['active', 'inactive'];

const cleanName = (value, label, max) => {
  const name = String(value ?? '').replace(/\s+/g, ' ').trim();
  if (!name) throw new BadRequestError(`${label} name is required.`);
  if (name.length > max) throw new BadRequestError(`${label} name must be ${max} characters or fewer.`);
  return name;
};

const cleanStatus = (value, fallback) => {
  if (value === undefined || value === null || value === '') return fallback;
  if (!STATUSES.includes(value)) throw new BadRequestError('Status must be "active" or "inactive".');
  return value;
};

const cleanSortOrder = (value, fallback) => {
  if (value === undefined || value === null || value === '') return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < -100000 || n > 100000) throw new BadRequestError('Sort order must be a whole number.');
  return n;
};

const cleanPrice = (value) => {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0 || n >= 100_000_000) throw new BadRequestError('Price must be a number of 0 or more (or empty).');
  return round2(n);
};

const asBool = (value, fallback) => (value === undefined || value === null ? fallback : value === true || value === 'true');

/** Case-insensitive exact-name lookup (the unique index is on lower(btrim(name))). */
const findByName = async (table, name, scope = {}) => {
  let q = supabaseAdmin.from(table).select('id, name, status').ilike('name', name.replace(/[%_\\]/g, (c) => `\\${c}`));
  for (const [k, v] of Object.entries(scope)) q = q.eq(k, v);
  const { data } = await q.limit(5);
  return (data || []).find((r) => r.name.trim().toLowerCase() === name.toLowerCase()) || null;
};

/** ?status=active|inactive|all (default all) */
const statusFilter = (req, query, fallback = 'all') => {
  const status = req.query.status || fallback;
  return STATUSES.includes(status) ? query.eq('status', status) : query;
};

const searchFilter = (query, search, column = 'name') => (search ? query.ilike(column, `%${search}%`) : query);

// ═════════════════════════════ Brands & couriers (same shape) ═════════════════════════════

const namedCatalogue = ({ table, label, orderColumn, nameMax = 80, extra }) => {
  const columns = `id, name, status, created_at, updated_at${extra ? `, ${extra.column}` : ''}`;

  const list = catchAsync(async (req, res) => {
    const q = parseListQuery(req, { defaultLimit: 20, sortable: ['name', 'created_at', 'status'], defaultSort: 'name', defaultDir: 'asc' });
    let query = supabaseAdmin.from(table).select(columns, { count: 'exact' }).order(q.sort, { ascending: q.ascending }).range(q.from, q.to);
    query = searchFilter(statusFilter(req, query), q.search);
    const result = await query;
    return sendPage(res, unwrap(result, `Could not load ${label}s`), q, result.count);
  });

  const create = catchAsync(async (req, res) => {
    const name = cleanName(req.body?.name, label, nameMax);
    if (await findByName(table, name)) throw new ConflictError(`${label} "${name}" already exists.`);
    const row = {
      name,
      status: cleanStatus(req.body?.status, 'active'),
      created_by: req.userId,
      ...(extra ? { [extra.column]: asBool(req.body?.[extra.column], extra.default) } : {}),
    };
    const created = unwrap(await supabaseAdmin.from(table).insert(row).select(columns).single(), `Could not create ${label.toLowerCase()}`);
    return ApiResponse.created(res, created, `${label} added.`);
  });

  const update = catchAsync(async (req, res) => {
    const current = unwrapOne(await supabaseAdmin.from(table).select('id, name').eq('id', req.params.id).maybeSingle(), `${label} not found`);
    const patch = {};
    if (req.body?.name !== undefined) {
      patch.name = cleanName(req.body.name, label, nameMax);
      const dupe = await findByName(table, patch.name);
      if (dupe && dupe.id !== current.id) throw new ConflictError(`${label} "${patch.name}" already exists.`);
    }
    if (req.body?.status !== undefined) patch.status = cleanStatus(req.body.status);
    if (extra && req.body?.[extra.column] !== undefined) patch[extra.column] = asBool(req.body[extra.column], extra.default);
    if (!Object.keys(patch).length) throw new BadRequestError('Nothing to update.');

    const updated = unwrap(await supabaseAdmin.from(table).update(patch).eq('id', current.id).select(columns).single(), `Could not update ${label.toLowerCase()}`);
    // orders keep the brand name for lists and search; follow a rename
    if (table === 'brands' && patch.name && patch.name !== current.name) {
      await supabaseAdmin.from('orders').update({ brand: patch.name }).eq('brand_id', current.id);
    }
    return ApiResponse.success(res, updated, `${label} updated.`);
  });

  const remove = catchAsync(async (req, res) => {
    const current = unwrapOne(await supabaseAdmin.from(table).select('id, name').eq('id', req.params.id).maybeSingle(), `${label} not found`);
    const { count } = await supabaseAdmin.from('orders').select('id', { count: 'exact', head: true }).eq(orderColumn, current.id);
    if (count) {
      // keep the history: used rows are switched off instead of removed
      unwrap(await supabaseAdmin.from(table).update({ status: 'inactive' }).eq('id', current.id));
      return ApiResponse.success(res, { id: current.id, deleted: false, deactivated: true }, `${label} "${current.name}" is used by ${count} order${count === 1 ? '' : 's'}, so it was deactivated instead of deleted.`);
    }
    unwrap(await supabaseAdmin.from(table).delete().eq('id', current.id));
    return ApiResponse.success(res, { id: current.id, deleted: true, deactivated: false }, `${label} deleted.`);
  });

  /** Customer lookup: active rows only, id + name. */
  const lookup = catchAsync(async (req, res) => {
    const q = parseListQuery(req, { defaultLimit: 20, maxLimit: 50, sortable: ['name'], defaultSort: 'name', defaultDir: 'asc' });
    let query = supabaseAdmin
      .from(table)
      .select(`id, name${extra ? `, ${extra.column}` : ''}`, { count: 'exact' })
      .eq('status', 'active')
      .order('name', { ascending: true })
      .range(q.from, q.to);
    query = searchFilter(query, q.search);
    const result = await query;
    return sendPage(res, unwrap(result, `Could not load ${label.toLowerCase()}s`), q, result.count);
  });

  return { list, create, update, remove, lookup };
};

const brands = namedCatalogue({ table: 'brands', label: 'Brand', orderColumn: 'brand_id' });
const couriers = namedCatalogue({ table: 'couriers', label: 'Courier', orderColumn: 'courier_id', extra: { column: 'requires_tracking', default: true } });

export const listBrands = brands.list;
export const createBrand = brands.create;
export const updateBrand = brands.update;
export const deleteBrand = brands.remove;
export const lookupBrands = brands.lookup;
export const listCouriers = couriers.list;
export const createCourier = couriers.create;
export const updateCourier = couriers.update;
export const deleteCourier = couriers.remove;
export const lookupCouriers = couriers.lookup;

/**
 * POST /api/client/brands { name } — "Other / add new brand" on the order form.
 * Returns the existing brand when the name is already there (any case), re-activating nothing.
 */
export const addBrandAsCustomer = catchAsync(async (req, res) => {
  const name = cleanName(req.body?.name, 'Brand', 80);
  const existing = await findByName('brands', name);
  if (existing) {
    if (existing.status !== 'active') throw new ConflictError(`"${existing.name}" is not available right now. Pick another brand or contact us.`);
    return ApiResponse.success(res, { id: existing.id, name: existing.name }, 'Brand selected.');
  }
  const created = unwrap(await supabaseAdmin.from('brands').insert({ name, status: 'active', created_by: req.userId }).select('id, name').single(), 'Could not add the brand');
  return ApiResponse.created(res, created, `Brand "${created.name}" added.`);
});

// ═════════════════════════════ Article types ═════════════════════════════

const TYPE_COLUMNS = 'id, name, status, sort_order, created_at, updated_at';

/** GET /api/partner/article-types?search&status&page&limit — each row has `articles_count` */
export const listArticleTypes = catchAsync(async (req, res) => {
  const q = parseListQuery(req, { defaultLimit: 20, sortable: ['name', 'sort_order', 'created_at'], defaultSort: 'sort_order', defaultDir: 'asc' });
  let query = supabaseAdmin
    .from('article_types')
    .select(`${TYPE_COLUMNS}, articles(count)`, { count: 'exact' })
    .order(q.sort, { ascending: q.ascending })
    .order('name', { ascending: true })
    .range(q.from, q.to);
  query = searchFilter(statusFilter(req, query), q.search);
  const result = await query;
  const rows = unwrap(result, 'Could not load article types').map(({ articles, ...t }) => ({ ...t, articles_count: articles?.[0]?.count ?? 0 }));
  return sendPage(res, rows, q, result.count);
});

export const createArticleType = catchAsync(async (req, res) => {
  const name = cleanName(req.body?.name, 'Article type', 60);
  if (await findByName('article_types', name)) throw new ConflictError(`Article type "${name}" already exists.`);
  let sortOrder = cleanSortOrder(req.body?.sort_order, null);
  if (sortOrder === null) {
    // new types go to the end by default
    const { data } = await supabaseAdmin.from('article_types').select('sort_order').order('sort_order', { ascending: false }).limit(1);
    sortOrder = (data?.[0]?.sort_order ?? 0) + 10;
  }
  const created = unwrap(
    await supabaseAdmin.from('article_types').insert({ name, status: cleanStatus(req.body?.status, 'active'), sort_order: sortOrder }).select(TYPE_COLUMNS).single(),
    'Could not create the article type'
  );
  return ApiResponse.created(res, { ...created, articles_count: 0 }, `${name} added. Now add its articles.`);
});

export const updateArticleType = catchAsync(async (req, res) => {
  const current = unwrapOne(await supabaseAdmin.from('article_types').select('id, name').eq('id', req.params.id).maybeSingle(), 'Article type not found');
  const patch = {};
  if (req.body?.name !== undefined) {
    patch.name = cleanName(req.body.name, 'Article type', 60);
    const dupe = await findByName('article_types', patch.name);
    if (dupe && dupe.id !== current.id) throw new ConflictError(`Article type "${patch.name}" already exists.`);
  }
  if (req.body?.status !== undefined) patch.status = cleanStatus(req.body.status);
  if (req.body?.sort_order !== undefined) patch.sort_order = cleanSortOrder(req.body.sort_order, 0);
  if (!Object.keys(patch).length) throw new BadRequestError('Nothing to update.');
  const updated = unwrap(await supabaseAdmin.from('article_types').update(patch).eq('id', current.id).select(TYPE_COLUMNS).single(), 'Could not update the article type');
  return ApiResponse.success(res, updated, 'Article type updated.');
});

export const deleteArticleType = catchAsync(async (req, res) => {
  const current = unwrapOne(await supabaseAdmin.from('article_types').select('id, name').eq('id', req.params.id).maybeSingle(), 'Article type not found');
  const { count } = await supabaseAdmin.from('articles').select('id', { count: 'exact', head: true }).eq('article_type_id', current.id);
  if (count) {
    throw new ConflictError(`"${current.name}" still has ${count} article${count === 1 ? '' : 's'}. Delete them first, or deactivate the type to hide it from customers.`);
  }
  unwrap(await supabaseAdmin.from('article_types').delete().eq('id', current.id));
  return ApiResponse.success(res, { id: current.id }, 'Article type deleted.');
});

/**
 * GET /api/client/article-types?search&page&limit
 * Active types that have at least one active article, in the partner's order. Drives the dynamic article form.
 */
export const lookupArticleTypes = catchAsync(async (req, res) => {
  const q = parseListQuery(req, { defaultLimit: 20, maxLimit: 50, sortable: ['name', 'sort_order'], defaultSort: 'sort_order', defaultDir: 'asc' });
  let query = supabaseAdmin
    .from('article_types')
    .select('id, name, sort_order, articles!inner(id)', { count: 'exact' })
    .eq('status', 'active')
    .eq('articles.status', 'active')
    .limit(1, { referencedTable: 'articles' })
    .order('sort_order', { ascending: true })
    .order('name', { ascending: true })
    .range(q.from, q.to);
  query = searchFilter(query, q.search);
  const result = await query;
  const rows = unwrap(result, 'Could not load article types').map(({ articles, ...t }) => t);
  return sendPage(res, rows, q, result.count);
});

// ═════════════════════════════ Articles ═════════════════════════════

/** margin = customer price - partner cost (null until both are set) */
const withMargin = (a) => ({ ...a, margin: a.customer_price === null || a.customer_price === undefined || a.partner_cost === null || a.partner_cost === undefined ? null : round2(Number(a.customer_price) - Number(a.partner_cost)) });

const ARTICLE_COLUMNS = 'id, article_type_id, name, image_url, customer_price, partner_cost, status, sort_order, created_at, updated_at';

/** GET /api/partner/articles?type_id&search&status&page&limit */
export const listArticles = catchAsync(async (req, res) => {
  const q = parseListQuery(req, { defaultLimit: 20, sortable: ['name', 'sort_order', 'created_at', 'customer_price', 'partner_cost'], defaultSort: 'sort_order', defaultDir: 'asc' });
  let query = supabaseAdmin
    .from('articles')
    .select(`${ARTICLE_COLUMNS}, type:article_types(id, name)`, { count: 'exact' })
    .order(q.sort, { ascending: q.ascending, nullsFirst: false })
    .order('name', { ascending: true })
    .range(q.from, q.to);
  if (req.query.type_id) query = query.eq('article_type_id', req.query.type_id);
  query = searchFilter(statusFilter(req, query), q.search);
  const result = await query;
  return sendPage(res, unwrap(result, 'Could not load articles').map(withMargin), q, result.count);
});

const saveImage = async (req, current = null) => {
  const upload = req.body?.image_upload;
  if (upload?.dataUrl) {
    const stored = await uploadCatalogueImage('articles', upload);
    if (current?.image_path) await removeStoredFile('evidence', current.image_path);
    return { image_url: stored.url, image_path: stored.path };
  }
  if (req.body?.remove_image === true && current?.image_path) {
    await removeStoredFile('evidence', current.image_path);
    return { image_url: null, image_path: null };
  }
  return {};
};

export const createArticle = catchAsync(async (req, res) => {
  const type = unwrapOne(
    await supabaseAdmin.from('article_types').select('id, name').eq('id', req.body?.article_type_id || '00000000-0000-0000-0000-000000000000').maybeSingle(),
    'Choose which article type this belongs to'
  );
  const name = cleanName(req.body?.name, 'Article', 100);
  if (await findByName('articles', name, { article_type_id: type.id })) throw new ConflictError(`"${name}" already exists under ${type.name}.`);

  let sortOrder = cleanSortOrder(req.body?.sort_order, null);
  if (sortOrder === null) {
    const { data } = await supabaseAdmin.from('articles').select('sort_order').eq('article_type_id', type.id).order('sort_order', { ascending: false }).limit(1);
    sortOrder = (data?.[0]?.sort_order ?? 0) + 10;
  }
  const image = await saveImage(req);
  const created = unwrap(
    await supabaseAdmin
      .from('articles')
      .insert({ article_type_id: type.id, name, customer_price: cleanPrice(req.body?.customer_price) ?? null, partner_cost: cleanPrice(req.body?.partner_cost) ?? null, status: cleanStatus(req.body?.status, 'active'), sort_order: sortOrder, ...image })
      .select(ARTICLE_COLUMNS)
      .single(),
    'Could not create the article'
  );
  return ApiResponse.created(res, withMargin(created), `${name} added to ${type.name}.`);
});

export const updateArticle = catchAsync(async (req, res) => {
  const current = unwrapOne(await supabaseAdmin.from('articles').select('id, name, article_type_id, image_path').eq('id', req.params.id).maybeSingle(), 'Article not found');
  const patch = {};
  if (req.body?.name !== undefined) {
    patch.name = cleanName(req.body.name, 'Article', 100);
    const dupe = await findByName('articles', patch.name, { article_type_id: current.article_type_id });
    if (dupe && dupe.id !== current.id) throw new ConflictError(`"${patch.name}" already exists in this article type.`);
  }
  if (req.body?.customer_price !== undefined) patch.customer_price = cleanPrice(req.body.customer_price);
  if (req.body?.partner_cost !== undefined) patch.partner_cost = cleanPrice(req.body.partner_cost);
  if (req.body?.status !== undefined) patch.status = cleanStatus(req.body.status);
  if (req.body?.sort_order !== undefined) patch.sort_order = cleanSortOrder(req.body.sort_order, 0);
  Object.assign(patch, await saveImage(req, current));
  if (!Object.keys(patch).length) throw new BadRequestError('Nothing to update.');
  const updated = unwrap(await supabaseAdmin.from('articles').update(patch).eq('id', current.id).select(ARTICLE_COLUMNS).single(), 'Could not update the article');
  return ApiResponse.success(res, withMargin(updated), 'Article updated.');
});

export const deleteArticle = catchAsync(async (req, res) => {
  const current = unwrapOne(await supabaseAdmin.from('articles').select('id, name, image_path').eq('id', req.params.id).maybeSingle(), 'Article not found');
  const { count } = await supabaseAdmin.from('order_unit_articles').select('id', { count: 'exact', head: true }).eq('article_id', current.id);
  if (count) {
    unwrap(await supabaseAdmin.from('articles').update({ status: 'inactive' }).eq('id', current.id));
    return ApiResponse.success(res, { id: current.id, deleted: false, deactivated: true }, `"${current.name}" is on ${count} order piece${count === 1 ? '' : 's'}, so it was deactivated instead of deleted.`);
  }
  unwrap(await supabaseAdmin.from('articles').delete().eq('id', current.id));
  await removeStoredFile('evidence', current.image_path);
  return ApiResponse.success(res, { id: current.id, deleted: true, deactivated: false }, 'Article deleted.');
});

/**
 * GET /api/client/articles?type_id=<required>&search&page&limit
 * Active articles of an active type. Never includes the internal price.
 */
export const lookupArticles = catchAsync(async (req, res) => {
  const typeId = String(req.query.type_id || '');
  if (!typeId) throw new BadRequestError('type_id is required.');
  const q = parseListQuery(req, { defaultLimit: 20, maxLimit: 50, sortable: ['name'], defaultSort: 'name', defaultDir: 'asc' });
  const type = await supabaseAdmin.from('article_types').select('id').eq('id', typeId).eq('status', 'active').maybeSingle();
  if (!type.data) throw new NotFoundError('Article type not found');

  let query = supabaseAdmin
    .from('articles')
    .select('id, article_type_id, name, image_url', { count: 'exact' })
    .eq('article_type_id', typeId)
    .eq('status', 'active')
    .order('sort_order', { ascending: true })
    .order('name', { ascending: true })
    .range(q.from, q.to);
  query = searchFilter(query, q.search);
  const result = await query;
  return sendPage(res, unwrap(result, 'Could not load articles'), q, result.count);
});

