import { supabaseAdmin } from '../config/supabase.js';
import { BadRequestError } from '../utils/error.helper.js';
import { unwrap } from '../utils/db.js';

/**
 * Article weights. The partner enters each article's weight (kg) in Receiving; the shipment weight used for the invoice's shipping price is
 * the SUM of the weights of the articles the shipment covers. A missing weight is never treated as 0: the article is named so it can be
 * completed in Receiving first. Orders that predate article weights keep the weight they were given (orders.weight_kg).
 */

const round3 = (n) => Math.round(n * 1000) / 1000;

/** Validate a weight typed in kg. Returns a number (at most 3 decimals) or throws. */
export const parseWeight = (value) => {
  const kg = Number(value);
  if (value === '' || value === null || value === undefined || !Number.isFinite(kg) || !(kg > 0 && kg < 50)) {
    throw new BadRequestError('Enter the article weight in kg, more than 0 and less than 50 (for example 0.65).');
  }
  return round3(kg);
};

/**
 * What the shipment of this order weighs.
 *   - a return order ships ONE article (return_unit_id): that article's weight
 *   - otherwise every article of the order (an order split by a Hold/Return keeps only its own articles)
 * @returns {Promise<{ total_kg: number|null, missing: {id:string,title:string,code:string|null}[], units: object[], source: 'articles'|'order'|'none' }>}
 */
export const orderWeightInfo = async (order) => {
  const unitQuery = order.order_kind === 'return' && order.return_unit_id
    ? supabaseAdmin.from('order_units').select('id, code, unit_title, line_no, weight_kg').eq('id', order.return_unit_id)
    : supabaseAdmin.from('order_units').select('id, code, unit_title, line_no, weight_kg, review_status').eq('order_id', order.id);
  // an article the customer rejected leaves on its own (return / hold): it is not part of this order's shipment
  const units = (unwrap(await unitQuery) || []).filter((u) => u.review_status !== 'rejected').sort((a, b) => (a.line_no || 0) - (b.line_no || 0));
  const missing = units.filter((u) => !(Number(u.weight_kg) > 0)).map((u) => ({ id: u.id, title: u.unit_title, code: u.code || null }));
  const weighed = units.length - missing.length;
  if (units.length && !missing.length) {
    return { total_kg: round3(units.reduce((a, u) => a + Number(u.weight_kg), 0)), missing, units, source: 'articles' };
  }
  // old order: no article has a weight yet, but the order itself carries one
  if (!weighed && Number(order.weight_kg) > 0) return { total_kg: Number(order.weight_kg), missing: [], units, source: 'order' };
  return { total_kg: null, missing, units, source: 'none' };
};

/** "Add the weight of Lawn 3pc (SA-1-1) and Kurta in Receiving first." */
export const missingWeightMessage = (info) =>
  `Add the weight in Receiving first for: ${info.missing.map((m) => (m.code ? `${m.title} (${m.code})` : m.title)).join(', ')}.`;

/** Throws when the shipment weight is not complete yet; otherwise returns the total. */
export const requireOrderWeight = async (order) => {
  const info = await orderWeightInfo(order);
  if (info.total_kg == null) throw new BadRequestError(info.missing.length ? missingWeightMessage(info) : 'This order has no articles to weigh.');
  return info;
};

/** Keep orders.weight_kg (read by the Warehouse, couriers and loadsheets) equal to the total of the article weights. */
export const syncOrderWeight = async (order) => {
  const info = await orderWeightInfo(order);
  if (info.source === 'articles') {
    unwrap(await supabaseAdmin.from('orders').update({ weight_kg: info.total_kg, updated_at: new Date().toISOString() }).eq('id', order.id));
  }
  return info;
};

/** Save one article's weight and refresh the order's total. */
export const saveUnitWeight = async ({ unit, order, weight }) => {
  const kg = parseWeight(weight);
  unwrap(await supabaseAdmin.from('order_units').update({ weight_kg: kg, updated_at: new Date().toISOString() }).eq('id', unit.id));
  const info = await syncOrderWeight(order);
  return { weight_kg: kg, order_weight_kg: info.total_kg };
};
