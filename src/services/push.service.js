import { readFileSync } from 'node:fs';
import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getMessaging } from 'firebase-admin/messaging';
import { config } from '../config/env.js';
import { supabaseAdmin } from '../config/supabase.js';

/** The picture of a browser notification and its small badge: the Stitch&Ship mark, served by the customer site. */
const webIcons = () => {
  const base = String(config.urls?.clientApp || '').replace(/\/$/, '');
  return base ? { icon: `${base}/assets/icon/notification-192.png`, badge: `${base}/assets/icon/badge-96.png` } : {};
};

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

/**
 * Push one notification (`{ title, body, link, type, orderId, id, imageUrl, priority }`) to every device of ONE user and report what
 * Firebase answered: { status: 'sent' | 'failed' | 'no_device' | 'off', devices, delivered, error }.
 * It never throws. 'sent' means Firebase accepted it for at least one device; it does not prove the phone showed or opened it.
 */
export const pushToUserDetailed = async (userId, n) => {
  try {
    const fcm = getFcm();
    if (!fcm || !userId) return { status: 'off', devices: 0, delivered: 0, error: 'Push is not set up on the server.' };
    const { data, error } = await supabaseAdmin.from('push_devices').select('token').eq('user_id', userId);
    if (error) throw error;
    const tokens = (data || []).map((d) => d.token);
    if (!tokens.length) return { status: 'no_device', devices: 0, delivered: 0, error: null };

    const orderId = n.orderId || n.order_id || '';
    const notificationId = n.id || '';
    const imageUrl = n.imageUrl || n.image_url || '';
    const urgent = n.priority === 'urgent';
    const res = await fcm.sendEachForMulticast({
      tokens,
      notification: { title: n.title, ...(n.body ? { body: n.body } : {}), ...(imageUrl ? { imageUrl } : {}) },
      // everything in `data` must be a string; the apps open `link` when the notification is tapped, and only when
      // `userId` is still the signed-in user (a device that switched accounts must not open somebody else's page)
      data: {
        link: n.link || '',
        type: n.type || 'update',
        orderId,
        notificationId,
        priority: urgent ? 'urgent' : 'normal',
        userId: String(userId),
      },
      // a retried send replaces the earlier tray entry instead of stacking a copy (tag = notification id)
      // Android: the small mark in the status bar is the white Stitch&Ship shape in the app (drawable ic_stat_logo), in the brand's dark red
      android: { priority: 'high', notification: { channelId: 'default', icon: 'ic_stat_logo', color: '#62003E', ...(imageUrl ? { imageUrl } : {}), ...(notificationId ? { tag: notificationId } : {}) } },
      // iOS: delivered through APNs (the APNs key is uploaded in Firebase). Same collapse-id as above; thread-id groups one order
      apns: {
        headers: { 'apns-priority': '10', 'apns-push-type': 'alert', ...(notificationId ? { 'apns-collapse-id': notificationId.slice(0, 64) } : {}) },
        payload: { aps: { sound: 'default', 'thread-id': orderId || n.type || 'update', ...(imageUrl ? { 'mutable-content': 1 } : {}) } },
        ...(imageUrl ? { fcmOptions: { imageUrl } } : {}),
      },
      webpush: { notification: { ...webIcons(), ...(imageUrl ? { image: imageUrl } : {}), ...(urgent ? { requireInteraction: true } : {}) }, fcmOptions: n.link ? { link: n.link } : undefined },
    });

    const dead = [];
    const problems = new Map(); // error code -> how many devices (anything that is not just a stale token: wrong project, API off, ...)
    res.responses.forEach((r, i) => {
      if (r.success) return;
      if (DEAD_TOKEN_CODES.has(r.error?.code)) dead.push(tokens[i]);
      else problems.set(r.error?.code || 'unknown', (problems.get(r.error?.code || 'unknown') || 0) + 1);
    });
    // visible in `pm2 logs`: a push that silently never arrives is the hardest thing to debug
    if (problems.size) console.warn(`[Push] FCM rejected ${[...problems].map(([c, n]) => `${c} x${n}`).join(', ')} (user ${userId})`);
    else if (process.env.PUSH_LOG === 'true') console.log(`[Push] sent to ${tokens.length - dead.length}/${tokens.length} device(s) of user ${userId}: ${n.title}`);
    if (dead.length) await supabaseAdmin.from('push_devices').delete().in('token', dead);
    const delivered = res.successCount;
    const reason = [...problems].map(([c, k]) => `${c} x${k}`).join(', ') || (dead.length ? 'The device registration had expired.' : null);
    return { status: delivered > 0 ? 'sent' : 'failed', devices: tokens.length, delivered, error: delivered > 0 ? null : reason };
  } catch (err) {
    console.warn('[Push] send failed:', err.message);
    return { status: 'failed', devices: 0, delivered: 0, error: String(err.message || 'Push failed').slice(0, 200) };
  }
};

/** Push one notification to every device of ONE user (fire and forget: the answer is not needed). */
export const pushToUser = async (userId, n) => {
  await pushToUserDetailed(userId, n);
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
