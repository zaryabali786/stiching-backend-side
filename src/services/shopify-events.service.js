import { supabaseAdmin } from '../config/supabase.js';
import { normaliseShop } from './shopify.service.js';
import { getActiveStore, processOrderCancelled, processOrderCreate, processOrderUpdated } from './shopify-orders.service.js';
import { notifyAdmins } from './notification.service.js';
import { handleShopOrderWebhook, handleShopRefundWebhook } from './shop-orders.service.js';
import { markProductGone, syncOneProduct } from './shop-catalog.service.js';

/**
 * Shopify's webhook deliveries. A delivery is written down first (Shopify's own delivery id is unique, so a repeat is ignored), the
 * answer goes back to Shopify at once, and the work is done afterwards. A delivery that failed is tried again every few minutes.
 */

const MAX_ATTEMPTS = 6;
const RETRY_EVERY_MS = 5 * 60 * 1000;

/** Writes the delivery down. Returns the new row, or null when this delivery was already seen. */
export const recordWebhookEvent = async ({ webhookId, topic, shop, payload }) => {
  const { data, error } = await supabaseAdmin
    .from('shopify_webhook_events')
    .insert({ webhook_id: webhookId, topic, shop_domain: shop, payload, attempts: 0 })
    .select('*')
    .maybeSingle();
  if (error) {
    if (error.code === '23505') return null;
    throw error;
  }
  return data;
};

const uninstall = async (shop) => {
  await supabaseAdmin
    .from('shopify_stores')
    .update({ status: 'uninstalled', access_token_enc: null, uninstalled_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq('shop_domain', shop);
};

const handle = async (topic, shop, payload) => {
  switch (topic) {
    case 'orders/create': {
      const store = await getActiveStore(shop);
      if (!store) return { status: 'no_store' };
      // an order WE created for the Shop (dropshipping) is never a stitching order
      const shopOrder = await handleShopOrderWebhook(store, payload);
      return shopOrder.handled ? shopOrder : processOrderCreate(store, payload);
    }
    case 'orders/updated': {
      const store = await getActiveStore(shop);
      if (!store) return { status: 'no_store' };
      const shopOrder = await handleShopOrderWebhook(store, payload);
      return shopOrder.handled ? shopOrder : processOrderUpdated(store, payload);
    }
    case 'orders/cancelled': {
      const store = await getActiveStore(shop);
      if (!store) return { status: 'no_store' };
      const shopOrder = await handleShopOrderWebhook(store, payload);
      return shopOrder.handled ? shopOrder : processOrderCancelled(store, payload);
    }
    case 'refunds/create': {
      const store = await getActiveStore(shop);
      return store ? handleShopRefundWebhook(store, payload) : { status: 'no_store' };
    }
    case 'products/update': {
      const store = await getActiveStore(shop);
      return store ? syncOneProduct(store, payload.id) : { status: 'no_store' };
    }
    case 'products/delete': {
      const store = await getActiveStore(shop);
      return store ? markProductGone(store, payload.id) : { status: 'no_store' };
    }
    case 'app/uninstalled':
      await uninstall(shop);
      return { status: 'uninstalled' };
    // Shopify's privacy requests: the brand's customers are Stitch&Ship customers with their own accounts, so a person decides
    case 'customers/data_request':
    case 'customers/redact':
      await notifyAdmins({ type: 'alert', title: `Shopify privacy request (${topic})`, body: `${shop} sent a ${topic} request. Handle it as set out in your privacy policy.`, link: '/admin/shopify' });
      return { status: 'admin_notified' };
    case 'shop/redact':
      await uninstall(shop);
      await notifyAdmins({ type: 'alert', title: 'Shopify store data deletion', body: `${shop} asked for its data to be deleted. Its connection was removed; review its orders.`, link: '/admin/shopify' });
      return { status: 'admin_notified' };
    default:
      return { status: 'ignored' };
  }
};

/** Works on one recorded delivery. Safe to call again: the handlers are idempotent. */
export const processWebhookEvent = async (eventId) => {
  const { data: event } = await supabaseAdmin.from('shopify_webhook_events').select('*').eq('id', eventId).maybeSingle();
  if (!event || event.processed_at) return { status: 'done' };
  const tries = (Number(event.attempts) || 0) + 1;
  await supabaseAdmin.from('shopify_webhook_events').update({ attempts: tries }).eq('id', event.id);
  try {
    const shop = normaliseShop(event.shop_domain);
    const result = await handle(event.topic, shop, event.payload || {});
    // processed: the copy of the payload (it holds personal data) is not kept
    await supabaseAdmin.from('shopify_webhook_events').update({ processed_at: new Date().toISOString(), last_error: null, payload: null }).eq('id', event.id);
    return result;
  } catch (err) {
    const message = String(err?.message || err).slice(0, 500);
    await supabaseAdmin.from('shopify_webhook_events').update({ last_error: message }).eq('id', event.id);
    if (tries >= MAX_ATTEMPTS) {
      await notifyAdmins({ type: 'alert', title: `Shopify event failed (${event.topic})`, body: `${event.shop_domain}: ${message}`, link: '/admin/shopify' }).catch(() => undefined);
    }
    return { status: 'failed', error: message };
  }
};

let timer = null;

/** Every few minutes, run again the deliveries that failed (fewer than MAX_ATTEMPTS tries so far). */
export const retryOpenEvents = async () => {
  const before = new Date(Date.now() - 60_000).toISOString();
  const { data } = await supabaseAdmin.from('shopify_webhook_events').select('id, attempts').is('processed_at', null).lt('created_at', before).limit(50);
  for (const e of data || []) if ((Number(e.attempts) || 0) < MAX_ATTEMPTS) await processWebhookEvent(e.id);
};

export const startShopifyRetry = () => {
  if (timer) return;
  timer = setInterval(() => retryOpenEvents().catch((err) => console.warn('[Shopify] retry failed:', err.message)), RETRY_EVERY_MS);
  timer.unref?.();
};
