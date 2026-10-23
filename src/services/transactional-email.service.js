import nodemailer from 'nodemailer';
import { config } from '../config/env.js';

/**
 * Emails the platform sends by itself (sign-in codes, "add your sizes"), through the same Postmark server as the Inbox.
 * It never throws: a failed email must not stop an order from being taken in. The caller gets { sent, reason }.
 */

const escapeHtml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export const transactionalFrom = () => config.transactionalEmail.from || (config.inboundEmail.domain ? `Stitch&Ship <noreply@${config.inboundEmail.domain}>` : '');

const smtpEnabled = () => !!config.smtp.host && !!config.smtp.user && !!config.smtp.pass;

export const transactionalEnabled = () => (!!config.outboundEmail.postmarkToken && !!transactionalFrom()) || smtpEnabled();

const postmarkEnabled = () => !!config.outboundEmail.postmarkToken && !!transactionalFrom();

let smtpTransport = null;
const sendBySmtp = async ({ to, subject, text, html }) => {
  smtpTransport ||= nodemailer.createTransport({ host: config.smtp.host, port: config.smtp.port, secure: config.smtp.secure, auth: { user: config.smtp.user, pass: config.smtp.pass } });
  await smtpTransport.sendMail({ from: config.smtp.from || config.smtp.user, to, subject, text, html });
};

const money = (amount, currency) => {
  const n = Number(amount);
  if (!Number.isFinite(n)) return '';
  try {
    return new Intl.NumberFormat('en', { style: 'currency', currency: currency || 'USD' }).format(n);
  } catch {
    return `${currency ? `${currency} ` : ''}${n.toFixed(2)}`;
  }
};

/**
 * A simple, readable email: the brand the order is from, a few paragraphs, an optional list of the ordered products with their prices and
 * total, and one button. `items`: [{ title, quantity, price, image_url? }]; `price` is the price of ONE piece.
 */
export const renderEmail = ({ heading, brand = '', paragraphs = [], items = [], currency = '', total = null, button = null, footer = '' }) => {
  const lines = items.map((it) => `- ${it.title} x ${it.quantity} ${money(it.price * it.quantity, currency)}`.trim());
  const hasTotal = total != null && Number.isFinite(Number(total));
  const text = [
    ...(brand ? [`Order from ${brand}`] : []),
    heading,
    '',
    ...paragraphs,
    ...(lines.length ? ['', ...lines, ...(hasTotal ? [`Total: ${money(total, currency)}`] : [])] : []),
    ...(button ? ['', `${button.label}: ${button.url}`] : []),
    ...(footer ? ['', footer] : []),
  ].join('\n');
  const rows = items
    .map(
      (it) => `<tr>
<td style="padding:10px 0;border-bottom:1px solid #eee;width:56px">${it.image_url ? `<img src="${escapeHtml(it.image_url)}" width="48" height="48" alt="" style="border-radius:8px;object-fit:cover;display:block">` : ''}</td>
<td style="padding:10px 8px;border-bottom:1px solid #eee">${escapeHtml(it.title)}<br><span style="color:#777;font-size:13px">Qty ${it.quantity}</span></td>
<td style="padding:10px 0;border-bottom:1px solid #eee;text-align:right;white-space:nowrap">${escapeHtml(money(it.price * it.quantity, currency))}</td>
</tr>`
    )
    .join('\n');
  const totalRow = hasTotal ? `<tr><td colspan="2" style="padding:12px 8px 0;font-weight:700">Total</td><td style="padding:12px 0 0;text-align:right;font-weight:700;white-space:nowrap">${escapeHtml(money(total, currency))}</td></tr>` : '';
  const html = `<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;font-size:15px;line-height:1.5;color:#222;max-width:560px">
${brand ? `<p style="margin:0 0 4px;color:#777;font-size:12px;letter-spacing:.6px;text-transform:uppercase">Order from</p><p style="margin:0 0 14px;font-size:20px;font-weight:700">${escapeHtml(brand)}</p>` : ''}
<h2 style="margin:0 0 12px">${escapeHtml(heading)}</h2>
${paragraphs.map((p) => `<p style="margin:0 0 12px">${escapeHtml(p)}</p>`).join('\n')}
${rows ? `<table role="presentation" style="width:100%;border-collapse:collapse;margin:8px 0 4px">${rows}${totalRow}</table>` : ''}
${button ? `<p style="margin:18px 0"><a href="${escapeHtml(button.url)}" style="background:#1d1d1d;color:#fff;padding:12px 20px;border-radius:10px;text-decoration:none;display:inline-block">${escapeHtml(button.label)}</a></p>` : ''}
${footer ? `<p style="margin:12px 0 0;color:#777;font-size:13px">${escapeHtml(footer)}</p>` : ''}
</div>`;
  return { text, html };
};

export const sendTransactionalEmail = async ({ to, subject, text, html }) => {
  let detail = null;
  if (postmarkEnabled()) {
    try {
      const res = await fetch('https://api.postmarkapp.com/email', {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'X-Postmark-Server-Token': config.outboundEmail.postmarkToken },
        body: JSON.stringify({ From: transactionalFrom(), To: to, Subject: subject, TextBody: text, HtmlBody: html, MessageStream: config.outboundEmail.stream }),
      });
      const result = await res.json().catch(() => ({}));
      if (res.ok && !result.ErrorCode) return { sent: true };
      detail = result.Message || null;
      console.warn('[Email] Postmark rejected the message:', res.status, result.ErrorCode, result.Message);
    } catch (err) {
      detail = err.message;
      console.warn('[Email] Postmark could not send:', err.message);
    }
  }
  if (smtpEnabled()) {
    try {
      await sendBySmtp({ to, subject, text, html });
      return { sent: true };
    } catch (err) {
      detail = err.message;
      console.warn('[Email] SMTP could not send:', err.message);
    }
  }
  if (!detail) console.warn('[Email] not sent (set POSTMARK_SERVER_TOKEN and TRANSACTIONAL_EMAIL_FROM or INBOUND_EMAIL_DOMAIN, or the SMTP_* settings):', subject);
  return { sent: false, reason: detail ? 'rejected' : 'not_configured', detail };
};
