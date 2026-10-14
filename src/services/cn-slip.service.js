const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/**
 * A printable slip per parcel for any courier: courier, CN (large), who it goes to and the order. Self-contained HTML (no scripts from outside),
 * one slip per page, with a Print button. Every value is escaped.
 * @param {{ courier: string, cn: string, order: string, customer: string, code?: string, phone?: string, address?: string, city?: string, weight?: number|null }[]} items
 */
export const cnSlipsHtml = (items) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" /><title>CN slips</title>
<style>
  body { font: 14px/1.45 system-ui, sans-serif; margin: 0; padding: 16px; color: #111; background: #f3f3f5; }
  .bar { position: sticky; top: 0; display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px; }
  button { font: inherit; padding: 8px 18px; border: 0; border-radius: 999px; background: #111; color: #fff; cursor: pointer; }
  .slip { width: 100mm; min-height: 140mm; margin: 0 auto 14px; padding: 8mm; background: #fff; border: 2px solid #111; border-radius: 6px; box-sizing: border-box; page-break-after: always; break-after: page; }
  .courier { font-size: 13px; letter-spacing: .12em; text-transform: uppercase; color: #444; }
  .cn { font: 700 24px/1.2 ui-monospace, Consolas, monospace; letter-spacing: .06em; margin: 4px 0 10px; word-break: break-all; }
  .to { border-top: 2px dashed #999; padding-top: 8px; margin-top: 8px; }
  .k { font-size: 11px; text-transform: uppercase; letter-spacing: .1em; color: #666; margin-top: 8px; }
  .v { font-size: 16px; font-weight: 600; }
  @media print { body { background: #fff; padding: 0; } .bar { display: none; } .slip { margin: 0 auto; border-radius: 0; } @page { margin: 6mm; } }
</style></head><body>
<div class="bar"><b>${items.length} CN slip${items.length === 1 ? '' : 's'}</b><button onclick="window.print()">Print</button></div>
${items.map((i) => `<section class="slip">
  <div class="courier">${esc(i.courier)}</div>
  <div class="cn">${esc(i.cn)}</div>
  <div class="k">Order</div><div class="v">${esc(i.order)}${i.code ? ` · ${esc(i.code)}` : ''}</div>
  <div class="to">
    <div class="k">Deliver to</div><div class="v">${esc(i.customer)}</div>
    ${i.phone ? `<div class="v">${esc(i.phone)}</div>` : ''}
    <div>${esc(i.address)}</div><div class="v">${esc(i.city)}</div>
  </div>
  ${i.weight ? `<div class="k">Weight</div><div class="v">${esc(i.weight)} kg</div>` : ''}
</section>`).join('\n')}
</body></html>`;
