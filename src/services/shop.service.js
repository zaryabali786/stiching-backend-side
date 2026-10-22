import { supabaseAdmin } from '../config/supabase.js';
import { config } from '../config/env.js';
import { BadRequestError, ConflictError, NotFoundError } from '../utils/error.helper.js';
import { shopifyGraphql } from './shopify.service.js';
import { createShopPaymentIntent, isStripeEnabled, cancelPaymentIntent, retrievePaymentIntent, toMinorUnits } from './stripe.service.js';

/**
 * The customer side of the Shop: browsing the synchronized catalog, the cart, and checkout (which re-checks every price and stock level live
 * in the brands' Shopify stores, creates ONE parent order with one child per brand, and starts ONE Stripe payment). The money goes to the
 * platform; each brand is settled later (see shop-orders.service.js). Brands' data stays separate: a customer only ever sees brand names.
 */

export const DISCLOSURE = 'Each item is fulfilled and shipped by its own brand, not by Stitch&Ship. Items from different brands arrive in separate parcels, possibly on different days. You pay once, to Stitch&Ship.';
export const TAX_NOTICE = 'Prices are as listed by each brand. Taxes and duties are not added by Stitch&Ship; any that apply are the brand\'s or the courier\'s.';

export const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const gid = (type, id) => `gid://shopify/${type}/${String(id).split('/').pop()}`;

// ───────────── what may be shown: approved brands only ─────────────

/** Map storeId -> { id, name, settings } of the brands that are connected AND approved to sell. */
export const approvedBrands = async () => {
  const { data: settings } = await supabaseAdmin.from('shop_brand_settings').select('*').eq('approved', true);
  const ids = (settings || []).map((s) => s.store_id);
  const map = new Map();
  if (!ids.length) return map;
  const { data: stores } = await supabaseAdmin.from('shopify_stores').select('id, shop_domain, status, brand:brands(name)').in('id', ids).eq('status', 'active');
  for (const st of stores || []) {
    const name = st.brand?.name || String(st.shop_domain || '').replace(/\.myshopify\.com$/, '');
    map.set(st.id, { id: st.id, name, shop_domain: st.shop_domain, settings: settings.find((s) => s.store_id === st.id) });
  }
  return map;
};

const colorsOf = (p) => {
  const opt = (p.options || []).find((o) => /^colou?rs?$/i.test(o.name));
  return opt ? (opt.values || []).slice(0, 8) : [];
};

const productCard = (p, brands, sale = null) => ({
  id: p.id,
  title: p.title,
  image_url: p.image_url,
  price_min: p.price_min === null ? null : Number(p.price_min),
  price_max: p.price_max === null ? null : Number(p.price_max),
  currency: p.currency,
  in_stock: !!p.in_stock,
  category: p.category,
  // the cheapest variant's compare-at price (when it is higher), so a card can show the old price and the discount
  compare_at_price: sale?.compare_at ?? null,
  discount_percent: sale?.percent ?? null,
  colors: colorsOf(p),
  brand: { id: p.store_id, name: brands.get(p.store_id)?.name || '' },
});

const SORTS = { newest: ['synced_at', false], price_asc: ['price_min', true], price_desc: ['price_min', false], title: ['title', true] };

export const listProducts = async ({ search, brand, category, collection, sort, min, max, inStock, from, to }) => {
  const brands = await approvedBrands();
  const storeIds = [...brands.keys()].filter((id) => !brand || id === brand);
  if (!storeIds.length) return { rows: [], total: 0 };
  const [col, asc] = SORTS[sort] || SORTS.newest;
  let q = supabaseAdmin
    .from('shop_products')
    .select('*', { count: 'exact' })
    .in('store_id', storeIds)
    .eq('sellable', true)
    .eq('hidden', false)
    .order(col, { ascending: asc, nullsFirst: false })
    .order('id')
    .range(from, to);
  if (search) q = q.or(`title.ilike.%${search.replace(/[%,]/g, ' ')}%,vendor.ilike.%${search.replace(/[%,]/g, ' ')}%`);
  if (category) q = q.eq('category', category);
  if (collection) q = q.contains('collections', [collection]);
  if (Number.isFinite(min)) q = q.gte('price_min', min);
  if (Number.isFinite(max)) q = q.lte('price_min', max);
  if (inStock) q = q.eq('in_stock', true);
  const { data, count, error } = await q;
  if (error) throw error;
  // one query for the page's variants: the discount is read from the cheapest variant of each product
  const ids = (data || []).map((p) => p.id);
  const { data: vs } = ids.length ? await supabaseAdmin.from('shop_variants').select('product_id, price, compare_at_price').in('product_id', ids) : { data: [] };
  const sale = new Map();
  for (const v of vs || []) {
    const cur = sale.get(v.product_id);
    if (!cur || Number(v.price) < cur.price) sale.set(v.product_id, { price: Number(v.price), compare_at: v.compare_at_price === null ? null : Number(v.compare_at_price) });
  }
  const saleOf = (id) => {
    const c = sale.get(id);
    return c && c.compare_at && c.compare_at > c.price ? { compare_at: c.compare_at, percent: Math.round(((c.compare_at - c.price) / c.compare_at) * 100) } : null;
  };
  return { rows: (data || []).map((p) => productCard(p, brands, saleOf(p.id))), total: count || 0 };
};

export const shopFilters = async () => {
  const brands = await approvedBrands();
  const ids = [...brands.keys()];
  if (!ids.length) return { brands: [], categories: [], collections: [] };
  const { data } = await supabaseAdmin.from('shop_products').select('store_id, category, collections').in('store_id', ids).eq('sellable', true).eq('hidden', false).limit(10000);
  const b = new Map();
  const c = new Map();
  const col = new Map();
  for (const p of data || []) {
    b.set(p.store_id, (b.get(p.store_id) || 0) + 1);
    if (p.category) c.set(p.category, (c.get(p.category) || 0) + 1);
    for (const n of p.collections || []) col.set(n, (col.get(n) || 0) + 1);
  }
  const list = (m) => [...m.entries()].map(([name, count]) => ({ name, count })).sort((x, y) => x.name.localeCompare(y.name));
  return {
    brands: [...b.entries()].map(([id, count]) => ({ id, name: brands.get(id)?.name || '', count })).sort((x, y) => x.name.localeCompare(y.name)),
    categories: list(c),
    collections: list(col),
  };
};

export const getProduct = async (id) => {
  const brands = await approvedBrands();
  const { data: p } = await supabaseAdmin.from('shop_products').select('*').eq('id', id).maybeSingle();
  if (!p || !p.sellable || p.hidden || !brands.has(p.store_id)) throw new NotFoundError('This product is not available.');
  const { data: variants } = await supabaseAdmin.from('shop_variants').select('*').eq('product_id', p.id).order('position');
  const brand = brands.get(p.store_id);
  const known = brand.settings?.inventory_known !== false;
  return {
    ...productCard(p, brands),
    description: p.description,
    images: p.images?.length ? p.images : p.image_url ? [p.image_url] : [],
    options: p.options || [],
    fulfilled_by: brand.name,
    variants: (variants || []).map((v) => ({
      id: v.id,
      title: v.title,
      sku: v.sku || null,
      options: v.options || {},
      price: Number(v.price),
      compare_at_price: v.compare_at_price === null ? null : Number(v.compare_at_price),
      in_stock: !!v.in_stock,
      // only a small number is shown (never a precise stock figure for a large one)
      quantity_hint: known && v.inventory_policy !== 'CONTINUE' && v.inventory_quantity !== null && v.inventory_quantity <= 5 ? Math.max(0, v.inventory_quantity) : null,
      image_url: v.image_url,
    })),
  };
};

// ───────────── the cart ─────────────

const CART_SELECT = 'quantity, unit_price_seen, variant:shop_variants(id, title, price, in_stock, inventory_quantity, inventory_policy, image_url, shopify_variant_id, sku, product:shop_products(id, title, image_url, store_id, currency, sellable, hidden, shopify_product_id))';

const maxQuantity = (v) => (v.inventory_policy === 'CONTINUE' || v.inventory_quantity === null ? 99 : Math.max(0, Math.min(99, v.inventory_quantity)));

/** The cart lines with everything checked against the current catalog (a line that can no longer be bought says why). */
const loadCartLines = async (customerId) => {
  const brands = await approvedBrands();
  const { data, error } = await supabaseAdmin.from('shop_cart_items').select(CART_SELECT).eq('customer_id', customerId).order('created_at');
  if (error) throw error;
  return (data || [])
    .filter((r) => r.variant?.product)
    .map((r) => {
      const v = r.variant;
      const p = v.product;
      const brand = brands.get(p.store_id);
      let issue = null;
      if (!brand || !p.sellable || p.hidden) issue = 'This item is no longer available.';
      else if (!v.in_stock) issue = 'This variant is out of stock.';
      else if (r.quantity > maxQuantity(v)) issue = `Only ${maxQuantity(v)} left.`;
      else if (r.unit_price_seen !== null && round2(r.unit_price_seen) !== round2(v.price)) issue = `The price changed from ${round2(r.unit_price_seen).toFixed(2)} to ${round2(v.price).toFixed(2)}.`;
      return {
        variant_id: v.id,
        product_id: p.id,
        store_id: p.store_id,
        shopify_variant_id: v.shopify_variant_id,
        shopify_product_id: p.shopify_product_id,
        sku: v.sku,
        title: p.title,
        variant_title: v.title && v.title !== 'Default Title' ? v.title : null,
        image_url: v.image_url || p.image_url,
        brand: { id: p.store_id, name: brand?.name || '' },
        brand_settings: brand?.settings || null,
        quantity: r.quantity,
        unit_price: round2(v.price),
        currency: p.currency,
        line_total: round2(v.price * r.quantity),
        available: !issue || /price changed/.test(issue),
        issue,
      };
    });
};

export const cartView = async (customerId) => {
  const lines = await loadCartLines(customerId);
  const groups = new Map();
  for (const l of lines) {
    const g = groups.get(l.store_id) || { brand: l.brand, items_count: 0, subtotal: 0, shipping: round2(l.brand_settings?.shipping_flat || 0), total: 0 };
    g.items_count += l.quantity;
    g.subtotal = round2(g.subtotal + l.line_total);
    groups.set(l.store_id, g);
  }
  for (const g of groups.values()) g.total = round2(g.subtotal + g.shipping);
  const subtotal = round2([...groups.values()].reduce((a, g) => a + g.subtotal, 0));
  const shipping_total = round2([...groups.values()].reduce((a, g) => a + g.shipping, 0));
  const currency = lines[0]?.currency || null;
  const notices = [TAX_NOTICE];
  if (groups.size > 1) notices.push('Your cart has items from different brands: they ship separately.');
  const blocking = lines.filter((l) => l.issue && !/price changed/.test(l.issue));
  const publicLines = lines.map(({ store_id, shopify_variant_id, shopify_product_id, sku, brand_settings, ...rest }) => rest);
  return {
    items: publicLines,
    groups: [...groups.values()],
    subtotal,
    shipping_total,
    tax_total: 0,
    discount_total: 0,
    total: round2(subtotal + shipping_total),
    currency,
    notices,
    can_checkout: lines.length > 0 && blocking.length === 0,
    disclosure: DISCLOSURE,
  };
};

export const setCartItem = async (customerId, variantId, quantity) => {
  const qty = Math.floor(Number(quantity));
  if (!Number.isFinite(qty) || qty < 0 || qty > 99) throw new BadRequestError('Choose a quantity between 0 and 99.');
  if (qty === 0) return removeCartItem(customerId, variantId);
  const { data: v } = await supabaseAdmin.from('shop_variants').select('id, price, in_stock, inventory_quantity, inventory_policy, product:shop_products(id, store_id, currency, sellable, hidden)').eq('id', variantId).maybeSingle();
  const brands = await approvedBrands();
  if (!v || !v.product?.sellable || v.product.hidden || !brands.has(v.product.store_id)) throw new NotFoundError('This item is not available.');
  if (!v.in_stock) throw new ConflictError('This variant is out of stock.');
  if (qty > maxQuantity(v)) throw new ConflictError(`Only ${maxQuantity(v)} available.`);
  // one currency per cart: a payment is in one currency
  const { data: current } = await supabaseAdmin.from('shop_cart_items').select('variant:shop_variants(product:shop_products(currency))').eq('customer_id', customerId).neq('variant_id', variantId).limit(1);
  const other = current?.[0]?.variant?.product?.currency;
  if (other && v.product.currency && other !== v.product.currency) throw new ConflictError(`Your cart is in ${other}. This item is in ${v.product.currency}: pay for the current cart first, or remove its items.`);
  const { error } = await supabaseAdmin.from('shop_cart_items').upsert({ customer_id: customerId, variant_id: variantId, quantity: qty, unit_price_seen: v.price, updated_at: new Date().toISOString() }, { onConflict: 'customer_id,variant_id' });
  if (error) throw error;
  return cartView(customerId);
};

export const removeCartItem = async (customerId, variantId) => {
  await supabaseAdmin.from('shop_cart_items').delete().eq('customer_id', customerId).eq('variant_id', variantId);
  return cartView(customerId);
};

/** The customer accepts the prices shown now: the "price changed" notices are cleared. */
const acceptSeenPrices = async (customerId, lines) => {
  for (const l of lines) await supabaseAdmin.from('shop_cart_items').update({ unit_price_seen: l.unit_price }).eq('customer_id', customerId).eq('variant_id', l.variant_id);
};

// ───────────── live validation against each brand's Shopify store ─────────────

const LIVE_QUERY = 'query($ids: [ID!]!) { nodes(ids: $ids) { ... on ProductVariant { id price inventoryQuantity inventoryPolicy product { status publishedAt } } } }';
const LIVE_QUERY_NO_INVENTORY = 'query($ids: [ID!]!) { nodes(ids: $ids) { ... on ProductVariant { id price product { status publishedAt } } } }';

/**
 * Asks each brand's Shopify store for the CURRENT price / stock / availability of the cart's variants and updates the catalog snapshot.
 * Returns the human-readable changes (empty when the cart is exactly as shown). Throws when a store cannot be reached: we never sell blind.
 */
export const validateLive = async (lines, storesById) => {
  const changes = [];
  const byStore = new Map();
  for (const l of lines) byStore.set(l.store_id, [...(byStore.get(l.store_id) || []), l]);
  for (const [storeId, items] of byStore) {
    const store = storesById.get(storeId);
    let res;
    const ids = items.map((l) => gid('ProductVariant', l.shopify_variant_id));
    try {
      res = await shopifyGraphql(store, LIVE_QUERY, { ids });
    } catch (err) {
      if (/access denied|read_inventory|inventory/i.test(err.message || '')) res = await shopifyGraphql(store, LIVE_QUERY_NO_INVENTORY, { ids }).catch(() => null);
      else res = null;
      if (!res) throw new ConflictError(`We could not confirm the price and stock of ${items[0].brand.name}'s items right now. Please try again in a moment.`);
    }
    const live = new Map((res.nodes || []).filter(Boolean).map((n) => [String(n.id).split('/').pop(), n]));
    for (const l of items) {
      const n = live.get(String(l.shopify_variant_id));
      const live_ok = n && n.product?.status === 'ACTIVE' && n.product?.publishedAt;
      if (!live_ok) {
        changes.push(`${l.title} is no longer available.`);
        await supabaseAdmin.from('shop_variants').update({ in_stock: false }).eq('id', l.variant_id);
        continue;
      }
      const price = round2(n.price);
      const hasInv = Object.prototype.hasOwnProperty.call(n, 'inventoryQuantity');
      const qty = hasInv ? n.inventoryQuantity : null;
      const policy = hasInv ? n.inventoryPolicy : null;
      const inStock = !hasInv || policy === 'CONTINUE' || (qty ?? 0) > 0;
      const patch = { price, in_stock: inStock };
      if (hasInv) Object.assign(patch, { inventory_quantity: qty, inventory_policy: policy });
      await supabaseAdmin.from('shop_variants').update(patch).eq('id', l.variant_id);
      if (price !== l.unit_price) changes.push(`${l.title}: the price is now ${price.toFixed(2)} (was ${l.unit_price.toFixed(2)}).`);
      if (!inStock) changes.push(`${l.title} is out of stock.`);
      else if (hasInv && policy !== 'CONTINUE' && l.quantity > (qty ?? 0)) changes.push(`${l.title}: only ${qty} left (you asked for ${l.quantity}).`);
    }
  }
  return changes;
};

// ───────────── checkout ─────────────

const clean = (v) => String(v ?? '').trim();

export const validateAddress = (a) => {
  const address = { name: clean(a?.name), phone: clean(a?.phone), address1: clean(a?.address1), address2: clean(a?.address2), city: clean(a?.city), province: clean(a?.province), zip: clean(a?.zip), country_code: clean(a?.country_code).toUpperCase() };
  for (const [k, label] of [['name', 'name'], ['phone', 'phone number'], ['address1', 'address'], ['city', 'city']]) if (!address[k]) throw new BadRequestError(`Enter the delivery ${label}.`);
  if (!/^[A-Z]{2}$/.test(address.country_code)) throw new BadRequestError('Choose the delivery country.');
  if (address.phone.replace(/\D/g, '').length < 7) throw new BadRequestError('Enter a valid phone number.');
  return address;
};

/** The commission of one brand order, from the brand's CURRENT terms (copied onto the order, never recomputed later). */
export const commissionFor = (settings, subtotal) => {
  const model = settings?.commission_model === 'fixed' ? 'fixed' : 'percent';
  const rate = Number(settings?.commission_rate || 0);
  const fixed = Number(settings?.commission_fixed || 0);
  const raw = model === 'fixed' ? fixed : (subtotal * rate) / 100;
  return { commission_model: model, commission_rate: rate, commission_fixed: fixed, commission_amount: round2(Math.min(Math.max(raw, 0), subtotal)) };
};

const loadStores = async (ids) => {
  const { data } = await supabaseAdmin.from('shopify_stores').select('*').in('id', ids).eq('status', 'active');
  return new Map((data || []).map((s) => [s.id, s]));
};

const logEvent = (shopOrderId, text, brandOrderId = null) => supabaseAdmin.from('shop_order_events').insert({ shop_order_id: shopOrderId, brand_order_id: brandOrderId, text });

/** Earlier unpaid attempts of this customer are closed (and their payment cancelled) so a retry never leaves duplicate orders behind. */
const supersedeUnpaid = async (customerId) => {
  const { data } = await supabaseAdmin.from('shop_orders').select('id, payment_intent_id').eq('customer_id', customerId).in('payment_status', ['unpaid', 'failed']).is('cancelled_at', null);
  for (const o of data || []) {
    if (o.payment_intent_id) {
      try {
        const intent = await retrievePaymentIntent(o.payment_intent_id);
        if (intent.status === 'succeeded') continue; // paid after all: the webhook will settle it, do not close it
        await cancelPaymentIntent(o.payment_intent_id);
      } catch {
        /* an intent that cannot be cancelled is harmless: the order is closed here and a late payment is flagged by the webhook */
      }
    }
    await supabaseAdmin.from('shop_orders').update({ status: 'cancelled', cancelled_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq('id', o.id).in('payment_status', ['unpaid', 'failed']);
    await supabaseAdmin.from('shop_brand_orders').update({ state: 'cancelled', commission_status: 'reversed' }).eq('shop_order_id', o.id).in('state', ['pending']);
  }
};

export const paymentPayload = (order, intent) => ({
  clientSecret: intent.client_secret,
  paymentIntentId: intent.id,
  publishableKey: config.stripe.publishableKey,
  amount: Number(order.total),
  currency: order.currency,
  reference: order.reference,
});

const startPayment = async (order, customer) => {
  const minor = toMinorUnits(order.total, order.currency);
  if (order.payment_intent_id) {
    const existing = await retrievePaymentIntent(order.payment_intent_id).catch(() => null);
    if (existing && ['requires_payment_method', 'requires_confirmation', 'requires_action'].includes(existing.status) && existing.currency === String(order.currency).toLowerCase() && existing.amount === minor) {
      return existing;
    }
  }
  // a new intent for a retry (the old one is dead or for another amount); the key makes a double click return the same one
  const attempt = Number(order.attempts || 0) + 1;
  const { intent } = await createShopPaymentIntent({ order, customer, idempotencyKey: `shop-${order.id}-${attempt}-${order.payment_intent_id || 'first'}` });
  await supabaseAdmin.from('shop_orders').update({ payment_intent_id: intent.id, payment_status: 'unpaid', status: 'pending_payment', updated_at: new Date().toISOString() }).eq('id', order.id);
  await supabaseAdmin.from('shop_payments').upsert({ shop_order_id: order.id, provider_ref: intent.id, amount: order.total, currency: order.currency, status: 'pending' }, { onConflict: 'provider_ref' });
  return intent;
};

export const checkout = async ({ customerId, address, email }) => {
  if (!isStripeEnabled()) throw new BadRequestError('Payments are not available yet.');
  const shipTo = validateAddress(address);
  const { data: customer } = await supabaseAdmin.from('profiles').select('id, email, full_name').eq('id', customerId).single();
  const lines = await loadCartLines(customerId);
  if (!lines.length) throw new BadRequestError('Your cart is empty.');
  const blocking = lines.filter((l) => l.issue && !/price changed/.test(l.issue));
  if (blocking.length) throw new ConflictError(blocking.map((l) => `${l.title}: ${l.issue}`).join(' '), { changes: blocking.map((l) => `${l.title}: ${l.issue}`) });
  const storesById = await loadStores([...new Set(lines.map((l) => l.store_id))]);
  for (const l of lines) if (!storesById.has(l.store_id)) throw new ConflictError(`${l.brand.name} is not available right now.`);

  // everything is re-checked in the brands' own stores: the customer pays exactly what the brand charges now
  const changes = await validateLive(lines, storesById);
  const fresh = await loadCartLines(customerId);
  const stillPriceChanged = fresh.some((l) => l.issue && /price changed/.test(l.issue));
  if (changes.length || stillPriceChanged) {
    await acceptSeenPrices(customerId, fresh.filter((l) => l.available));
    throw new ConflictError(`${changes.length ? changes.join(' ') : 'Some prices changed.'} Your cart was updated: please review it and check out again.`, { changes });
  }
  const currency = fresh[0].currency;
  if (!currency || fresh.some((l) => l.currency !== currency)) throw new ConflictError('A cart can only hold items in one currency.');

  await supersedeUnpaid(customerId);

  // totals (per brand: items + that brand's flat shipping) and the parent order
  const byStore = new Map();
  for (const l of fresh) byStore.set(l.store_id, [...(byStore.get(l.store_id) || []), l]);
  const brandTotals = [...byStore.entries()].map(([storeId, items]) => {
    const settings = items[0].brand_settings;
    const subtotal = round2(items.reduce((a, i) => a + i.line_total, 0));
    const shipping = round2(settings?.shipping_flat || 0);
    return { storeId, items, subtotal, shipping, total: round2(subtotal + shipping), ...commissionFor(settings, subtotal) };
  });
  const subtotal = round2(brandTotals.reduce((a, b) => a + b.subtotal, 0));
  const shipping_total = round2(brandTotals.reduce((a, b) => a + b.shipping, 0));
  const total = round2(subtotal + shipping_total);

  const ref = await supabaseAdmin.rpc('next_shop_order_ref');
  if (ref.error) throw ref.error;
  const ins = await supabaseAdmin
    .from('shop_orders')
    .insert({ reference: ref.data, customer_id: customerId, email: clean(email) || customer.email, status: 'pending_payment', payment_status: 'unpaid', currency, subtotal, shipping_total, tax_total: 0, discount_total: 0, total, address: shipTo })
    .select('*')
    .single();
  if (ins.error) throw ins.error;
  const order = ins.data;
  for (const b of brandTotals) {
    const bo = await supabaseAdmin
      .from('shop_brand_orders')
      .insert({ shop_order_id: order.id, store_id: b.storeId, state: 'pending', subtotal: b.subtotal, shipping: b.shipping, total: b.total, commission_model: b.commission_model, commission_rate: b.commission_rate, commission_fixed: b.commission_fixed, commission_amount: b.commission_amount, brand_payable: round2(b.total - b.commission_amount), commission_status: 'estimated' })
      .select('id')
      .single();
    if (bo.error) throw bo.error;
    const items = b.items.map((i) => ({ shop_order_id: order.id, brand_order_id: bo.data.id, product_id: i.product_id, variant_id: i.variant_id, shopify_product_id: i.shopify_product_id, shopify_variant_id: i.shopify_variant_id, title: i.title, variant_title: i.variant_title, sku: i.sku, image_url: i.image_url, quantity: i.quantity, unit_price: i.unit_price, line_total: i.line_total }));
    const insItems = await supabaseAdmin.from('shop_order_items').insert(items);
    if (insItems.error) throw insItems.error;
  }
  await logEvent(order.id, `Order ${order.reference} placed; waiting for payment of ${total.toFixed(2)} ${currency}.`);
  let intent;
  try {
    intent = await startPayment(order, customer);
  } catch (err) {
    await supabaseAdmin.from('shop_orders').update({ status: 'cancelled', cancelled_at: new Date().toISOString() }).eq('id', order.id);
    throw err;
  }
  return { order: { id: order.id, reference: order.reference, total, currency }, payment: paymentPayload(order, intent) };
};

/** A fresh payment for an order whose payment failed (or was never completed). */
export const retryPayment = async ({ customerId, orderId }) => {
  const { data: order } = await supabaseAdmin.from('shop_orders').select('*').eq('id', orderId).eq('customer_id', customerId).maybeSingle();
  if (!order) throw new NotFoundError('Order not found.');
  if (order.payment_status === 'paid') throw new ConflictError('This order is already paid.');
  if (order.cancelled_at) throw new ConflictError('This order was closed. Start again from your cart.');
  const { data: customer } = await supabaseAdmin.from('profiles').select('id, email').eq('id', customerId).single();
  const intent = await startPayment({ ...order, attempts: (await supabaseAdmin.from('shop_payments').select('id', { count: 'exact', head: true }).eq('shop_order_id', order.id)).count || 0 }, customer);
  return { order: { id: order.id, reference: order.reference, total: Number(order.total), currency: order.currency }, payment: paymentPayload(order, intent) };
};
