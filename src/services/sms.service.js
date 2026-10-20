import { config } from '../config/env.js';

/**
 * Text messages (Twilio's REST API, no library). It never throws: a failed text must not stop an order from being taken in. The
 * caller gets { sent, reason }. Texts are sent only when the account is configured AND the store has switched them on.
 */

export const smsEnabled = () => !!(config.sms.accountSid && config.sms.authToken && (config.sms.from || config.sms.messagingServiceSid));

/**
 * A phone number as +<country><number>, or null when it cannot be read with certainty. Nothing is guessed: a number without "+" is
 * understood only in Pakistan's own formats (03xx xxxxxxx or 92...).
 */
export const toE164 = (raw, defaultCountry = config.sms.defaultCountry) => {
  const s = String(raw ?? '').replace(/[\s().-]/g, '');
  if (/^\+[1-9]\d{7,14}$/.test(s)) return s;
  if (/^00[1-9]\d{7,14}$/.test(s)) return `+${s.slice(2)}`;
  if (defaultCountry === 'PK') {
    if (/^03\d{9}$/.test(s)) return `+92${s.slice(1)}`;
    if (/^923\d{9}$/.test(s)) return `+${s}`;
  }
  return null;
};

export const sendSms = async ({ to, body }) => {
  try {
    if (!smsEnabled()) return { sent: false, reason: 'not_configured' };
    const number = toE164(to);
    if (!number) return { sent: false, reason: 'bad_number' };
    const form = new URLSearchParams({ To: number, Body: String(body).slice(0, 600) });
    if (config.sms.messagingServiceSid) form.set('MessagingServiceSid', config.sms.messagingServiceSid);
    else form.set('From', config.sms.from);
    const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(config.sms.accountSid)}/Messages.json`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${Buffer.from(`${config.sms.accountSid}:${config.sms.authToken}`).toString('base64')}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: form.toString(),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      console.warn('[SMS] Twilio rejected the message:', res.status, err.code, err.message);
      return { sent: false, reason: 'rejected' };
    }
    return { sent: true };
  } catch (err) {
    console.warn('[SMS] could not send:', err.message);
    return { sent: false, reason: 'error' };
  }
};
