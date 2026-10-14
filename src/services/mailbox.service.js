import { supabaseAdmin } from '../config/supabase.js';
import { unwrap } from '../utils/db.js';
import { shapeImport } from './order-import.service.js';
import { withSignedUrl } from './storage.service.js';

/** The customer's Inbox: every email that arrived at their personal shopping address. */

const BASE_FIELDS = 'id, email_from, email_to, direction, attachments, subject, body_text, received_at, is_read, import_id, order_imports(status, extracted)';
const LIST_FIELDS = `${BASE_FIELDS}, order_id, match_status, match_note, order:orders!inbox_emails_order_id_fkey(reference)`;

/** Database update 0014 not applied yet (no order_id / match columns): the inbox still opens, just without order matching. */
const isMissingMatchColumns = (error) => !!error && ['PGRST200', 'PGRST204', '42703'].includes(error.code);

/** What happened to a follow-up email: it updated an order, or needs a person to look at it (null = nothing to match). */
const shapeMatch = (row) =>
  row.match_status && row.match_status !== 'none'
    ? { status: row.match_status, note: row.match_note ?? null, order_id: row.order_id ?? null, order_reference: (Array.isArray(row.order) ? row.order[0] : row.order)?.reference ?? null }
    : null;

const preview = (text) => String(text || '').replace(/\s+/g, ' ').trim().slice(0, 140);

/** A row for the list: no full body, a short preview and the draft status. */
const shapeListRow = (row) => ({
  id: row.id,
  from: row.direction === 'out' ? row.email_to : row.email_from,
  direction: row.direction ?? 'in',
  has_attachments: Array.isArray(row.attachments) && row.attachments.length > 0,
  subject: row.subject,
  preview: preview(row.body_text),
  received_at: row.received_at,
  is_read: row.is_read,
  import_id: row.import_id,
  match: shapeMatch(row),
  draft: row.order_imports
    ? { status: row.order_imports.status, brand: row.order_imports.extracted?.brand ?? null, items: row.order_imports.extracted?.items?.length ?? 0 }
    : null,
});

export const listInbox = async (userId, { from, to, unreadOnly = false, sent = false, search = '' }) => {
  const rebuild = () => {
    let q = supabaseAdmin.from('inbox_emails');
    return {
      select: (fields, opts) => {
        let r = q.select(fields, opts).eq('customer_id', userId).order('received_at', { ascending: false }).range(from, to);
        r = r.eq('direction', sent ? 'out' : 'in');
        if (unreadOnly) r = r.eq('is_read', false);
        if (search) r = r.or(`subject.ilike.%${search}%,email_from.ilike.%${search}%`);
        return r;
      },
    };
  };
  let query = rebuild().select(LIST_FIELDS, { count: 'exact' });
  let result = await query;
  if (isMissingMatchColumns(result.error)) result = await rebuild().select(BASE_FIELDS, { count: 'exact' });
  return { rows: unwrap(result, 'Could not load your inbox').map(shapeListRow), total: result.count ?? 0 };
};

export const unreadCount = async (userId) => {
  const { count, error } = await supabaseAdmin.from('inbox_emails').select('id', { count: 'exact', head: true }).eq('customer_id', userId).eq('is_read', false).eq('direction', 'in');
  if (error) throw error;
  return count ?? 0;
};

/** One email with its full body and the order draft read from it (if any). Marks it read. */
export const openEmail = async (userId, id) => {
  let { data: row, error } = await supabaseAdmin.from('inbox_emails').select('*, order:orders!inbox_emails_order_id_fkey(reference)').eq('id', id).eq('customer_id', userId).maybeSingle();
  if (isMissingMatchColumns(error)) ({ data: row, error } = await supabaseAdmin.from('inbox_emails').select('*').eq('id', id).eq('customer_id', userId).maybeSingle());
  if (error) throw error;
  if (!row) return null;
  if (!row.is_read) await supabaseAdmin.from('inbox_emails').update({ is_read: true }).eq('id', id);

  let draft = null;
  if (row.import_id) {
    const { data: imp } = await supabaseAdmin.from('order_imports').select('*').eq('id', row.import_id).maybeSingle();
    if (imp) draft = await shapeImport(imp);
  }
  return {
    id: row.id,
    from: row.email_from,
    to: row.email_to,
    direction: row.direction ?? 'in',
    attachments: await Promise.all((Array.isArray(row.attachments) ? row.attachments : []).map(withSignedUrl)),
    subject: row.subject,
    text: row.body_text,
    html: row.body_html,
    received_at: row.received_at,
    is_read: true,
    import_id: row.import_id,
    match: shapeMatch(row),
    draft,
  };
};

export const markAllRead = async (userId) => {
  unwrap(await supabaseAdmin.from('inbox_emails').update({ is_read: true }).eq('customer_id', userId).eq('is_read', false), 'Could not update your inbox');
};

/** Removes the email; a draft read from it stays unless it is unused, so a created order never loses its source. */
export const deleteEmail = async (userId, id) => {
  const { data: row } = await supabaseAdmin.from('inbox_emails').select('id, import_id').eq('id', id).eq('customer_id', userId).maybeSingle();
  if (!row) return false;
  unwrap(await supabaseAdmin.from('inbox_emails').delete().eq('id', id));
  if (row.import_id) await supabaseAdmin.from('order_imports').delete().eq('id', row.import_id).neq('status', 'used');
  return true;
};
