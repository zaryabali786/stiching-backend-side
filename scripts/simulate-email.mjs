/**
 * Simulates a customer forwarding a brand order email, without a real mail provider.
 *   npm run email:test -- customer@v360.test
 * Needs INBOUND_EMAIL_ADDRESS and INBOUND_EMAIL_SECRET in backend/.env, the API running and the database set up.
 * Sends a Postmark-style inbound payload straight to your local API (no Postmark or public URL needed).
 */
import 'dotenv/config';
import crypto from 'node:crypto';
import { supabaseAdmin } from '../src/config/supabase.js';
import { getForwardAddress } from '../src/services/order-import.service.js';

const customerEmail = process.argv[2] || 'customer@v360.test';
const api = process.env.API_URL || `http://localhost:${process.env.PORT || 5000}/api`;
if (!(process.env.INBOUND_EMAIL_DOMAIN || process.env.INBOUND_EMAIL_ADDRESS) || !process.env.INBOUND_EMAIL_SECRET) {
  console.error('Set INBOUND_EMAIL_DOMAIN (e.g. mail.example.com) or INBOUND_EMAIL_ADDRESS, and INBOUND_EMAIL_SECRET in backend/.env first.');
  process.exit(1);
}

const { data: profile, error } = await supabaseAdmin.from('profiles').select('id, full_name').eq('email', customerEmail).maybeSingle();
if (error || !profile) {
  console.error(`No customer with email ${customerEmail}.`);
  process.exit(1);
}
const { address } = await getForwardAddress(profile.id);

const html = `
<p>---------- Forwarded message ---------<br>From: Sapphire &lt;orders@pk.sapphireonline.pk&gt;<br>Subject: Order #SP-482913 confirmed</p>
<h2>Thank you for your order, ${profile.full_name || 'customer'}!</h2>
<p>Order number: <b>SP-482913</b></p>
<table>
  <tr><th>Item</th><th>Qty</th><th>Price</th></tr>
  <tr><td><a href="https://pk.sapphireonline.pk/products/embroidered-lawn-3-piece">Embroidered Lawn Suit 3 Piece - U3PE-24</a></td><td>2</td><td>Rs. 8,990</td></tr>
  <tr><td>Printed Cambric Shirt 2 Piece - 2PDY-11</td><td>1</td><td>Rs. 5,490</td></tr>
  <tr><td>Shipping</td><td></td><td>Rs. 250</td></tr>
  <tr><td><b>Total</b></td><td></td><td><b>Rs. 23,720</b></td></tr>
</table>`;

// Same shape as Postmark's inbound webhook JSON
const to = address;
// Postmark only sets MailboxHash for  local+hash@domain  addresses
const mailboxHash = to.includes('+') ? to.split('+')[1].split('@')[0] : '';
const payload = {
  From: `${profile.full_name} <${customerEmail}>`,
  FromName: profile.full_name,
  FromFull: { Email: customerEmail, Name: profile.full_name },
  To: to,
  ToFull: [{ Email: to, Name: '', MailboxHash: mailboxHash }],
  OriginalRecipient: to,
  MailboxHash: mailboxHash,
  Subject: 'Fwd: Order #SP-482913 confirmed',
  MessageID: crypto.randomUUID(),
  Date: new Date().toUTCString(),
  TextBody: '',
  HtmlBody: html,
  Attachments: [],
};

// Postmark authenticates with basic auth in the webhook URL; the password is INBOUND_EMAIL_SECRET
const auth = Buffer.from(`inbound:${process.env.INBOUND_EMAIL_SECRET}`).toString('base64');
const res = await fetch(`${api}/inbound/email`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: `Basic ${auth}` },
  body: JSON.stringify(payload),
});
console.log(`POST /inbound/email to ${address} ->`, res.status, JSON.stringify(await res.json()));
console.log('Open the customer app → Inbox to see it (reading the order takes a few seconds).');
process.exit(0);
