import { supabaseAdmin } from '../config/supabase.js';
import { BadRequestError } from '../utils/error.helper.js';
import { unwrap } from '../utils/db.js';

/**
 * Validation and lookups for creating / editing a customer order. Everything the form sends is
 * re-checked here (the frontend is never trusted): brand, courier, tracking, international shipping,
 * and the article choices for each piece.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (v) => UUID.test(String(v || ''));

/** International => Express, otherwise Standard. The customer never picks the shipping type directly. */
export const shippingServiceFor = (international) => (international ? 'express' : 'standard');

const toBool = (v) => (v === true || v === 'true' ? true : v === false || v === 'false' ? false : null);

/**
 * @param {object} body request body
 * @param {{ order?: object }} [opts] when editing, the brand/courier already on the order stays valid even if switched off since
 * @returns the order columns derived from brand / courier / tracking / shipping
 */
export const resolveOrderRefs = async (body, { order = null } = {}) => {
  if (!isUuid(body.brand_id)) throw new BadRequestError('Choose the brand you ordered from.');
  if (!isUuid(body.courier_id)) throw new BadRequestError('Choose the courier that is delivering your parcel to us.');
  const international = toBool(body.international_shipping);
  if (international === null) throw new BadRequestError('Tell us whether this order ships internationally (Yes or No).');

  const [brandRes, courierRes] = await Promise.all([
    supabaseAdmin.from('brands').select('id, name, status').eq('id', body.brand_id).maybeSingle(),
    supabaseAdmin.from('couriers').select('id, name, status, requires_tracking').eq('id', body.courier_id).maybeSingle(),
  ]);
  const brand = unwrap(brandRes, 'Could not check the brand');
  const courier = unwrap(courierRes, 'Could not check the courier');
  if (!brand || (brand.status !== 'active' && order?.brand_id !== brand.id)) throw new BadRequestError('That brand is not available. Choose another.');
  if (!courier || (courier.status !== 'active' && order?.courier_id !== courier.id)) throw new BadRequestError('That courier is not available. Choose another.');

  const tracking = String(body.tracking_number ?? '').trim();
  if (courier.requires_tracking && !tracking) throw new BadRequestError(`Enter the ${courier.name} tracking number.`);
  if (tracking.length > 60) throw new BadRequestError('The tracking number is too long.');

  return {
    brand_id: brand.id,
    brand: brand.name, // the name is kept on the order for lists and search; renames follow the brand
    courier_id: courier.id,
    tracking_number: tracking || null,
    international_shipping: international,
    shipping_service: shippingServiceFor(international),
  };
};

/**
 * Check every article picked for the pieces of an order.
 * Each piece may have at most one article per article type; articles and their type must be active
 * (an article the piece already had stays allowed even if it was switched off later).
 *
 * @param {{ article_ids?: string[] }[]} rawUnits
 * @param {Set<string>[]} [alreadyPicked] per piece, the article ids it already has (edit)
 * @returns {{ rows: { article_type_id: string, article_id: string }[], design: Record<string,string> }[]} per piece
 */
export const resolveUnitArticles = async (rawUnits, alreadyPicked = [], partnerId = null) => {
  const wanted = rawUnits.map((u) => {
    const ids = Array.isArray(u.article_ids) ? u.article_ids : [];
    if (ids.length > 40) throw new BadRequestError('Too many article choices for one piece.');
    if (ids.some((id) => !isUuid(id))) throw new BadRequestError('One of the selected articles is not valid.');
    return [...new Set(ids)];
  });
  const all = [...new Set(wanted.flat())];
  if (!all.length) return wanted.map(() => ({ rows: [], design: {} }));

  const found = unwrap(
    await supabaseAdmin.from('articles').select('id, name, status, article_type_id, partner_id, type:article_types(id, name, status, partner_id)').in('id', all),
    'Could not check the selected articles'
  );
  const byId = new Map(found.map((a) => [a.id, a]));

  return wanted.map((ids, i) => {
    const seenTypes = new Set();
    const rows = [];
    const design = {};
    for (const id of ids) {
      const article = byId.get(id);
      if (!article) throw new BadRequestError('One of the selected articles no longer exists. Please choose again.');
      const type = Array.isArray(article.type) ? article.type[0] : article.type;
      const keptFromBefore = alreadyPicked[i]?.has(id);
      if (!keptFromBefore && (article.status !== 'active' || type?.status !== 'active')) {
        throw new BadRequestError(`"${article.name}" is not available any more. Please choose again.`);
      }
      // a partner only offers its own articles and the shared ones
      if (partnerId && ((article.partner_id && article.partner_id !== partnerId) || (type?.partner_id && type.partner_id !== partnerId))) {
        throw new BadRequestError(`"${article.name}" is not offered by the partner you chose. Please choose again.`);
      }
      if (seenTypes.has(article.article_type_id)) throw new BadRequestError(`Choose only one ${type?.name || 'option'} per piece.`);
      seenTypes.add(article.article_type_id);
      rows.push({ article_type_id: article.article_type_id, article_id: article.id });
      // the older `design` field keeps feeding the partner screens: { neckline: 'Round', ... }
      design[String(type?.name || 'option').trim().toLowerCase().replace(/\s+/g, '_')] = article.name;
    }
    return { rows, design };
  });
};

/** Replace the article choices of one piece. */
export const saveUnitArticles = async (unitId, rows) => {
  unwrap(await supabaseAdmin.from('order_unit_articles').delete().eq('unit_id', unitId), 'Could not update the article choices');
  if (!rows.length) return;
  unwrap(await supabaseAdmin.from('order_unit_articles').insert(rows.map((r) => ({ ...r, unit_id: unitId }))), 'Could not save the article choices');
};

/**
 * The stitching partner the customer chose. Returns its id, or null when the customer left it to the platform
 * ("auto" / nothing): the assignment rule set by the admin then picks one when the order is submitted.
 */
export const resolveOrderPartner = async (value) => {
  if (value === undefined || value === null || value === '' || value === 'auto') return null;
  if (!isUuid(value)) throw new BadRequestError('Choose a valid stitching partner.');
  const partner = unwrap(await supabaseAdmin.from('partners').select('id, status, is_listed, permissions').eq('id', value).maybeSingle(), 'Could not check the partner');
  if (!partner || partner.status !== 'active' || !partner.is_listed || !(partner.permissions || []).includes('receiving.view')) {
    throw new BadRequestError('That partner is not taking orders right now. Please choose another.');
  }
  return partner.id;
};
