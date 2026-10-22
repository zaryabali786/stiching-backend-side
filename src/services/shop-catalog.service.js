import { supabaseAdmin } from '../config/supabase.js';
import { shopifyGraphql } from './shopify.service.js';

/**
 * The Shop's catalog: a snapshot of every approved brand's Shopify products, kept in our database so browsing never calls Shopify.
 * Refreshed by "Sync now", by the products webhooks (one product) and by a slow background timer. A product that is no longer active /
 * published in the brand's store (or was deleted) is marked not sellable; nothing is ever deleted from the brand's store.
 */

const PRODUCT_FIELDS = (withInventory) => `
  id handle title description vendor productType tags status publishedAt updatedAt
  category { name }
  featuredMedia { preview { image { url } } }
  media(first: 10) { nodes { preview { image { url } } } }
  collections(first: 5) { nodes { title } }
  options { name values }
  variants(first: 50) {
    pageInfo { hasNextPage endCursor }
    nodes { id title sku price compareAtPrice selectedOptions { name value } ${withInventory ? 'inventoryQuantity inventoryPolicy' : ''} image { url } }
  }`;

export const PAGE_QUERY = (withInventory) => `query($cursor: String) { products(first: 10, after: $cursor, query: "status:active") { pageInfo { hasNextPage endCursor } nodes { ${PRODUCT_FIELDS(withInventory)} } } }`;
const ONE_QUERY = (withInventory) => `query($id: ID!) { product(id: $id) { ${PRODUCT_FIELDS(withInventory)} } }`;
const MORE_VARIANTS = (withInventory) => `query($id: ID!, $cursor: String) { product(id: $id) { variants(first: 100, after: $cursor) { pageInfo { hasNextPage endCursor } nodes { id title sku price compareAtPrice selectedOptions { name value } ${withInventory ? 'inventoryQuantity inventoryPolicy' : ''} image { url } } } } }`;

const gidTail = (gid) => String(gid || '').split('/').pop();
const money = (v) => (v === null || v === undefined || v === '' ? null : Number(v));

export const ensureBrandSettings = async (storeId) => {
  const { data } = await supabaseAdmin.from('shop_brand_settings').select('*').eq('store_id', storeId).maybeSingle();
  if (data) return data;
  const ins = await supabaseAdmin.from('shop_brand_settings').insert({ store_id: storeId }).select('*').maybeSingle();
  if (ins.error && ins.error.code !== '23505') throw ins.error;
  return ins.data || (await supabaseAdmin.from('shop_brand_settings').select('*').eq('store_id', storeId).single()).data;
};

const isInventoryDenied = (err) => /access denied|read_inventory|inventoryQuantity|inventoryPolicy/i.test(err?.message || '');

/** Runs a query that reads inventory; if the brand did not grant read_inventory, runs it without and reports that stock is unknown. */
const withInventoryFallback = async (store, build, variables, state) => {
  if (state.inventory) {
    try {
      return await shopifyGraphql(store, build(true), variables);
    } catch (err) {
      if (!isInventoryDenied(err)) throw err;
      state.inventory = false;
    }
  }
  return shopifyGraphql(store, build(false), variables);
};

const variantRow = (v, inventoryKnown) => {
  const qty = inventoryKnown && typeof v.inventoryQuantity === 'number' ? v.inventoryQuantity : null;
  const policy = v.inventoryPolicy || null;
  const inStock = !inventoryKnown || policy === 'CONTINUE' || (qty ?? 0) > 0;
  const options = {};
  for (const o of v.selectedOptions || []) options[o.name] = o.value;
  return {
    shopify_variant_id: gidTail(v.id),
    title: v.title || null,
    sku: v.sku || null,
    options,
    price: money(v.price) ?? 0,
    compare_at_price: money(v.compareAtPrice),
    inventory_quantity: qty,
    inventory_policy: policy,
    in_stock: inStock,
    image_url: v.image?.url || null,
  };
};

/** Saves one Shopify product (and its variants) in the catalog. Returns { variants } saved. */
const saveProduct = async (store, p, currency, state) => {
  let variants = p.variants?.nodes || [];
  let page = p.variants?.pageInfo;
  while (page?.hasNextPage) {
    const more = await withInventoryFallback(store, MORE_VARIANTS, { id: p.id, cursor: page.endCursor }, state);
    variants = variants.concat(more.product?.variants?.nodes || []);
    page = more.product?.variants?.pageInfo;
  }
  const rows = variants.map((v) => variantRow(v, state.inventory));
  const prices = rows.map((r) => r.price).filter((n) => Number.isFinite(n));
  const images = (p.media?.nodes || []).map((m) => m.preview?.image?.url).filter(Boolean);
  const sellable = p.status === 'ACTIVE' && !!p.publishedAt && rows.length > 0;
  const productRow = {
    store_id: store.id,
    shopify_product_id: gidTail(p.id),
    handle: p.handle || null,
    title: p.title,
    description: p.description || null,
    vendor: p.vendor || null,
    category: p.category?.name || p.productType || null,
    collections: (p.collections?.nodes || []).map((c) => c.title),
    tags: p.tags || [],
    image_url: p.featuredMedia?.preview?.image?.url || images[0] || null,
    images,
    options: (p.options || []).filter((o) => !(o.name === 'Title' && o.values?.length === 1 && o.values[0] === 'Default Title')).map((o) => ({ name: o.name, values: o.values })),
    price_min: prices.length ? Math.min(...prices) : null,
    price_max: prices.length ? Math.max(...prices) : null,
    currency,
    in_stock: rows.some((r) => r.in_stock),
    sellable,
    shopify_status: p.status,
    shopify_updated_at: p.updatedAt || null,
    synced_at: new Date().toISOString(),
  };
  const up = await supabaseAdmin.from('shop_products').upsert(productRow, { onConflict: 'store_id,shopify_product_id' }).select('id').single();
  if (up.error) throw up.error;
  const productId = up.data.id;
  if (rows.length) {
    const upv = await supabaseAdmin.from('shop_variants').upsert(rows.map((r, i) => ({ ...r, product_id: productId, position: i })), { onConflict: 'product_id,shopify_variant_id' });
    if (upv.error) throw upv.error;
  }
  // variants that no longer exist in Shopify can no longer be bought (a cart holding one is told so): remove them from the snapshot
  const keep = new Set(rows.map((r) => r.shopify_variant_id));
  const { data: have } = await supabaseAdmin.from('shop_variants').select('id, shopify_variant_id').eq('product_id', productId);
  const gone = (have || []).filter((v) => !keep.has(v.shopify_variant_id)).map((v) => v.id);
  if (gone.length) await supabaseAdmin.from('shop_variants').update({ in_stock: false, inventory_quantity: 0, inventory_policy: 'DENY' }).in('id', gone);
  return { variants: rows.length };
};

const shopCurrency = async (store) => (await shopifyGraphql(store, 'query { shop { currencyCode } }')).shop?.currencyCode || null;

/**
 * Full sync of one brand store. Never throws: the result and any error are written on the brand's settings (catalog_status / catalog_error).
 * @returns {Promise<{ products: number, variants: number, removed: number, error: string|null }>}
 */
export const syncStoreCatalog = async (store) => {
  await ensureBrandSettings(store.id);
  await supabaseAdmin.from('shop_brand_settings').update({ catalog_status: 'syncing', updated_at: new Date().toISOString() }).eq('store_id', store.id);
  const state = { inventory: true };
  const seen = new Set();
  let products = 0;
  let variants = 0;
  try {
    const currency = await shopCurrency(store);
    let cursor = null;
    for (let guard = 0; guard < 400; guard++) {
      const res = await withInventoryFallback(store, PAGE_QUERY, { cursor }, state);
      for (const p of res.products.nodes) {
        const saved = await saveProduct(store, p, currency, state);
        seen.add(gidTail(p.id));
        products++;
        variants += saved.variants;
      }
      if (!res.products.pageInfo.hasNextPage) break;
      cursor = res.products.pageInfo.endCursor;
    }
    // products that are no longer active/published (or were removed): not sellable any more, kept for history
    const { data: all } = await supabaseAdmin.from('shop_products').select('id, shopify_product_id').eq('store_id', store.id).eq('sellable', true);
    const stale = (all || []).filter((r) => !seen.has(r.shopify_product_id)).map((r) => r.id);
    if (stale.length) await supabaseAdmin.from('shop_products').update({ sellable: false, synced_at: new Date().toISOString() }).in('id', stale);
    await supabaseAdmin
      .from('shop_brand_settings')
      .update({ catalog_status: 'ok', catalog_synced_at: new Date().toISOString(), catalog_error: null, currency, inventory_known: state.inventory, updated_at: new Date().toISOString() })
      .eq('store_id', store.id);
    return { products, variants, removed: stale.length, error: null };
  } catch (err) {
    const message = String(err?.message || err).slice(0, 400);
    await supabaseAdmin.from('shop_brand_settings').update({ catalog_status: 'error', catalog_error: message, updated_at: new Date().toISOString() }).eq('store_id', store.id);
    return { products, variants, removed: 0, error: message };
  }
};

/** One product changed in Shopify (products/update webhook): refresh just that one. */
export const syncOneProduct = async (store, shopifyProductId) => {
  const settings = await ensureBrandSettings(store.id);
  if (!settings.approved) return { status: 'not_approved' };
  const state = { inventory: settings.inventory_known !== false };
  const res = await withInventoryFallback(store, ONE_QUERY, { id: `gid://shopify/Product/${gidTail(shopifyProductId)}` }, state);
  if (!res.product) return markProductGone(store, shopifyProductId);
  const currency = settings.currency || (await shopCurrency(store));
  await saveProduct(store, res.product, currency, state);
  return { status: 'synced' };
};

/** A product deleted in (or no longer visible to) the brand's store: no longer sellable. */
export const markProductGone = async (store, shopifyProductId) => {
  await supabaseAdmin.from('shop_products').update({ sellable: false, synced_at: new Date().toISOString() }).eq('store_id', store.id).eq('shopify_product_id', gidTail(shopifyProductId));
  return { status: 'removed' };
};

let timer = null;
const SYNC_EVERY_MS = 6 * 60 * 60 * 1000;

/** A slow background refresh of every approved brand, as a safety net behind the webhooks. */
export const syncApprovedCatalogs = async () => {
  const { data } = await supabaseAdmin.from('shop_brand_settings').select('store_id').eq('approved', true);
  for (const row of data || []) {
    const { data: store } = await supabaseAdmin.from('shopify_stores').select('*').eq('id', row.store_id).eq('status', 'active').maybeSingle();
    if (store) await syncStoreCatalog(store);
  }
};

export const startShopCatalogTimer = () => {
  if (timer || process.env.NODE_ENV === 'test') return;
  timer = setInterval(() => syncApprovedCatalogs().catch((err) => console.warn('[Shop] catalog refresh failed:', err.message)), SYNC_EVERY_MS);
  timer.unref?.();
};
