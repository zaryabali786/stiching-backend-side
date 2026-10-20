import { config } from '../config/env.js';

/**
 * Emails the platform sends by itself (sign-in codes, "add your sizes"), through the same Postmark server as the Inbox.
 * It never throws: a failed email must not stop an order from being taken in. The caller gets { sent, reason }.
 */

const escapeHtml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export const transactionalFrom = () => config.transactionalEmail.from || (config.inboundEmail.domain ? `Stitch&Ship <noreply@${config.inboundEmail.domain}>` : '');

export const transactionalEnabled = () => !!config.outboundEmail.postmarkToken && !!transactionalFrom();

/** A simple, readable email: a few paragraphs and one button. */
export const renderEmail = ({ heading, paragraphs = [], button = null, footer = '' }) => {
  const text = [heading, '', ...paragraphs, ...(button ? ['', `${button.label}: ${button.url}`] : []), ...(footer ? ['', footer] : [])].join('\n');
  const html = `<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;font-size:15px;line-height:1.5;color:#222;max-width:520px">
<h2 style="margin:0 0 12px">${escapeHtml(heading)}</h2>
${paragraphs.map((p) => `<p style="margin:0 0 12px">${escapeHtml(p)}</p>`).join('\n')}
${button ? `<p style="margin:18px 0"><a href="${escapeHtml(button.url)}" style="background:#1d1d1d;color:#fff;padding:12px 20px;border-radius:10px;text-decoration:none;display:inline-block">${escapeHtml(button.label)}</a></p>` : ''}
${footer ? `<p style="margin:12px 0 0;color:#777;font-size:13px">${escapeHtml(footer)}</p>` : ''}
</div>`;
  return { text, html };
};

export const sendTransactionalEmail = async ({ to, subject, text, html }) => {
  try {
    if (!transactionalEnabled()) {
      console.warn('[Email] not sent (set POSTMARK_SERVER_TOKEN and TRANSACTIONAL_EMAIL_FROM or INBOUND_EMAIL_DOMAIN):', subject);
      return { sent: false, reason: 'not_configured' };
    }
    const res = await fetch('https://api.postmarkapp.com/email', {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'X-Postmark-Server-Token': config.outboundEmail.postmarkToken },
      body: JSON.stringify({ From: transactionalFrom(), To: to, Subject: subject, TextBody: text, HtmlBody: html, MessageStream: config.outboundEmail.stream }),
    });
    const result = await res.json().catch(() => ({}));
    if (!res.ok || result.ErrorCode) {
      console.warn('[Email] Postmark rejected the message:', res.status, result.ErrorCode, result.Message);
      return { sent: false, reason: 'rejected' };
    }
    return { sent: true };
  } catch (err) {
    console.warn('[Email] could not send:', err.message);
    return { sent: false, reason: 'error' };
  }
};
