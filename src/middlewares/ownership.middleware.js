import { supabaseAdmin } from '../config/supabase.js';
import { ForbiddenError, NotFoundError } from '../utils/error.helper.js';
import { ownsPartnerRow } from '../services/access.service.js';

/**
 * Tenant guards: a partner user may only act on rows of their own partner, whatever id they put in the URL.
 * Admins pass. Use after `authenticate` on any route that takes the id of an order, piece, ticket, team member, ...
 *
 *   router.post('/production/cards/:id/assign', ownsCard(), assignCard)
 *
 * A record that does not exist answers 404; one that belongs to another partner answers 403.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const guard = (label, lookup) => (param = 'id') => Object.assign(async (req, res, next) => {
  try {
    const id = req.params[param];
    if (!UUID.test(String(id || ''))) throw new NotFoundError(`${label} not found`);
    if (req.access?.isAdmin) return next();
    const partnerId = await lookup(id);
    if (partnerId === undefined) throw new NotFoundError(`${label} not found`);
    if (!ownsPartnerRow(req.access, partnerId)) throw new ForbiddenError(`This ${label.toLowerCase()} belongs to another partner.`);
    next();
  } catch (err) {
    next(err);
  }
}, { guard: { type: 'owns', entity: label, param } });

const partnerOf = (table) => async (id) => {
  const { data } = await supabaseAdmin.from(table).select('partner_id').eq('id', id).maybeSingle();
  return data ? data.partner_id : undefined;
};

export const ownsOrder = guard('Order', partnerOf('orders'));
export const ownsCard = guard('Ticket', partnerOf('job_cards'));
export const ownsMember = guard('Team member', partnerOf('team_members'));
export const ownsTransfer = guard('Transfer', partnerOf('transfers'));
export const ownsParcel = guard('Parcel', partnerOf('unmatched_parcels'));
export const ownsUnit = guard('Piece', async (id) => {
  const { data } = await supabaseAdmin.from('order_units').select('order:orders!order_units_order_id_fkey(partner_id)').eq('id', id).maybeSingle();
  if (!data) return undefined;
  const order = Array.isArray(data.order) ? data.order[0] : data.order;
  return order ? order.partner_id : undefined;
});

/**
 * Admin partner switcher: while an admin works inside one partner (`X-Partner-Id`), an order id from another partner is
 * refused too, so the two never get mixed. No effect without a selected partner or for partner users (use ownsOrder).
 */
export const inActivePartnerOrder = (param = 'id') => Object.assign(async (req, res, next) => {
  try {
    const active = req.access?.isAdmin ? req.access.activePartnerId : null;
    if (!active) return next();
    const id = req.params[param];
    if (!UUID.test(String(id || ''))) throw new NotFoundError('Order not found');
    const partnerId = await partnerOf('orders')(id);
    if (partnerId === undefined) throw new NotFoundError('Order not found');
    if (partnerId !== active) throw new ForbiddenError('This order belongs to another partner than the one you selected.');
    next();
  } catch (err) {
    next(err);
  }
}, { guard: { type: 'active-partner', entity: 'Order', param } });
