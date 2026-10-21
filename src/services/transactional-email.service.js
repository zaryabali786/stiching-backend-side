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
