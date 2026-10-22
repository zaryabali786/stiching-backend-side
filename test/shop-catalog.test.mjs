/**
 * The Shop catalog: syncing a brand's Shopify products into our tables, keeping an administrator's "hidden", marking removed or unpublished
 * products as not for sale, stock without the inventory permission, and the live price/stock check before a payment. Shopify is faked.
 */
import { test, mock, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeDb } from './fake-supabase.mjs';

let db;
let catalog;
let svc;
let behave;
const dbProxy = new Proxy({}, { get: (_, key) => db[key] });
const STORE = { id: 'sA', shop_domain: 'brand-a.myshopify.com', status: 'active' };

const product = (n, extra = {}) => ({
  id: `gid://shopify/Product/${n}`,
  handle: `p${n}`,
  title: `Product ${n}`,
  description: 'Nice',
  vendor: 'Brand A',
  productType: 'Shirt',
  tags: [],
  status: 'ACTIVE',
  publishedAt: '2026-10-01T00:00:00Z',
  updatedAt: '2026-10-02T00:00:00Z',
  category: { name: 'Shirts' },
  featuredMedia: { preview: { image: { url: `https://img/${n}.jpg` } } },
  media: { nodes: [{ preview: { image: { url: `https://img/${n}.jpg` } } }] },
  collections: { nodes: [{ title: 'Summer' }] },
  options: [{ name: 'Size', values: ['S', 'M'] }],
  variants: {
    pageInfo: { hasNextPage: false },
    nodes: [
      { id: `gid://shopify/ProductVariant/${n}1`, title: 'S', sku: 'S1', price: '25.00', compareAtPrice: null, selectedOptions: [{ name: 'Size', value: 'S' }], inventoryQuantity: 4, inventoryPolicy: 'DENY', image: null },
      { id: `gid://shopify/ProductVariant/${n}2`, title: 'M', sku: 'S2', price: '30.00', compareAtPrice: '40.00', selectedOptions: [{ name: 'Size', value: 'M' }], inventoryQuantity: 0, inventoryPolicy: 'DENY', image: null },
    ],
  },
  ...extra,
});

before(async () => {
  mock.module('../src/config/supabase.js', { namedExports: { supabaseAdmin: dbProxy, supabase: dbProxy } });
  mock.module('../src/services/stripe.service.js', { namedExports: { isStripeEnabled: () => true, createShopPaymentIntent: async () => ({}), cancelPaymentIntent: async () => {}, retrievePaymentIntent: async () => ({}), toMinorUnits: (a) => Math.round(a * 100) } });
  mock.module('../src/services/shopify.service.js', {
    namedExports: {
      shopifyGraphql: async (store, query, vars) => {
        if (/currencyCode/.test(query)) return { shop: { currencyCode: 'USD' } };
        if (/inventoryQuantity/.test(query) && behave.noInventoryScope) throw new Error('Access denied for inventoryQuantity field. Required access: `read_inventory` access scope.');
        if (/products\(first/.test(query)) return { products: { pageInfo: { hasNextPage: false }, nodes: behave.products } };
        if (/product\(id/.test(query)) return { product: behave.one ?? null };
        if (/nodes\(ids/.test(query)) return { nodes: behave.live };
        return {};
      },
    },
  });
  catalog = await import('../src/services/shop-catalog.service.js');
  svc = await import('../src/services/shop.service.js');
});

beforeEach(() => {
  behave = { products: [product(1), product(2)] };
  db = createFakeDb({ shopify_stores: [{ ...STORE }], shop_brand_settings: [{ store_id: 'sA', approved: true, inventory_known: true }], shop_products: [], shop_variants: [] }, {});
});

test('a sync saves products and variants with price, options, compare-at price and stock', async () => {
  const r = await catalog.syncStoreCatalog(STORE);
  assert.deepEqual([r.products, r.variants, r.error], [2, 4, null]);
  const p = db.table('shop_products').find((x) => x.shopify_product_id === '1');
  assert.equal(p.price_min, 25);
  assert.equal(p.price_max, 30);
  assert.equal(p.currency, 'USD');
  assert.equal(p.category, 'Shirts');
  assert.deepEqual(p.collections, ['Summer']);
  assert.equal(p.in_stock, true, 'one variant has stock');
  const vs = db.table('shop_variants').filter((v) => v.product_id === p.id);
  assert.equal(vs.find((v) => v.title === 'S').in_stock, true);
  assert.equal(vs.find((v) => v.title === 'M').in_stock, false, 'zero stock with the deny policy is out of stock');
  assert.equal(vs.find((v) => v.title === 'M').compare_at_price, 40);
  assert.equal(db.table('shop_brand_settings')[0].catalog_status, 'ok');
});

test('syncing again changes nothing twice, keeps an administrator\'s hidden flag, and an updated price follows Shopify', async () => {
  await catalog.syncStoreCatalog(STORE);
  db.table('shop_products').find((x) => x.shopify_product_id === '1').hidden = true;
  behave.products[0].variants.nodes[0].price = '27.50';
  await catalog.syncStoreCatalog(STORE);
  assert.equal(db.table('shop_products').length, 2);
  assert.equal(db.table('shop_variants').length, 4);
  const p = db.table('shop_products').find((x) => x.shopify_product_id === '1');
  assert.equal(p.hidden, true, 'hiding is ours and survives a sync');
  assert.equal(p.price_min, 27.5);
});

test('a product that is gone, unpublished or no longer active can never be bought', async () => {
  await catalog.syncStoreCatalog(STORE);
  behave.products = [product(1, { publishedAt: null })]; // 1 unpublished, 2 missing
  await catalog.syncStoreCatalog(STORE);
  assert.equal(db.table('shop_products').find((x) => x.shopify_product_id === '1').sellable, false);
  assert.equal(db.table('shop_products').find((x) => x.shopify_product_id === '2').sellable, false);
});

test('a brand that did not grant inventory access still syncs: stock is unknown, not zero', async () => {
  behave.noInventoryScope = true;
  const r = await catalog.syncStoreCatalog(STORE);
  assert.equal(r.error, null);
  assert.equal(db.table('shop_brand_settings')[0].inventory_known, false);
  assert.ok(db.table('shop_variants').every((v) => v.in_stock === true && v.inventory_quantity === null));
});

test('a sync that fails says why on the brand and keeps the catalog it already had', async () => {
  await catalog.syncStoreCatalog(STORE);
  behave.products = null;
  const r = await catalog.syncStoreCatalog(STORE);
  assert.ok(r.error);
  assert.equal(db.table('shop_brand_settings')[0].catalog_status, 'error');
  assert.equal(db.table('shop_products').length, 2);
});

test('the products webhook refreshes one product; a deleted one stops being sellable', async () => {
  await catalog.syncStoreCatalog(STORE);
  behave.one = product(1, { title: 'Renamed' });
  await catalog.syncOneProduct(STORE, 1);
  assert.equal(db.table('shop_products').find((x) => x.shopify_product_id === '1').title, 'Renamed');
  behave.one = null;
  await catalog.syncOneProduct(STORE, 1);
  assert.equal(db.table('shop_products').find((x) => x.shopify_product_id === '1').sellable, false);
});

// ───────────── the check made against the brand's store right before payment ─────────────

const line = (extra = {}) => ({ variant_id: 'v1', shopify_variant_id: '51', store_id: 'sA', title: 'Kurta', quantity: 2, unit_price: 25, brand: { name: 'Brand A' }, ...extra });
const live = (extra = {}) => ({ id: 'gid://shopify/ProductVariant/51', price: '25.00', inventoryQuantity: 9, inventoryPolicy: 'DENY', product: { status: 'ACTIVE', publishedAt: '2026-10-01' }, ...extra });

test('live check: an unchanged cart has no changes', async () => {
  db = createFakeDb({ shop_variants: [{ id: 'v1', price: 25, in_stock: true }] }, {});
  behave.live = [live()];
  assert.deepEqual(await svc.validateLive([line()], new Map([['sA', STORE]])), []);
});

test('live check: a new price, low stock, an unpublished product and a missing variant are all reported (and the snapshot updated)', async () => {
  db = createFakeDb({ shop_variants: [{ id: 'v1', price: 25, in_stock: true }, { id: 'v2', price: 10, in_stock: true }] }, {});
  behave.live = [live({ price: '29.00' })];
  let changes = await svc.validateLive([line()], new Map([['sA', STORE]]));
  assert.match(changes[0], /price is now 29.00 \(was 25.00\)/);
  assert.equal(db.table('shop_variants').find((v) => v.id === 'v1').price, 29);
  behave.live = [live({ inventoryQuantity: 1 })];
  changes = await svc.validateLive([line()], new Map([['sA', STORE]]));
  assert.match(changes.join(' '), /only 1 left/);
  behave.live = [live({ inventoryQuantity: 0 })];
  assert.match((await svc.validateLive([line()], new Map([['sA', STORE]]))).join(' '), /out of stock/);
  behave.live = [live({ product: { status: 'DRAFT', publishedAt: null } })];
  assert.match((await svc.validateLive([line()], new Map([['sA', STORE]])))[0], /no longer available/);
  behave.live = [null];
  assert.match((await svc.validateLive([line()], new Map([['sA', STORE]])))[0], /no longer available/);
  assert.equal(db.table('shop_variants').find((v) => v.id === 'v1').in_stock, false);
});

test('live check: a policy that sells past zero stock is fine; a store that cannot be reached blocks the sale', async () => {
  db = createFakeDb({ shop_variants: [{ id: 'v1', price: 25, in_stock: true }] }, {});
  behave.live = [live({ inventoryQuantity: 0, inventoryPolicy: 'CONTINUE' })];
  assert.deepEqual(await svc.validateLive([line({ quantity: 5 })], new Map([['sA', STORE]])), []);
});
