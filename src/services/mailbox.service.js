import { supabaseAdmin } from '../config/supabase.js';
import { unwrap } from '../utils/db.js';
import { shapeImport } from './order-import.service.js';

/** The customer's Inbox: every email that arrived at their personal shopping address. */

const LIST_FIELDS = 'id, email_from, email_to, subject, body_text, received_at, is_read, import_id, order_imports(status, extracted)';

const preview = (text) => String(text || '').replace(/\s+/g, ' ').trim().slice(0, 140);

/** A row for the list: no full body, a short preview and the draft status. */
const shapeListRow = (row) => ({
  id: row.id,
  from: row.email_from,
  subject: row.subject,
  preview: preview(row.body_text),
  received_at: row.received_at,
  is_read: row.is_read,
  import_id: row.import_id,
  draft: row.order_imports
    ? { status: row.order_imports.status, brand: row.order_imports.extracted?.brand ?? null, items: row.order_imports.extracted?.items?.length ?? 0 }
    : null,
});

export const listInbox = async (userId, { from, to, unreadOnly = false, search = '' }) => {
  let query = supabaseAdmin
    .from('inbox_emails')
    .select(LIST_FIELDS, { count: 'exact' })
    .eq('customer_id', userId)
    .order('received_at', { ascending: false })
    .range(from, to);
  if (unreadOnly) query = query.eq('is_read', false);
  if (search) query = query.or(`subject.ilike.%${search}%,email_from.ilike.%${search}%`);
  const result = await query;
  return { rows: unwrap(result, 'Could not load your inbox').map(shapeListRow), total: result.count ?? 0 };
};

export const unreadCount = async (userId) => {
  const { count, error } = await supabaseAdmin.from('inbox_emails').select('id', { count: 'exact', head: true }).eq('customer_id', userId).eq('is_read', false);
  if (error) throw error;
  return count ?? 0;
};

/** One email with its full body and the order draft read from it (if any). Marks it read. */
export const openEmail = async (userId, id) => {
  const { data: row, error } = await supabaseAdmin.from('inbox_emails').select('*').eq('id', id).eq('customer_id', userId).maybeSingle();
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
    subject: row.subject,
    text: row.body_text,
    html: row.body_html,
    received_at: row.received_at,
    is_read: true,
    import_id: row.import_id,
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
