import { config } from '../config/env.js';
import { supabaseAdmin } from '../config/supabase.js';
import { unwrap } from '../utils/db.js';
import { BadRequestError } from '../utils/errors.js';
import { getForwardAddress, inboundEmailEnabled } from './order-import.service.js';
import { randomUUID } from 'node:crypto';
import { decodeDataUrl } from './storage.service.js';

/** Sending from the customer's Inbox: a new email or a reply, with pictures/PDFs. Goes out as <their code>@<mail domain>. */

const MAX_FILES = 5;
const MAX_TOTAL_BYTES = 10 * 1024 * 1024;
const MAX_PER_HOUR = 20;
const DOCS_BUCKET = 'documents';

/** What a customer may attach: photos, PDFs, Office documents, text and zips. (Programs and scripts are refused.) */
const ATTACH_TYPES = new Map([
  ['application/pdf', 'pdf'],
  ['image/jpeg', 'jpg'], ['image/jpg', 'jpg'], ['image/png', 'png'], ['image/webp', 'webp'], ['image/gif', 'gif'], ['image/heic', 'heic'],
  ['application/msword', 'doc'],
  ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'docx'],
  ['application/vnd.ms-excel', 'xls'],
  ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'xlsx'],
  ['application/vnd.ms-powerpoint', 'ppt'],
  ['application/vnd.openxmlformats-officedocument.presentationml.presentation', 'pptx'],
  ['text/plain', 'txt'], ['text/csv', 'csv'], ['application/rtf', 'rtf'], ['text/rtf', 'rtf'],
  ['application/zip', 'zip'], ['application/x-zip-compressed', 'zip'],
]);
const BLOCKED_EXT = /\.(exe|bat|cmd|com|scr|js|jse|vbs|msi|jar|dll|ps1|sh|apk)$/i;

const EMAIL = /^[^\s@<>,;]+@[^\s@<>,;]+\.[^\s@<>,;]+$/;

export const outboundEnabled = () => !!config.outboundEmail.postmarkToken && inboundEmailEnabled();

const escapeHtml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const toHtml = (text) => `<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;font-size:14px;white-space:pre-wrap">${escapeHtml(text)}</div>`;

/** "Name <a@b.com>" or "a@b.com" -> "a@b.com" (null when it isn't an address) */
const bareAddress = (v) => {
  const a = (/<([^>]+)>/.exec(String(v || ''))?.[1] || String(v || '')).trim();
  return EMAIL.test(a) ? a : null;
};

/**
 * @param {string} userId
 * @param {{ to?: string, subject?: string, text: string, replyToId?: string, attachments?: { name?: string, dataUrl: string }[] }} input
 */
export const sendEmail = async (userId, { to, subject, text, replyToId, attachments = [] }) => {
  if (!outboundEnabled()) throw new BadRequestError('Sending email is not switched on yet. Please contact us.');

  const body = String(text || '').trim();
  if (!body && !attachments.length) throw new BadRequestError('Write a message or add a picture.');
  if (body.length > 20_000) throw new BadRequestError('The message is too long.');
  if (attachments.length > MAX_FILES) throw new BadRequestError(`You can attach up to ${MAX_FILES} files.`);

  // A reply goes back to whoever wrote the email; a new email needs an address
  let original = null;
  if (replyToId) {
    const { data } = await supabaseAdmin.from('inbox_emails').select('id, email_from, email_to, direction, subject, message_id').eq('id', replyToId).eq('customer_id', userId).maybeSingle();
    if (!data) throw new BadRequestError('The email you are replying to was not found.');
    original = data;
  }
  const recipient = bareAddress(to) || (original ? bareAddress(original.direction === 'out' ? original.email_to : original.email_from) : null);
  if (!recipient) throw new BadRequestError('Enter a valid email address to send to.');

  const { address: from } = await getForwardAddress(userId);
  if (!from) throw new BadRequestError('Your shopping email is not ready yet.');
  if (recipient.toLowerCase() === from.toLowerCase()) throw new BadRequestError('You cannot send an email to yourself.');

  const since = new Date(Date.now() - 3600_000).toISOString();
  const { count } = await supabaseAdmin.from('inbox_emails').select('id', { count: 'exact', head: true }).eq('customer_id', userId).eq('direction', 'out').gte('received_at', since);
  if ((count ?? 0) >= MAX_PER_HOUR) throw new BadRequestError('You have sent a lot of emails in the last hour. Please try again later.');

  let total = 0;
  const files = attachments.map((a, i) => {
    const { mime, buffer } = decodeDataUrl(a?.dataUrl);
    const name0 = String(a?.name || '');
    if (!ATTACH_TYPES.has(mime) || BLOCKED_EXT.test(name0)) throw new BadRequestError(`${name0 || 'This file'} cannot be attached. Use photos, PDF, Word, Excel, PowerPoint, text or zip files.`);
    total += buffer.length;
    return { mime, buffer, name: String(a?.name || `file-${i + 1}`).replace(/[^\w.\- ]+/g, '_').slice(0, 120) };
  });
  if (total > MAX_TOTAL_BYTES) throw new BadRequestError('Attachments are too big (10 MB in total).');

  const { data: profile } = await supabaseAdmin.from('profiles').select('full_name').eq('id', userId).single();
  const finalSubject = String(subject || '').trim().slice(0, 300) || (original?.subject ? (/^re:/i.test(original.subject) ? original.subject : `Re: ${original.subject}`) : '(no subject)');
  const displayName = String(profile?.full_name || '').replace(/["<>\r\n]/g, '').trim();

  const payload = {
    From: displayName ? `"${displayName}" <${from}>` : from,
    To: recipient,
    ReplyTo: from,
    Subject: finalSubject,
    TextBody: body || '(see attachments)',
    HtmlBody: toHtml(body || '(see attachments)'),
    MessageStream: config.outboundEmail.stream,
    Attachments: files.map((f) => ({ Name: f.name, Content: f.buffer.toString('base64'), ContentType: f.mime })),
  };
  if (original?.message_id) payload.Headers = [{ Name: 'In-Reply-To', Value: original.message_id }, { Name: 'References', Value: original.message_id }];

  const res = await fetch('https://api.postmarkapp.com/email', {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'X-Postmark-Server-Token': config.outboundEmail.postmarkToken },
    body: JSON.stringify(payload),
  });
  const result = await res.json().catch(() => ({}));
  if (!res.ok || result.ErrorCode) {
    console.warn('[Outbound email] Postmark rejected the message:', res.status, result.ErrorCode, result.Message);
    const reason = {
      406: 'That address cannot receive email from us.',
      412: 'Our email service is still being approved, so mail can only go to addresses on our own domain for now. Please try again once it is approved.',
      400: 'Our sending domain is not verified yet, so email cannot be sent. Please contact us.',
      300: 'That email address does not look valid.',
      10: 'Email sending is not set up correctly on the server (bad token).',
    }[result.ErrorCode];
    throw new BadRequestError(reason || 'We could not send your email. Please try again.');
  }

  const stored = [];
  // The email is already out: a storage hiccup must not make the customer send it twice, so a file that can't be kept is listed without a link
  for (const f of files) {
    const path = `inbox/${userId}/${randomUUID()}.${ATTACH_TYPES.get(f.mime)}`;
    const { error } = await supabaseAdmin.storage.from(DOCS_BUCKET).upload(path, f.buffer, { contentType: f.mime, upsert: false });
    if (error) console.warn('[Outbound email] could not keep attachment:', error.message);
    stored.push({ path: error ? null : path, name: f.name, type: f.mime, size: f.buffer.length });
  }

  const row = unwrap(
    await supabaseAdmin
      .from('inbox_emails')
      .insert({
        customer_id: userId,
        direction: 'out',
        message_id: result.MessageID ? String(result.MessageID).slice(0, 300) : null,
        email_from: from,
        email_to: recipient,
        subject: finalSubject,
        body_text: body,
        body_html: null,
        is_read: true,
        attachments: stored,
        reply_to_id: original?.id ?? null,
      })
      .select('id')
      .single(),
    'Your email was sent, but we could not save a copy'
  );
  return { id: row.id, to: recipient, subject: finalSubject };
};
