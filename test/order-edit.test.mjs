/** Edit order: the shipping type follows the delivery country (no International question) and saved customizations keep their prices. */
import { test, mock, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeDb } from './fake-supabase.mjs';

let db;
let input;
let price;
const dbProxy = new Proxy({}, { get: (_, key) => db[key] });

before(async () => {
  mock.module('../src/config/supabase.js', { namedExports: { supabaseAdmin: dbProxy, supabase: dbProxy } });
  input = await import('../src/services/order-input.service.js');
  price = await import('../src/services/article-price.service.js');
});

beforeEach(() => {
  db = createFakeDb({
    brands: [{ id: '11111111-1111-4111-8111-111111111111', name: 'Alkaram', status: 'active' }],
    couriers: [],
    partners: [{ id: 'p-default', is_default: true }, { id: 'p-other' }],
    article_types: [{ id: 't-neck', name: 'Neckline' }, { id: 't-neck-p', name: 'Neckline', partner_id: 'p-default' }],
    articles: [
      { id: 'a-shared', name: 'Round', article_type_id: 't-neck', partner_id: null, customer_price: null },
      { id: 'a-own', name: 'Round', article_type_id: 't-neck-p', partner_id: 'p-default', customer_price: 700, type: { name: 'Neckline' } },
    ],
  });
});

test('the shipping type follows the delivery country, never a question', async () => {
  const BRAND = '11111111-1111-4111-8111-111111111111';
  assert.equal(input.internationalFromCountry('Pakistan'), false);
  assert.equal(input.internationalFromCountry('United Kingdom'), true);
  assert.equal(input.internationalFromCountry(''), null);
  const home = await input.resolveOrderRefs({ brand_id: BRAND, destination_country: 'pakistan' });
  assert.equal(home.international_shipping, false);
  assert.equal(home.shipping_service, 'standard');
  const abroad = await input.resolveOrderRefs({ brand_id: BRAND, destination_country: 'UAE' });
  assert.equal(abroad.international_shipping, true);
  assert.equal(abroad.shipping_service, 'express');
  const unknown = await input.resolveOrderRefs({ brand_id: BRAND });
  assert.equal(unknown.international_shipping, false, 'no country and no value: domestic, no error');
});

test('a saved shared customization with no price of its own shows the partner price instead of nothing', async () => {
  const map = await price.fallbackPrices([
    { name: 'Round', type_name: 'Neckline', customer_price: null },
    { name: 'Round', type_name: 'Neckline', customer_price: 900 },
    { name: 'Square', type_name: 'Neckline', customer_price: null },
  ]);
  assert.equal(map.get(price.priceKey('Neckline', 'Round')), 700, 'the price is found');
  assert.equal(map.has(price.priceKey('Neckline', 'Square')), false, 'no price anywhere stays "on request", never 0');
});

test('an "Other" brand typed for an article is only text on that order and creates no brand', async () => {
  const before = db.table('brands').length;
  const refs = await input.resolveOrderRefs({ brand_text: '  Local   Boutique ', destination_country: 'Pakistan' });
  assert.equal(refs.brand, 'Local Boutique');
  assert.equal(refs.brand_id, null);
  assert.equal(db.table('brands').length, before, 'the brand list is untouched');
  await assert.rejects(() => input.resolveOrderRefs({ destination_country: 'Pakistan' }), /Choose the brand/);
});
