import { randomBytes } from 'node:crypto';
import { supabaseAdmin } from '../config/supabase.js';
import { config } from '../config/env.js';
import { unwrap } from '../utils/db.js';
import { extractOrderWithAi, isAiConfigured, isAiReadable, normaliseExtracted } from './ai.service.js';
import { brandFromHost, decodeEntities, readProductLink } from './product-page.service.js';
import { isDocumentType, uploadDocumentBuffer, withSignedUrl } from './storage.service.js';
import { notifyUser } from './notification.service.js';
import { attachProductImages } from './email-images.service.js';
import { emitTo, rooms } from '../realtime/io.js';
import { loadCourierNames, matchEmailToOrder, readShippingFromText, resolveEmailTarget, pickCourier, reconcilePayment } from './email-order-match.service.js';

/**
 * Turns an uploaded brand invoice, a list of product links, or a forwarded brand email into an
 * order_imports row whose `extracted` draft prefills the customer's order form.
 */

const emptyDraft = () => ({ is_order: true, brand: null, order_number: null, order_date: null, currency: null, total: null, payment_method: null, payment_status: null, tracking_number: null, courier_name: null, items: [] });

const updateImport = async (id, patch) =>
  unwrap(await supabaseAdmin.from('order_imports').update({ ...patch, updated_at: new Date().toISOString() }).eq('id', id).select('*').single(), 'Could not save the import');

/** Shape a row for the customer app (adds short-lived links to private files). */
export const shapeImport = async (row) => ({
  id: row.id,
  source: row.source,
  status: row.status,
  file: await withSignedUrl(row.file),
  links: row.links || [],
  email_from: row.email_from,
  email_subject: row.email_subject,
  email_received_at: row.email_received_at,
  attachments: await Promise.all((row.attachments || []).map(withSignedUrl)),
  extracted: row.extracted,
  extracted_by: row.extracted_by,
  error: row.error,
  order_id: row.order_id,
  created_at: row.created_at,
});

/**
 * The order was created from an import draft: keep where it came from on the order (source, brand total, invoice file)
 * and mark the draft used. Best effort — the order itself is already saved and must never fail because of this.
 */
export const linkImportToOrder = async (userId, orderId, importId) => {
  try {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(importId || ''))) return;
    // Claiming the draft is one atomic update, so two submits can never both use it
    const { data: claimed } = await supabaseAdmin
      .from('order_imports')
      .update({ status: 'used', order_id: orderId, updated_at: new Date().toISOString() })
      .eq('id', importId)
      .eq('customer_id', userId)
      .neq('status', 'used')
      .select('*')
      .maybeSingle();
    if (!claimed) return;
    const total = Number(claimed.extracted?.total);
    await supabaseAdmin
      .from('orders')
      .update({
        import_source: claimed.source,
        order_source: claimed.source === 'email' ? 'email' : 'website',
        import_id: claimed.id,
        brand_order_total: Number.isFinite(total) && total > 0 ? total : null,
        brand_order_currency: claimed.extracted?.currency || null,
        brand_invoice: claimed.file || null,
      })
      .eq('id', orderId);
  } catch (err) {
    console.warn('[Import] could not link the draft to the order:', err.message);
  }
};

// ───────────────────────── forwarding address ─────────────────────────

const parseInboundAddress = () => {
  const m = /^([^@\s+]+)@([^@\s]+)$/.exec(config.inboundEmail.address.trim());
  return m ? { local: m[1].toLowerCase(), domain: m[2].toLowerCase() } : null;
};

/** Own mail domain (e.g. mail.example.com) whose catch-all gives every customer  <token>@<domain>. */
const ownDomain = () => config.inboundEmail.domain.trim().toLowerCase().replace(/^@/, '');

export const inboundEmailEnabled = () => (!!ownDomain() || !!parseInboundAddress()) && !!config.inboundEmail.secret;

const newToken = () => randomBytes(8).toString('hex'); // fallback only, for a profile without a customer code

/** The address token is the customer's own code (STX-10011 -> stx-10011), so the address is readable and unique. */
export const tokenForCode = (code) => (code ? String(code).trim().toLowerCase() : null);

/** The customer-facing address for a token: <token>@<own domain>, else the provider's  <local>+<token>@<domain>. */
export const addressForToken = (token) => {
  if (!token) return null;
  const shown = /^stx-\d+$/i.test(token) ? token.toUpperCase() : token;
  if (ownDomain()) return `${shown}@${ownDomain()}`;
  const parts = parseInboundAddress();
  return parts ? `${parts.local}+${shown}@${parts.domain}` : null;
};

/**
 * The customer's personal shopping address (creates the secret token on first use). It is created when the customer
 * signs up, so they can type it at any shop's checkout and read what arrives in the app's Inbox.
 */
export const getForwardAddress = async (userId, { reset = false } = {}) => {
  if (!inboundEmailEnabled()) return { address: null, enabled: false };

  const row = unwrap(await supabaseAdmin.from('profiles').select('inbound_email_token, customer_code').eq('id', userId).single());
  // The address always follows the customer code; older random tokens are migrated here (and still accepted on receive).
  const token = tokenForCode(row.customer_code) || (!reset && row.inbound_email_token) || newToken();
  if (token !== row.inbound_email_token) {
    unwrap(await supabaseAdmin.from('profiles').update({ inbound_email_token: token }).eq('id', userId), 'Could not create your shopping address');
  }
  return { address: addressForToken(token), enabled: true };
};

/** Find the token in any recipient:  <token>@<own domain>  or  <local>+<token>@domain. */
const tokenFromRecipients = (recipients) => {
  const parts = parseInboundAddress();
  const domain = ownDomain();
  for (const r of recipients) {
    const email = (/<([^>]+)>/.exec(r)?.[1] || r || '').trim().toLowerCase();
    if (domain) {
      const own = /^([a-z0-9-]{8,40})@([^@\s]+)$/.exec(email);
      if (own && own[2] === domain) return own[1];
    }
    const m = /^([^@+\s]+)\+([a-z0-9-]{8,40})@([^@\s]+)$/.exec(email);
    if (m && (!parts || (m[1] === parts.local && m[3] === parts.domain))) return m[2];
  }
  return null;
};

// ───────────────────────── invoice upload ─────────────────────────

/**
 * @param {string} userId
 * @param {{ mime: string, buffer: Buffer, name: string }} file
 */
export const importInvoice = async (userId, file) => {
  const stored = await uploadDocumentBuffer(`invoices/${userId}`, file.buffer, file.mime, file.name);
  const row = unwrap(
    await supabaseAdmin.from('order_imports').insert({ customer_id: userId, source: 'invoice', status: 'processing', file: stored }).select('*').single(),
    'Could not save the invoice'
  );

  if (!isAiConfigured()) {
    return updateImport(row.id, {
      status: 'ready',
      extracted: emptyDraft(),
      extracted_by: 'basic',
      error: "Automatic reading isn't switched on yet — please type the details below. Your invoice is saved with the order.",
    });
  }
  if (!isAiReadable(file.mime)) {
    return updateImport(row.id, { status: 'failed', error: 'We can only read PDF, JPG, PNG or WebP invoices. Try a screenshot or type the details below.' });
  }

  try {
    const extracted = await extractOrderWithAi(
      [{ type: file.mime === 'application/pdf' ? 'pdf' : 'image', mime: file.mime, data: file.buffer.toString('base64') }],
      'This is an invoice / order confirmation from a clothing brand. Extract the brand, order number, currency, total and every product line.'
    );
    if (!extracted.is_order) {
      return updateImport(row.id, { status: 'failed', extracted, extracted_by: 'ai', error: "This doesn't look like an order or invoice. Check the file, or type the details below." });
    }
    return updateImport(row.id, {
      status: 'ready',
      extracted,
      extracted_by: 'ai',
      error: extracted.items.length ? null : "We couldn't find the products on this invoice — please add them below.",
    });
  } catch (err) {
    console.warn('[Import] invoice read failed:', err.message);
    return updateImport(row.id, { status: 'failed', error: "We couldn't read this invoice right now. Type the details below — the invoice is still saved with the order." });
  }
};

// ───────────────────────── product links ─────────────────────────

export const importLinks = async (userId, urls) => {
  const results = await Promise.all(urls.map((u) => readProductLink(u)));

  // One order = one brand; pick the most common brand / currency among the links
  const mostCommon = (values) => {
    const counts = {};
    for (const v of values.filter(Boolean)) counts[v] = (counts[v] || 0) + 1;
    return Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0] || null;
  };
  const brands = [...new Set(results.map((r) => r.brand).filter(Boolean))];
  const draft = normaliseExtracted({
    is_order: true,
    brand: mostCommon(results.map((r) => r.brand)),
    currency: mostCommon(results.map((r) => r.currency)),
    items: results.map((r) => ({ title: r.title || r.url, quantity: 1, unit_price: r.unit_price, sku: r.sku, url: r.url, image_url: r.image_url })),
  });
  draft.links = results.map((r) => ({ url: r.url, ok: r.ok, error: r.error, title: r.title, read_by: r.read_by }));

  const failed = results.filter((r) => !r.ok).length;
  const notes = [];
  if (failed) notes.push(`${failed} link${failed === 1 ? '' : 's'} couldn't be read automatically — check ${failed === 1 ? 'its' : 'their'} name and price.`);
  if (brands.length > 1) notes.push(`These links are from ${brands.length} different shops (${brands.join(', ')}). Each order is for one brand — remove the others or create separate orders.`);

  const row = unwrap(
    await supabaseAdmin
      .from('order_imports')
      .insert({
        customer_id: userId,
        source: 'link',
        status: results.some((r) => r.ok) ? 'ready' : 'failed',
        links: results.map((r) => r.url),
        extracted: draft,
        extracted_by: results.some((r) => r.read_by === 'ai') ? 'ai' : 'page',
        error: notes.join(' ') || null,
      })
      .select('*')
      .single(),
    'Could not save the links'
  );
  return row;
};

// ───────────────────────── forwarded email ─────────────────────────

/**
 * Which customer an inbound email belongs to: the token in the recipient address, or Postmark's
 * MailboxHash (the part after the "+") when the recipient headers don't carry it (e.g. BCC).
 */
export const resolveInboundToken = (email) => {
  const fromRecipients = tokenFromRecipients(email.recipients);
  if (fromRecipients) return fromRecipients;
  const hash = String(email.mailboxHash || '').trim().toLowerCase();
  return /^[a-z0-9-]{8,40}$/.test(hash) ? hash : null;
};

/** Normalise Postmark-style or generic JSON inbound payloads. */
export const normaliseInboundEmail = (b = {}) => {
  const list = (...vals) => vals.flat(3).filter(Boolean).flatMap((v) => (typeof v === 'string' ? v.split(',') : [v?.Email || v?.email || v?.address].filter(Boolean)));
  const isPostmark = b.TextBody !== undefined || b.HtmlBody !== undefined || b.FromFull !== undefined;
  if (isPostmark) {
    return {
      from: b.FromFull?.Email ? `${b.FromFull.Name || ''} <${b.FromFull.Email}>`.trim() : b.From || '',
      recipients: list(b.OriginalRecipient, b.ToFull, b.To, b.CcFull, b.BccFull),
      subject: b.Subject || '',
      text: b.TextBody || b.StrippedTextReply || '',
      html: b.HtmlBody || '',
      date: b.Date || null,
      mailboxHash: b.MailboxHash || null,
      messageId: b.MessageID || null,
      attachments: (b.Attachments || []).map((a) => ({ name: a.Name, mime: String(a.ContentType || '').split(';')[0].toLowerCase(), base64: a.Content, cid: String(a.ContentID || '').replace(/^<|>$/g, '') })),
    };
  }
  return {
    from: typeof b.from === 'string' ? b.from : b.from?.text || b.from?.address || '',
    recipients: list(b.to, b.recipient, b.recipients, b.cc, b.envelope?.to),
    subject: b.subject || '',
    text: b.text || b['body-plain'] || '',
    html: b.html || b['body-html'] || '',
    date: b.date || null,
    mailboxHash: b.mailboxHash || null,
    messageId: b.messageId || b['message-id'] || null,
    attachments: (b.attachments || []).map((a) => ({ name: a.filename || a.name, mime: String(a.contentType || a.content_type || a.type || '').split(';')[0].toLowerCase(), base64: a.content || a.data, cid: String(a.cid || a.contentId || a.content_id || a['content-id'] || '').replace(/^<|>$/g, '') })),
  };
};

/** HTML email → readable text that keeps product links and images for the reader. */
const htmlToText = (html) =>
  decodeEntities(
    html
      .replace(/<(script|style|head|title)[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<img\b[^>]*>/gi, (tag) => {
        const src = /\bsrc=["']([^"']+)["']/i.exec(tag)?.[1];
        const alt = /\balt=["']([^"']*)["']/i.exec(tag)?.[1];
        const w = parseInt(/\bwidth=["']?(\d+)/i.exec(tag)?.[1] || '100', 10);
        return src && w > 20 && /^https?:/i.test(src) ? ` [image${alt ? `: ${alt}` : ''}](${src}) ` : ' ';
      })
      .replace(/<a\b[^>]*href=["'](https?:[^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_, href, inner) => `${inner} (${href})`)
      .replace(/<br\s*\/?>|<\/(p|div|tr|li|h\d|table)>/gi, '\n')
      .replace(/<\/t[dh]>/gi, ' | ')
      .replace(/<[^>]+>/g, ' ')
  )
    .split('\n')
    .map((l) => l.replace(/[ \t ]+/g, ' ').trim())
    .filter(Boolean)
    .join('\n');

/** Without AI: brand from the original sender, order number from subject/body. */
const basicEmailDraft = (email, bodyText, courierNames = []) => {
  const draft = emptyDraft();
  const fwd = /From:\s*"?([^"<\n]*)"?\s*<([^>\s]+@[^>\s]+)>/i.exec(bodyText) || /From:\s*"?([^"<\n]*)"?\s*<([^>\s]+@[^>\s]+)>/i.exec(email.from);
  if (fwd) draft.brand = brandFromHost(`https://${fwd[2].split('@')[1]}`, fwd[1].trim() || null);
  const orderRe = /\border\s*(?:no\.?|number|#|id)?\s*[:#]?\s*#?\s*([A-Z0-9][A-Z0-9-]{3,24})\b/gi;
  // an order number always has a digit ("order shipped" is not one)
  const numberIn = (text) => [...String(text || '').matchAll(orderRe)].map((m) => m[1]).find((v) => /\d/.test(v)) || null;
  draft.order_number = numberIn(email.subject) || numberIn(bodyText);
  Object.assign(draft, readShippingFromText(bodyText, courierNames));
  return draft;
};

/** Cheap pre-check so promotions and verification codes do not cost an AI call: only order-like mail gets a draft. */
const looksLikeOrder = (email) =>
  /\b(order|invoice|receipt|purchase|payment|shipment|shipped|shipping|dispatch(?:ed)?|tracking|track|delivery|delivered|parcel|package|courier|confirmed|confirmation|on its way|out for delivery)\b/i.test(email.subject) ||
  /\border\s*(?:no\.?|number|#|id)\b/i.test((email.text || email.html || '').slice(0, 6000)) ||
  /\btrack(?:ing)?\s*(?:number|no\.?|id|code|#)\b/i.test((email.text || email.html || '').slice(0, 6000));

const MAX_HTML = 400_000;
const MAX_TEXT = 100_000;

/**
 * Keep an email that reached a customer's shopping address. Every email goes into their Inbox; order-like ones also
 * get a draft read in the background (so the mail provider gets a fast 200).
 * @returns {Promise<{ accepted: boolean, id?: string, reason?: string }>}
 */
export const receiveForwardedEmail = async (payload) => {
  const email = normaliseInboundEmail(payload);
  const token = resolveInboundToken(email);
  if (!token) return { accepted: false, reason: 'no customer token in recipients' };

  // token is the lower-cased customer code (or an older random token)
  let { data: profile } = await supabaseAdmin.from('profiles').select('id').eq('inbound_email_token', token).maybeSingle();
  if (!profile) ({ data: profile } = await supabaseAdmin.from('profiles').select('id').ilike('customer_code', token).maybeSingle());
  if (!profile) return { accepted: false, reason: 'unknown token' };

  const receivedAt = email.date && !Number.isNaN(Date.parse(email.date)) ? new Date(email.date).toISOString() : new Date().toISOString();
  const subject = email.subject.slice(0, 300) || null;

  // The provider retries a delivery it didn't get a 200 for: the same message is only stored once
  let dupeQuery = null;
  if (email.messageId) dupeQuery = supabaseAdmin.from('inbox_emails').select('id').eq('customer_id', profile.id).eq('message_id', email.messageId);
  else if (email.date) dupeQuery = supabaseAdmin.from('inbox_emails').select('id').eq('customer_id', profile.id).eq('received_at', receivedAt).eq('subject', subject || '');
  if (dupeQuery) {
    const { data: dupe } = await dupeQuery.limit(1).maybeSingle();
    if (dupe) return { accepted: true, id: dupe.id, duplicate: true };
  }

  let importId = null;
  if (looksLikeOrder(email)) {
    importId = unwrap(
      await supabaseAdmin
        .from('order_imports')
        .insert({
          customer_id: profile.id,
          source: 'email',
          status: 'processing',
          email_from: email.from.slice(0, 300) || null,
          email_subject: subject,
          email_received_at: receivedAt,
        })
        .select('id')
        .single()
    ).id;
  }

  const to = email.recipients.map((r) => (/<([^>]+)>/.exec(r)?.[1] || r || '').trim().toLowerCase()).find((r) => r.includes(token)) || null;
  const { data: saved, error } = await supabaseAdmin
    .from('inbox_emails')
    .insert({
      customer_id: profile.id,
      message_id: email.messageId ? String(email.messageId).slice(0, 300) : null,
      email_from: email.from.slice(0, 300) || null,
      email_to: to,
      subject,
      body_text: email.text.slice(0, MAX_TEXT) || null,
      body_html: email.html.slice(0, MAX_HTML) || null,
      received_at: receivedAt,
      import_id: importId,
    })
    .select('id')
    .single();
  if (error) {
    if (importId) await supabaseAdmin.from('order_imports').delete().eq('id', importId);
    if (error.code === '23505') return { accepted: true, duplicate: true }; // two deliveries raced; the other one won
    throw error;
  }

  emitTo(rooms.user(profile.id), 'mailbox:new', { id: saved.id, subject, from: email.from.slice(0, 300) || null, import_id: importId });
  if (importId) setImmediate(() => processForwardedEmail(importId, profile.id, email, saved.id).catch((err) => console.warn('[Import] email processing failed:', err.message)));
  return { accepted: true, id: saved.id };
};

// ───────────────────────── automatic draft order ─────────────────────────

/** The active default partner (Partners > Make default), or null when there is none. */
const defaultPartnerId = async () =>
  (await supabaseAdmin.from('partners').select('id').eq('is_default', true).eq('status', 'active').limit(1).maybeSingle()).data?.id ?? null;


const cleanBrandName = (v) =>
  String(v || '')
    .replace(/[\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);

/** Escape LIKE wildcards so a brand name is matched literally. */
const likeEscape = (v) => v.replace(/[\\%_]/g, (c) => '\\' + c);

/** The catalogue brand with this name; created (as an ordinary active brand) when the customer's email names a new one. */
const ensureBrand = async (name, userId) => {
  const clean = cleanBrandName(name);
  if (clean.length < 2) return null;
  const find = async () =>
    (await supabaseAdmin.from('brands').select('id, name').ilike('name', likeEscape(clean)).limit(1).maybeSingle()).data;
  const found = await find();
  if (found) return found;
  const { data, error } = await supabaseAdmin.from('brands').insert({ name: clean, created_by: userId }).select('id, name').single();
  if (!error) return data;
  if (error.code === '23505') return find(); // created by someone else a moment ago
  console.warn('[Import] could not save the brand:', error.message);
  return null;
};

/** An order can hold at most this many articles (the same limit the order form enforces). */
const MAX_ARTICLES = 30;

/**
 * One article record per unit: Product A x2 + Product B x3 = 5 articles, each with quantity 1 and the product's own
 * details and unit price. Returns how many units did not fit in an order.
 */
export const expandItemsToUnits = (items) => {
  const all = [];
  for (const it of items || []) {
    const copies = Math.max(1, Math.min(20, Math.round(Number(it.quantity)) || 1));
    for (let n = 0; n < copies; n++) all.push(it);
  }
  return { units: all.slice(0, MAX_ARTICLES), dropped: Math.max(0, all.length - MAX_ARTICLES) };
};

/**
 * Turn a read order email into a DRAFT order for the customer: brand saved in the catalogue, products, order number,
 * tracking and total filled in. Nobody but the customer sees it (no partner, no staff notification) until they add
 * the sizes and submit it from the app, which sends it on like any new order. The order starts at the central location;
 * the admin chooses the partner later.
 * @returns {Promise<{ order: object, dropped: number }|null>} null when the draft was already used
 */
export const createDraftOrder = async (userId, importId, extracted, { receivedAt = null } = {}) => {
  // Claiming the draft is one atomic update, so a retried delivery can never make two orders
  const { data: claimed } = await supabaseAdmin
    .from('order_imports')
    .update({ status: 'used', updated_at: new Date().toISOString() })
    .eq('id', importId)
    .eq('customer_id', userId)
    .neq('status', 'used')
    .select('id')
    .maybeSingle();
  if (!claimed) return null;

  try {
    const profile = unwrap(await supabaseAdmin.from('profiles').select('full_name, email, customer_code, country, city, address').eq('id', userId).single());
    const brand = await ensureBrand(extracted.brand, userId);
    const country = String(profile.country || '').trim().toLowerCase();
    const international = country ? country !== 'pakistan' : null; // best guess from where they live; they confirm it when submitting
    const due = new Date();
    due.setUTCDate(due.getUTCDate() + 12);
    const total = Number(extracted.total);
    const courier = extracted.courier_name ? pickCourier(unwrap(await supabaseAdmin.from('couriers').select('id, name').eq('status', 'active')), extracted.courier_name) : null;
    const shippedAt = extracted.tracking_number || extracted.courier_name ? new Date(receivedAt || Date.now()).toISOString() : null;

    const order = unwrap(
      await supabaseAdmin
        .from('orders')
        .insert({
          status: 'draft',
          customer_id: userId,
          customer_name: profile.full_name || profile.email,
          customer_code: profile.customer_code,
          brand: brand?.name || cleanBrandName(extracted.brand) || null,
          brand_id: brand?.id || null,
          brand_order_number: extracted.order_number || null,
          tracking_number: extracted.tracking_number || null,
          courier_id: courier?.id ?? null,
          courier_name: courier ? null : extracted.courier_name || null,
          shipping_updated_at: shippedAt,
          international_shipping: international,
          shipping_service: international ? 'express' : 'standard',
          partner_id: await defaultPartnerId(), // the default partner sees the draft in Receiving at once, so it can receive the parcel; the admin can change the partner
          import_source: 'email',
          order_source: 'email',
          import_id: importId,
          brand_order_total: Number.isFinite(total) && total > 0 ? total : null,
          brand_order_currency: extracted.currency || null,
          brand_payment_method: extracted.payment_method || null,
          brand_payment_status: extracted.payment_status || null,
          priority: 'normal',
          due_date: due.toISOString().slice(0, 10),
          destination_country: profile.country || null,
          destination_city: profile.city || null,
          destination_address: profile.address || null,
          destination_phone: profile.phone || null,
        })
        .select('*')
        .single(),
      'Could not create the draft order'
    );

    const { units, dropped } = expandItemsToUnits(extracted.items);
    const inserted = await supabaseAdmin.from('order_units').insert(
      units.map((it, i) => ({
        order_id: order.id,
        line_no: i + 1,
        unit_title: it.title.slice(0, 160),
        product_link: it.url,
        product_image_url: it.image_url,
        brand_sku: it.sku,
        notes: it.notes,
        quantity: 1,
        unit_price: it.unit_price,
        currency: extracted.currency || null,
      }))
    );
    if (inserted.error) {
      await supabaseAdmin.from('orders').delete().eq('id', order.id);
      throw inserted.error;
    }

    await supabaseAdmin.from('order_imports').update({ order_id: order.id, updated_at: new Date().toISOString() }).eq('id', importId);
    return { order, dropped };
  } catch (err) {
    // give the draft back so the customer can still create the order by hand from the email
    await supabaseAdmin.from('order_imports').update({ status: 'ready', order_id: null }).eq('id', importId);
    throw err;
  }
};

/**
 * A follow-up email (or a repeat of the confirmation) about an order the customer already has: save its courier / tracking
 * on that order, or flag it for review. No second order and no second draft are made.
 * @returns {Promise<boolean>} true when the email was dealt with
 */
const linkEmailToExistingOrder = async ({ importId, userId, inboxId, extracted, extractedBy, stored, receivedAt, target }) => {
  const result = await matchEmailToOrder({ userId, inboxId, extracted, receivedAt, target });
  if (!result.handled) return false;
  if (result.kind === 'matched') {
    // the draft row stays as the record of what was read, marked used so it can never be turned into another order
    await updateImport(importId, { status: 'used', order_id: result.order.id, extracted, extracted_by: extractedBy, error: null, attachments: stored });
  } else {
    await supabaseAdmin.from('order_imports').delete().eq('id', importId);
  }
  emitTo(rooms.user(userId), 'mailbox:update', { id: inboxId });
  if (result.kind === 'matched') emitTo(rooms.user(userId), 'order:update', { orderId: result.order.id });
  return true;
};

const processForwardedEmail = async (importId, userId, email, inboxId) => {
  // Keep PDF/image attachments (e.g. an attached invoice) privately for the order
  const stored = [];
  const readable = [];
  for (const a of email.attachments.slice(0, 6)) {
    if (!a.base64 || !isDocumentType(a.mime)) continue;
    const buffer = Buffer.from(a.base64, 'base64');
    if (buffer.length > 8 * 1024 * 1024 || buffer.length < 2048) continue; // skip huge files and tiny logos
    try {
      stored.push(await uploadDocumentBuffer(`emails/${userId}`, buffer, a.mime, a.name || 'attachment'));
      if (isAiReadable(a.mime) && readable.length < 2) readable.push({ type: a.mime === 'application/pdf' ? 'pdf' : 'image', mime: a.mime, data: a.base64 });
    } catch (err) {
      console.warn('[Import] attachment skipped:', err.message);
    }
  }

  const receivedAt = email.date && !Number.isNaN(Date.parse(email.date)) ? new Date(email.date).toISOString() : new Date().toISOString();
  const bodyText = [`Subject: ${email.subject}`, `From: ${email.from}`, '', email.html ? htmlToText(email.html) : email.text].join('\n');
  let extracted;
  let extractedBy = 'basic';
  let error = null;
  const status = 'ready';

  if (isAiConfigured()) {
    try {
      extracted = await extractOrderWithAi(
        [{ type: 'text', text: bodyText }, ...readable],
        'This is an email the customer forwarded after ordering from a clothing brand (it may contain the original message below a "Forwarded message" line, and may have an invoice attached). It is either an order confirmation or a later shipping / tracking update. Extract the original brand, its order number exactly as printed, currency, total, how it was paid (the payment method of this order and whether it is paid or pending, only if the order confirmation itself says so; ignore signatures, footers and older quoted messages), the courier name and tracking number if shown, and every product line (none for a pure shipping update).'
      );
      extractedBy = 'ai';
      if (!extracted.is_order) {
        // Not an order after all (a newsletter, a code ...): it stays in the Inbox, with no draft and no bell notification
        await supabaseAdmin.from('order_imports').delete().eq('id', importId);
        emitTo(rooms.user(userId), 'mailbox:update', { id: inboxId });
        return;
      } else if (!extracted.items.length) {
        error = "We couldn't find the products in this email — please add them by hand.";
      }
    } catch (err) {
      console.warn('[Import] email AI read failed:', err.message);
      extracted = basicEmailDraft(email, bodyText, await loadCourierNames().catch(() => []));
      error = "We couldn't read the products automatically — check the details and add them by hand.";
    }
  } else {
    extracted = basicEmailDraft(email, bodyText, await loadCourierNames().catch(() => []));
    error = 'We saved this email. Automatic product reading is not switched on yet — add the products by hand.';
  }

  // the payment method is the one the order itself states (never inferred from a signature or an older message)
  reconcilePayment(extracted, bodyText);

  // Is this about an order the customer already has? Then update that order instead of making another one.
  const target = await resolveEmailTarget(userId, extracted).catch((err) => {
    console.warn('[Import] order lookup failed:', err.message);
    return { kind: 'none' };
  });
  if (target.kind !== 'none') {
    try {
      if (await linkEmailToExistingOrder({ importId, userId, inboxId, extracted, extractedBy, stored, receivedAt, target })) return;
    } catch (err) {
      console.warn('[Import] could not update the order from the email:', err.message);
    }
  }

  // product pictures: from the email, or from the products' own pages; saved with the order
  if (extractedBy === 'ai' && extracted.items.length) await attachProductImages(userId, email, extracted);

  await updateImport(importId, { status, extracted, extracted_by: extractedBy, error, attachments: stored });
  emitTo(rooms.user(userId), 'mailbox:update', { id: inboxId });

  const n = extracted?.items?.length || 0;

  // Products found: the backend makes the order itself (as a draft) so the customer only has to complete and submit it
  if (n && extractedBy === 'ai') {
    try {
      const made = await createDraftOrder(userId, importId, extracted, { receivedAt });
      if (made) {
        const { order, dropped } = made;
        const { units } = expandItemsToUnits(extracted.items);
        emitTo(rooms.user(userId), 'mailbox:update', { id: inboxId });
        await notifyUser(userId, {
          type: 'order',
          title: 'Draft order created from your email',
          body: `${order.brand ? `${order.brand} · ` : ''}${units.length} article${units.length === 1 ? '' : 's'}${extracted.order_number ? ` · order ${extracted.order_number}` : ''}.${dropped ? ` An order holds at most ${MAX_ARTICLES} articles, so ${dropped} more were left out — add them in a new order.` : ''} Add your sizes, then submit it.`,
          link: `/app/orders/${order.id}`,
          orderId: order.id,
        });
        return;
      }
    } catch (err) {
      // Another email about the same order number made the draft a moment earlier: this one is its follow-up
      if (err?.statusCode === 409) {
        const again = await resolveEmailTarget(userId, extracted).catch(() => ({ kind: 'none' }));
        if (again.kind !== 'none' && (await linkEmailToExistingOrder({ importId, userId, inboxId, extracted, extractedBy, stored, receivedAt, target: again }).catch(() => false))) return;
      }
      console.warn('[Import] draft order failed, the customer can create it from the email:', err.message);
    }
  }

  await notifyUser(userId, {
    type: 'order',
    title: 'An order email arrived in your Inbox',
    body: `${extracted.brand ? `${extracted.brand} · ` : ''}${n ? `${n} product${n === 1 ? '' : 's'} found` : 'No products found yet'}${extracted.order_number ? ` · order ${extracted.order_number}` : ''}. Review it and create your order.`,
    link: `/app/orders/new?import=${importId}`,
  });
};
