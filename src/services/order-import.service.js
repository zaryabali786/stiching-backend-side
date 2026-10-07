import { randomBytes } from 'node:crypto';
import { supabaseAdmin } from '../config/supabase.js';
import { config } from '../config/env.js';
import { unwrap } from '../utils/db.js';
import { extractOrderWithAi, isAiConfigured, isAiReadable, normaliseExtracted } from './ai.service.js';
import { brandFromHost, decodeEntities, readProductLink } from './product-page.service.js';
import { isDocumentType, uploadDocumentBuffer, withSignedUrl } from './storage.service.js';
import { notifyUser } from './notification.service.js';

/**
 * Turns an uploaded brand invoice, a list of product links, or a forwarded brand email into an
 * order_imports row whose `extracted` draft prefills the customer's order form.
 */

const emptyDraft = () => ({ is_order: true, brand: null, order_number: null, order_date: null, currency: null, total: null, tracking_number: null, items: [] });

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

// ───────────────────────── forwarding address ─────────────────────────

const parseInboundAddress = () => {
  const m = /^([^@\s+]+)@([^@\s]+)$/.exec(config.inboundEmail.address.trim());
  return m ? { local: m[1].toLowerCase(), domain: m[2].toLowerCase() } : null;
};

export const inboundEmailEnabled = () => !!parseInboundAddress() && !!config.inboundEmail.secret;

const newToken = () => randomBytes(8).toString('hex'); // 16 hex chars, unguessable

/** The customer's personal forwarding address (creates the secret token on first use). */
export const getForwardAddress = async (userId, { reset = false } = {}) => {
  const parts = parseInboundAddress();
  if (!parts) return { address: null, enabled: false };

  let token = null;
  if (!reset) {
    const row = unwrap(await supabaseAdmin.from('profiles').select('inbound_email_token').eq('id', userId).single());
    token = row.inbound_email_token;
  }
  if (!token) {
    token = newToken();
    unwrap(await supabaseAdmin.from('profiles').update({ inbound_email_token: token }).eq('id', userId), 'Could not create your forwarding address');
  }
  return { address: `${parts.local}+${token}@${parts.domain}`, enabled: inboundEmailEnabled() };
};

/** Find the token in any recipient like  <local>+<token>@domain. */
const tokenFromRecipients = (recipients) => {
  const parts = parseInboundAddress();
  for (const r of recipients) {
    const email = (/<([^>]+)>/.exec(r)?.[1] || r || '').trim().toLowerCase();
    const m = /^([^@+\s]+)\+([a-z0-9]{8,40})@([^@\s]+)$/.exec(email);
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
  return /^[a-z0-9]{8,40}$/.test(hash) ? hash : null;
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
      attachments: (b.Attachments || []).map((a) => ({ name: a.Name, mime: String(a.ContentType || '').split(';')[0].toLowerCase(), base64: a.Content })),
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
    attachments: (b.attachments || []).map((a) => ({ name: a.filename || a.name, mime: String(a.contentType || a.content_type || a.type || '').split(';')[0].toLowerCase(), base64: a.content || a.data })),
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
const basicEmailDraft = (email, bodyText) => {
  const draft = emptyDraft();
  const fwd = /From:\s*"?([^"<\n]*)"?\s*<([^>\s]+@[^>\s]+)>/i.exec(bodyText) || /From:\s*"?([^"<\n]*)"?\s*<([^>\s]+@[^>\s]+)>/i.exec(email.from);
  if (fwd) draft.brand = brandFromHost(`https://${fwd[2].split('@')[1]}`, fwd[1].trim() || null);
  const orderRe = /\border\s*(?:no\.?|number|#|id)?\s*[:#]?\s*#?\s*([A-Z0-9][A-Z0-9-]{3,24})\b/i;
  draft.order_number = orderRe.exec(email.subject)?.[1] || orderRe.exec(bodyText)?.[1] || null;
  return draft;
};

/**
 * Store the forwarded email for the customer it was addressed to. Returns quickly; reading
 * happens in the background so the mail provider gets a fast 200.
 * @returns {Promise<{ accepted: boolean, id?: string, reason?: string }>}
 */
export const receiveForwardedEmail = async (payload) => {
  const email = normaliseInboundEmail(payload);
  const token = resolveInboundToken(email);
  if (!token) return { accepted: false, reason: 'no customer token in recipients' };

  const { data: profile } = await supabaseAdmin.from('profiles').select('id').eq('inbound_email_token', token).maybeSingle();
  if (!profile) return { accepted: false, reason: 'unknown token' };

  const receivedAt = email.date && !Number.isNaN(Date.parse(email.date)) ? new Date(email.date).toISOString() : new Date().toISOString();

  // Postmark retries a delivery it didn't get a 200 for: the same message (same Date + subject) is only stored once
  if (email.date) {
    const { data: dupe } = await supabaseAdmin
      .from('order_imports')
      .select('id')
      .eq('customer_id', profile.id)
      .eq('source', 'email')
      .eq('email_received_at', receivedAt)
      .eq('email_subject', email.subject.slice(0, 300) || null)
      .limit(1)
      .maybeSingle();
    if (dupe) return { accepted: true, id: dupe.id, duplicate: true };
  }

  const row = unwrap(
    await supabaseAdmin
      .from('order_imports')
      .insert({
        customer_id: profile.id,
        source: 'email',
        status: 'processing',
        email_from: email.from.slice(0, 300) || null,
        email_subject: email.subject.slice(0, 300) || null,
        email_received_at: receivedAt,
      })
      .select('id')
      .single()
  );

  setImmediate(() => processForwardedEmail(row.id, profile.id, email).catch((err) => console.warn('[Import] email processing failed:', err.message)));
  return { accepted: true, id: row.id };
};

const processForwardedEmail = async (importId, userId, email) => {
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

  const bodyText = [`Subject: ${email.subject}`, `From: ${email.from}`, '', email.html ? htmlToText(email.html) : email.text].join('\n');
  let extracted;
  let extractedBy = 'basic';
  let error = null;
  let status = 'ready';

  if (isAiConfigured()) {
    try {
      extracted = await extractOrderWithAi(
        [{ type: 'text', text: bodyText }, ...readable],
        'This is an email the customer forwarded after ordering from a clothing brand (it may contain the original message below a "Forwarded message" line, and may have an invoice attached). Extract the original brand, its order number, currency, total and every product line.'
      );
      extractedBy = 'ai';
      if (!extracted.is_order) {
        status = 'failed';
        error = "This email doesn't look like an order confirmation. Forward the brand's order email, or add the order by hand.";
      } else if (!extracted.items.length) {
        error = "We couldn't find the products in this email — please add them by hand.";
      }
    } catch (err) {
      console.warn('[Import] email AI read failed:', err.message);
      extracted = basicEmailDraft(email, bodyText);
      error = "We couldn't read the products automatically — check the details and add them by hand.";
    }
  } else {
    extracted = basicEmailDraft(email, bodyText);
    error = 'We saved this email. Automatic product reading is not switched on yet — add the products by hand.';
  }

  await updateImport(importId, { status, extracted, extracted_by: extractedBy, error, attachments: stored });

  const n = extracted?.items?.length || 0;
  await notifyUser(userId, {
    type: 'order',
    title: status === 'failed' ? 'We could not use your forwarded email' : 'Your forwarded order email is ready',
    body:
      status === 'failed'
        ? error
        : `${extracted.brand ? `${extracted.brand} · ` : ''}${n ? `${n} product${n === 1 ? '' : 's'} found` : 'No products found yet'}${extracted.order_number ? ` · order ${extracted.order_number}` : ''}. Review it and create your order.`,
    link: `/app/orders/new?import=${importId}`,
  });
};
