import { supabaseAdmin } from '../config/supabase.js';
import { unwrap } from '../utils/db.js';

const key = (s) => String(s || '').trim().toLowerCase();

/**
 * Every partner has its own articles. The "standard set" (types and articles with no partner, made before partners had their
 * own catalogue) only serves as a template: this copies it into one partner's own catalogue, price and all, skipping
 * whatever the partner already has. Safe to run more than once.
 * @returns {{ typesAdded: number, articlesAdded: number }}
 */
export const copyStandardCatalogue = async (partnerId) => {
  const types = unwrap(await supabaseAdmin.from('article_types').select('id, name, status, sort_order').is('partner_id', null), 'Could not read the standard set');
  const shared = unwrap(
    await supabaseAdmin.from('articles').select('article_type_id, name, image_url, customer_price, partner_cost, status, sort_order').is('partner_id', null),
    'Could not read the standard articles'
  );
  const own = unwrap(await supabaseAdmin.from('article_types').select('id, name').eq('partner_id', partnerId), 'Could not read your article types');
  const ownByName = new Map(own.map((t) => [key(t.name), t.id]));

  let typesAdded = 0;
  let articlesAdded = 0;
  for (const type of types) {
    let ownId = ownByName.get(key(type.name));
    if (!ownId) {
      const created = unwrap(
        await supabaseAdmin.from('article_types').insert({ name: type.name, status: type.status, sort_order: type.sort_order, partner_id: partnerId }).select('id').single(),
        'Could not copy an article type'
      );
      ownId = created.id;
      ownByName.set(key(type.name), ownId);
      typesAdded += 1;
    }
    const have = unwrap(await supabaseAdmin.from('articles').select('name').eq('article_type_id', ownId).eq('partner_id', partnerId), 'Could not read your articles');
    const haveNames = new Set(have.map((a) => key(a.name)));
    const rows = shared
      .filter((a) => a.article_type_id === type.id && !haveNames.has(key(a.name)))
      .map((a) => ({
        article_type_id: ownId,
        partner_id: partnerId,
        name: a.name,
        image_url: a.image_url,
        image_path: null, // the picture file stays the template's: removing the copy must not delete it
        customer_price: a.customer_price,
        partner_cost: a.partner_cost,
        status: a.status,
        sort_order: a.sort_order,
      }));
    if (rows.length) {
      unwrap(await supabaseAdmin.from('articles').insert(rows), 'Could not copy the articles');
      articlesAdded += rows.length;
    }
  }
  return { typesAdded, articlesAdded };
};
