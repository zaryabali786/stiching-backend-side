import { supabaseAdmin } from '../config/supabase.js';
import { BadRequestError, ForbiddenError, NotFoundError } from '../utils/error.helper.js';
import { unwrap, round2 } from '../utils/db.js';
import { decodeDataUrl, uploadDocumentBuffer, withSignedUrl, removeStoredFile } from './storage.service.js';
import { addEvent } from './order.service.js';

/**
 * Extra materials a partner buys while an article is being cut or stitched (lining, buttons, lace ...), with the supplier bill.
 * They are kept apart from the customer's own prices. The admin reviews each one (approve / reject) on the invoice screen;
 * only approved ones are added to the customer invoice, once (invoice_lines.extra_cost_id is unique).
 */

/** Statuses of an order while extra items can still be added. */
const OPEN_ORDER = ['received', 'assigned', 'cutting', 'stitching', 'qc_passed', 'customer_approval'];
const ADD_STAGES = ['cutting', 'stitching'];

const cleanText = (v, max) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

/** Validate what the partner typed. total = quantity x price, always computed here. */
export const parseExtraInput = (body, { partial = false } = {}) => {
  const out = {};
  if (!partial || body.name !== undefined) {
    out.name = cleanText(body.name, 160);
    if (!out.name) throw new BadRequestError('Enter the item or material name.');
  }
  if (!partial || body.quantity !== undefined) {
    const q = Number(body.quantity);
    if (!(q > 0) || q > 100000) throw new BadRequestError('Enter a quantity above 0.');
    out.quantity = Math.round(q * 100) / 100;
  }
  if (!partial || body.unit_price !== undefined) {
    const p = Number(body.unit_price);
    if (!(p >= 0) || p > 10000000 || body.unit_price === '' || body.unit_price === null) throw new BadRequestError('Enter the price per item (0 or more).');
    out.unit_price = round2(p);
  }
  if (body.notes !== undefined) out.notes = cleanText(body.notes, 500) || null;
  return out;
};

const storeBill = async (orderId, bill) => {
  if (!bill?.dataUrl) return null;
  const { mime, buffer } = decodeDataUrl(bill.dataUrl);
  return uploadDocumentBuffer(`extra-costs/${orderId}`, buffer, mime, bill.name || 'bill');
};

/** The table comes with database update 0038. */
const missingTable = (error) => /order_extra_costs/.test(error?.message || '') && /(schema cache|does not exist|relation)/i.test(error?.message || '');

const withBill = async (row) => ({ ...row, bill: await withSignedUrl(row.bill) });

/** All extra items of an order, with a short-lived link to each supplier bill. */
export const listExtraCosts = async (orderId) => {
  const { data, error } = await supabaseAdmin.from('order_extra_costs').select('*').eq('order_id', orderId).order('created_at', { ascending: true });
  if (error && missingTable(error)) return []; // database update 0038 is not applied yet: nothing to show
  return Promise.all(unwrap({ data, error }).map(withBill));
};

/**
 * Add one extra item. A repeated submit with the same client_key returns the entry that already exists.
 * @returns {Promise<{ cost: object, duplicate: boolean }>}
 */
export const createExtraCost = async ({ orderId, body, profile, userId }) => {
  const order = unwrap(await supabaseAdmin.from('orders').select('id, reference, status, partner_id, order_kind').eq('id', orderId).maybeSingle());
  if (!order) throw new NotFoundError('Order not found');
  if (order.order_kind === 'return') throw new BadRequestError('Extra items are added to the order being made, not to a return.');
  if (!OPEN_ORDER.includes(order.status)) throw new BadRequestError(`Order ${order.reference} is ${order.status.replace(/_/g, ' ')}: extra items can no longer be added.`);

  const probe = await supabaseAdmin.from('order_extra_costs').select('id').limit(1);
  if (probe.error && missingTable(probe.error)) throw new BadRequestError('Extra items need a database update (0038_extra_costs.sql). Ask the admin to run it, then try again.');

  const clientKey = cleanText(body.client_key, 64) || null;
  if (clientKey) {
    const existing = unwrap(await supabaseAdmin.from('order_extra_costs').select('*').eq('order_id', orderId).eq('client_key', clientKey).maybeSingle());
    if (existing) return { cost: await withBill(existing), duplicate: true };
  }

  // the item belongs to an article that is being cut or stitched right now
  const cards = unwrap(await supabaseAdmin.from('job_cards').select('id, unit_id, stage').eq('order_id', orderId));
  const active = cards.filter((c) => ADD_STAGES.includes(c.stage));
  if (!active.length) throw new BadRequestError('Extra items can be added while an article of this order is in Cutting or Stitching.');
  const unitId = body.unit_id && active.some((c) => c.unit_id === body.unit_id) ? body.unit_id : null;
  const stage = (unitId ? active.find((c) => c.unit_id === unitId) : active[0]).stage;

  const input = parseExtraInput(body);
  const bill = await storeBill(orderId, body.bill);
  const row = {
    order_id: orderId,
    unit_id: unitId,
    partner_id: order.partner_id,
    stage,
    name: input.name,
    quantity: input.quantity,
    unit_price: input.unit_price,
    total_pkr: round2(input.quantity * input.unit_price),
    notes: input.notes ?? null,
    bill,
    status: 'pending',
    client_key: clientKey,
    added_by: userId ?? null,
    added_by_name: profile?.full_name || null,
    updated_at: new Date().toISOString(),
  };
  const { data, error } = await supabaseAdmin.from('order_extra_costs').insert(row).select('*').single();
  if (error) {
    if (error.code === '23505' && clientKey) {
      const again = unwrap(await supabaseAdmin.from('order_extra_costs').select('*').eq('order_id', orderId).eq('client_key', clientKey).maybeSingle());
      if (again) return { cost: await withBill(again), duplicate: true };
    }
    throw error;
  }
  await addEvent(orderId, order.status, `Extra item added during ${stage}: ${row.name} × ${row.quantity}`, userId ?? null);
  return { cost: await withBill(data), duplicate: false };
};

const loadOwned = async (id, access) => {
  const row = unwrap(await supabaseAdmin.from('order_extra_costs').select('*').eq('id', id).maybeSingle());
  if (!row) throw new NotFoundError('Extra item not found');
  if (!access?.isAdmin && row.partner_id !== access?.partnerId) throw new ForbiddenError('This item belongs to another partner.');
  return row;
};

/** Edit an item the admin has not decided on yet. */
export const updateExtraCost = async ({ id, body, access, userId }) => {
  const row = await loadOwned(id, access);
  if (row.status !== 'pending') throw new BadRequestError(`This item was ${row.status}: it can no longer be changed.`);
  const input = parseExtraInput(body, { partial: true });
  const patch = { ...input, updated_at: new Date().toISOString() };
  const quantity = input.quantity ?? Number(row.quantity);
  const price = input.unit_price ?? Number(row.unit_price);
  patch.total_pkr = round2(quantity * price);
  if (body.bill?.dataUrl) {
    patch.bill = await storeBill(row.order_id, body.bill);
    if (row.bill?.path) await removeStoredFile('documents', row.bill.path).catch(() => {});
  } else if (body.remove_bill === true && row.bill?.path) {
    await removeStoredFile('documents', row.bill.path).catch(() => {});
    patch.bill = null;
  }
  const saved = unwrap(await supabaseAdmin.from('order_extra_costs').update(patch).eq('id', id).select('*').single());
  await addEvent(row.order_id, 'received', `Extra item changed: ${saved.name}`, userId ?? null).catch(() => {});
  return withBill(saved);
};

/** Remove an item the admin has not decided on yet. */
export const deleteExtraCost = async ({ id, access }) => {
  const row = await loadOwned(id, access);
  if (row.status !== 'pending') throw new BadRequestError(`This item was ${row.status}: it can no longer be removed.`);
  unwrap(await supabaseAdmin.from('order_extra_costs').delete().eq('id', id));
  if (row.bill?.path) await removeStoredFile('documents', row.bill.path).catch(() => {});
  return { id };
};

/** The admin approves or rejects an item. Once it is on an invoice it cannot be rejected until its line is removed. */
export const decideExtraCost = async ({ id, decision, note, userId }) => {
  if (!['approve', 'reject'].includes(decision)) throw new BadRequestError('Choose approve or reject.');
  const row = unwrap(await supabaseAdmin.from('order_extra_costs').select('*').eq('id', id).maybeSingle());
  if (!row) throw new NotFoundError('Extra item not found');
  const onInvoice = unwrap(await supabaseAdmin.from('invoice_lines').select('id, invoice_id').eq('extra_cost_id', id).maybeSingle());
  if (decision === 'reject' && onInvoice) throw new BadRequestError('This item is on the invoice. Remove its line from the invoice first.');
  const patch = {
    status: decision === 'approve' ? 'approved' : 'rejected',
    decision_note: cleanText(note, 300) || null,
    decided_by: userId ?? null,
    decided_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  const saved = unwrap(await supabaseAdmin.from('order_extra_costs').update(patch).eq('id', id).select('*').single());
  return withBill(saved);
};

/** The invoice line of an approved item: the customer pays the cost, and the partner is paid back what they spent. */
export const extraCostLine = (c) => ({
  kind: 'other',
  label: `Extra material · ${c.name}`.slice(0, 160),
  description: `${Number(c.quantity)} × PKR ${Number(c.unit_price)}${c.notes ? ` · ${c.notes}` : ''}`.slice(0, 300),
  quantity: 1,
  customer_amount: Number(c.total_pkr),
  partner_amount: Number(c.total_pkr),
  extra_cost_id: c.id,
});
