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

/**
 * Whether a destination country is outside Pakistan (null when the country is not known). The customer is never asked: the shipping
 * type follows the delivery address.
 */
export const internationalFromCountry = (country) => {
  const c = String(country ?? '').trim().toLowerCase();
  return c ? c !== 'pakistan' : null;
};

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
  // no question is asked any more: an explicit value (older clients) wins, otherwise the delivery country decides, otherwise domestic
  const international = toBool(body.international_shipping) ?? internationalFromCountry(body.destination_country) ?? false;

  const hasCourier = body.courier_id !== undefined && body.courier_id !== null && body.courier_id !== '';
  if (hasCourier && !isUuid(body.courier_id)) throw new BadRequestError('That courier is not valid. Choose another.');

  const [brandRes, courierRes] = await Promise.all([
    supabaseAdmin.from('brands').select('id, name, status').eq('id', body.brand_id).maybeSingle(),
    hasCourier ? supabaseAdmin.from('couriers').select('id, name, status, requires_tracking').eq('id', body.courier_id).maybeSingle() : Promise.resolve({ data: null, error: null }),
  ]);
  const brand = unwrap(brandRes, 'Could not check the brand');
  const courier = unwrap(courierRes, 'Could not check the courier');
  if (!brand || (brand.status !== 'active' && order?.brand_id !== brand.id)) throw new BadRequestError('That brand is not available. Choose another.');
  if (hasCourier && (!courier || (courier.status !== 'active' && order?.courier_id !== courier.id))) throw new BadRequestError('That courier is not available. Choose another.');

  // Courier and tracking are optional: they can be added later by the customer, the admin, or a follow-up shipping email.
  const tracking = String(body.tracking_number ?? '').trim();
  if (tracking.length > 60) throw new BadRequestError('The tracking number is too long.');

  return {
    brand_id: brand.id,
    brand: brand.name, // the name is kept on the order for lists and search; renames follow the brand
    courier_id: courier?.id ?? null,
    // a courier picked from the list replaces any name that was only read from an email
    ...(courier ? { courier_name: null } : {}),
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
      // a partner only offers its own articles; an order with no partner yet (at the central location) uses the shared set,
      // so whichever partner the admin picks later can make it (a piece an order already had stays valid)
      if (!keptFromBefore) {
        const owner = partnerId ?? null;
        const typeOwner = type?.partner_id ?? null;
        if (article.partner_id !== owner || (typeOwner !== null && typeOwner !== owner)) {
          throw new BadRequestError(owner ? `"${article.name}" is not offered by this order's partner. Please choose again.` : `"${article.name}" is not in the standard set. Please choose again.`);
        }
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
