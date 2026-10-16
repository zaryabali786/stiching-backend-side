import QRCode from 'qrcode';
import { supabaseAdmin } from '../config/supabase.js';
import { unwrap } from '../utils/db.js';
import { routedUnitIds } from './return-order.service.js';

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/**
 * The articles of some orders: Map(orderId -> [{ code, title, quantity, brand }]).
 * A return order carries the one article it returns (return_unit_id); every other order lists its own articles.
 */
export const loadOrderArticles = async (orders) => {
  const out = new Map(orders.map((o) => [o.id, []]));
  const own = orders.filter((o) => !(o.order_kind === 'return' && o.return_unit_id));
  const returns = orders.filter((o) => o.order_kind === 'return' && o.return_unit_id);
  if (own.length) {
    const rows = unwrap(await supabaseAdmin.from('order_units').select('*').in('order_id', own.map((o) => o.id)).order('line_no'));
    // an article already sent to the Warehouse on its own return order is listed there, not on the original
    const routed = await routedUnitIds(rows.map((u) => u.id));
    for (const u of rows) if (!routed.has(u.id)) out.get(u.order_id)?.push(u);
  }
  if (returns.length) {
    const rows = unwrap(await supabaseAdmin.from('order_units').select('*').in('id', returns.map((o) => o.return_unit_id)));
    for (const o of returns) {
      const u = rows.find((r) => r.id === o.return_unit_id);
      if (u) out.get(o.id).push(u);
    }
  }
  const byOrder = new Map(orders.map((o) => [o.id, o]));
  for (const [orderId, list] of out) {
    const order = byOrder.get(orderId);
    out.set(orderId, list.map((u, i) => ({
      code: u.code || `${order.reference}-${u.line_no ?? i + 1}`,
      title: u.unit_title || 'Article',
      quantity: Number(u.quantity) || 1,
      brand: u.brand || order.brand || '',
    })));
  }
  return out;
};

/** The remarks printed on a CN: "<article code> X <qty>", several articles separated by a comma. */
export const cnRemarks = (articles) => (articles || []).map((a) => `${a.code} X ${a.quantity}`).join(', ').slice(0, 250);

const qrSvg = (text) => QRCode.toString(String(text), { type: 'svg', margin: 0, errorCorrectionLevel: 'M' });

/**
 * A printable order list for the warehouse team: every order with its QR code, and every article with its code, name, quantity,
 * brand and its own QR code. Self-contained HTML (QR codes are inline SVG), all values escaped.
 * @param {{ order: object, articles: object[] }[]} items
 */
export const orderListHtml = async (items, { title = 'Orders to send' } = {}) => {
  const blocks = [];
  let articleCount = 0;
  for (const { order, articles } of items) {
    const orderQr = await qrSvg(order.reference);
    const rows = [];
    for (const a of articles) {
      articleCount += a.quantity;
      rows.push(`<tr><td class="qr">${await qrSvg(a.code)}</td><td class="mono">${esc(a.code)}</td><td>${esc(a.title)}</td><td class="num">${esc(a.quantity)}</td><td>${esc(a.brand || '—')}</td></tr>`);
    }
    blocks.push(`<section class="order">
  <div class="head">
    <div class="qr big">${orderQr}</div>
    <div class="info">
      <div class="ref">${esc(order.reference)}${order.order_kind === 'return' ? ' <span class="tag">Return</span>' : ''}</div>
      <div>${esc(order.customer_name || '—')}${order.customer_code ? ` · ${esc(order.customer_code)}` : ''}</div>
      <div class="muted">${esc([order.destination_city, order.destination_country].filter(Boolean).join(', ') || '—')}${order.shipping_service ? ` · ${esc(order.shipping_service)}` : ''}${order.weight_kg ? ` · ${esc(order.weight_kg)} kg` : ''}</div>
      ${order.brand ? `<div class="muted">Brand: ${esc(order.brand)}</div>` : ''}
    </div>
  </div>
  <table>
    <thead><tr><th>QR</th><th>Article code</th><th>Article name</th><th class="num">Qty</th><th>Brand</th></tr></thead>
    <tbody>${rows.join('') || '<tr><td colspan="5" class="muted">No articles on this order.</td></tr>'}</tbody>
  </table>
</section>`);
  }
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" /><title>${esc(title)}</title>
<style>
  body { font: 13px/1.45 system-ui, sans-serif; margin: 0; padding: 16px; color: #111; background: #f3f3f5; }
  .bar { display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px; max-width: 900px; margin-inline: auto; }
  button { font: inherit; padding: 8px 18px; border: 0; border-radius: 999px; background: #111; color: #fff; cursor: pointer; }
  .order { max-width: 900px; margin: 0 auto 14px; padding: 14px 16px; background: #fff; border: 1px solid #ddd; border-radius: 8px; break-inside: avoid; }
  .head { display: flex; gap: 14px; align-items: center; margin-bottom: 10px; }
  .ref { font-size: 20px; font-weight: 700; }
  .tag { font-size: 11px; padding: 1px 8px; border-radius: 999px; background: #eee; vertical-align: middle; }
  .muted { color: #666; }
  table { width: 100%; border-collapse: collapse; }
  th, td { text-align: left; padding: 6px 8px; border-top: 1px solid #e5e5e5; vertical-align: middle; }
  th { font-size: 11px; text-transform: uppercase; letter-spacing: .08em; color: #666; }
  .num { text-align: right; width: 48px; }
  .mono { font-family: ui-monospace, Consolas, monospace; font-weight: 600; }
  .qr svg { width: 54px; height: 54px; display: block; }
  .qr.big svg { width: 84px; height: 84px; }
  td.qr { width: 64px; }
  @media print { body { background: #fff; padding: 0; } .bar button { display: none; } .order { border-radius: 0; margin-bottom: 8px; } @page { margin: 8mm; } }
</style></head><body>
<div class="bar"><b>${esc(title)} · ${items.length} order${items.length === 1 ? '' : 's'} · ${articleCount} article${articleCount === 1 ? '' : 's'} · ${esc(new Date().toISOString().slice(0, 10))}</b><button onclick="window.print()">Print</button></div>
${blocks.join('\n')}
</body></html>`;
};
