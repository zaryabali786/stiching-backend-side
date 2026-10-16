import { readFileSync } from 'node:fs';
import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getMessaging } from 'firebase-admin/messaging';
import { config } from '../config/env.js';
import { supabaseAdmin } from '../config/supabase.js';

/**
 * Push notifications through Firebase Cloud Messaging.
 * A push only goes to the devices registered by the user the notification belongs to (push_devices.user_id).
 * Like every notification channel here it never throws: a failed push must not break the business action.
 */
let messaging;
let warned = false;

const loadCredentials = () => {
  const { serviceAccountJson, serviceAccountBase64, serviceAccountPath } = config.firebase;
  if (serviceAccountJson) return JSON.parse(serviceAccountJson);
  if (serviceAccountBase64) return JSON.parse(Buffer.from(serviceAccountBase64, 'base64').toString('utf8'));
  if (serviceAccountPath) return JSON.parse(readFileSync(serviceAccountPath, 'utf8'));
  return null;
};

const getFcm = () => {
  if (messaging !== undefined) return messaging;
  try {
    const credentials = loadCredentials();
    if (!credentials) throw new Error('no Firebase service account configured');
    const app = getApps()[0] || initializeApp({ credential: cert(credentials) });
    messaging = getMessaging(app);
  } catch (err) {
    messaging = null;
    if (!warned) console.warn(`[Push] switched off: ${err.message}`);
    warned = true;
  }
  return messaging;
};

export const pushEnabled = () => !!getFcm();

const DEAD_TOKEN_CODES = new Set(['messaging/registration-token-not-registered', 'messaging/invalid-registration-token', 'messaging/invalid-argument']);

/** Push one notification (`{ title, body, link, type, orderId, id }`) to every device of ONE user. */
export const pushToUser = async (userId, n) => {
  try {
    const fcm = getFcm();
    if (!fcm || !userId) return;
    const { data, error } = await supabaseAdmin.from('push_devices').select('token').eq('user_id', userId);
    if (error) throw error;
    const tokens = (data || []).map((d) => d.token);
    if (!tokens.length) return;

    const res = await fcm.sendEachForMulticast({
      tokens,
      notification: { title: n.title, ...(n.body ? { body: n.body } : {}) },
      // everything in `data` must be a string; the apps open `link` when the notification is tapped
      data: {
        link: n.link || '',
        type: n.type || 'update',
        orderId: n.orderId || n.order_id || '',
        notificationId: n.id || '',
      },
      android: { priority: 'high', notification: { channelId: 'default' } },
      webpush: { fcmOptions: n.link ? { link: n.link } : undefined },
    });

    const dead = [];
    res.responses.forEach((r, i) => {
      if (!r.success && DEAD_TOKEN_CODES.has(r.error?.code)) dead.push(tokens[i]);
    });
    if (dead.length) await supabaseAdmin.from('push_devices').delete().in('token', dead);
  } catch (err) {
    console.warn('[Push] send failed:', err.message);
  }
};

/** A device (phone or browser) signs in: it now belongs to this user only. */
export const registerDevice = async (userId, { token, platform, app }) => {
  const row = {
    user_id: userId,
    token,
    platform: ['android', 'ios', 'web'].includes(platform) ? platform : 'web',
    app: app === 'admin' ? 'admin' : 'client',
    last_seen_at: new Date().toISOString(),
  };
  // token is unique: if another user was signed in on this device, the row moves to the new user
  const { error } = await supabaseAdmin.from('push_devices').upsert(row, { onConflict: 'token' });
  if (error) throw error;
};

/** Sign-out: this device stops receiving the user's notifications (only that user's own row is removed). */
export const unregisterDevice = async (userId, token) => {
  const { error } = await supabaseAdmin.from('push_devices').delete().eq('user_id', userId).eq('token', token);
  if (error) throw error;
};
