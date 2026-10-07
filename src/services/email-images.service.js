import { createHash } from 'node:crypto';
import { httpUrl } from './ai.service.js';
import { downloadImage, readProductLink } from './product-page.service.js';
import { uploadPublicImage } from './storage.service.js';

/**
 * Finds the product pictures of an order email and saves them with the order.
 *
 * Where a picture can come from, in order:
 *   1. the AI read it next to the product (image_url)
 *   2. an <img> in the email whose alt text names the product, or - when there are exactly as many
 *      product pictures as products - the pictures in order. Inline (cid:) pictures are the email's attachments.
 *   3. the product's own page (og:image), when the email links to it
 * Every picture is copied into our storage so it never breaks later (email CDNs expire links).
 */

const MAX_IMAGES = 12;
const NOT_A_PRODUCT = /(logo|pixel|spacer|beacon|tracking|track\.|open\.(gif|png)|facebook|twitter|instagram|youtube|pinterest|tiktok|whatsapp|linkedin|badge|banner|footer|header|icons?[/_.-]|emoji)/i;

const attr = (tag, name) => new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(tag)?.slice(1).find((v) => v !== undefined) ?? null;
const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const decode = (s) => String(s || '').replace(/&amp;/g, '&').replace(/&#x2F;/gi, '/').replace(/&#47;/g, '/');

/** Pictures in the email that look like products (not logos, social icons or tracking pixels), in page order. */
export const imageCandidates = (html) => {
  const found = [];
  const seen = new Set();
  for (const m of String(html || '').matchAll(/<img\b[^>]*>/gi)) {
    const tag = m[0];
    const src = decode(attr(tag, 'src') || attr(tag, 'data-src') || '').trim();
    const alt = decode(attr(tag, 'alt') || '').trim();
    if (!src || seen.has(src)) continue;
    const isCid = /^cid:/i.test(src);
    if (!isCid && !/^https?:\/\//i.test(src)) continue; // data: and relative pictures can't be reused
    const w = parseInt(attr(tag, 'width') || '', 10);
    const h = parseInt(attr(tag, 'height') || '', 10);
    if ((w && w < 60) || (h && h < 60)) continue; // spacers and icons
    if (NOT_A_PRODUCT.test(src) || NOT_A_PRODUCT.test(alt)) continue;
    seen.add(src);
    found.push({ src, alt: isCid ? alt : alt, cid: isCid ? src.slice(4).replace(/^<|>$/g, '') : null });
    if (found.length >= MAX_IMAGES) break;
  }
  return found;
};

/** Copy one picture (a web link or an inline attachment) into our public storage; null when it can't be used. */
const saveImage = async (userId, source, attachments) => {
  try {
    let buffer;
    let mime;
    if (source.cid) {
      const a = attachments.find((x) => x.cid && x.cid.toLowerCase() === source.cid.toLowerCase() && /^image\//.test(x.mime || ''));
      if (!a?.base64) return null;
      buffer = Buffer.from(a.base64, 'base64');
      mime = a.mime;
    } else {
      ({ buffer, mime } = await downloadImage(source.src));
    }
    if (buffer.length < 1500) return null; // a tracking dot, not a product
    const name = createHash('sha1').update(buffer).digest('hex').slice(0, 16);
    return await uploadPublicImage(`email-products/${userId}`, name, buffer, mime);
  } catch (err) {
    console.warn('[Import] picture skipped:', err.message);
    return null;
  }
};

/**
 * Fill `image_url` of every product of `extracted` (mutates it). Best effort: a picture that can't be found or
 * saved simply leaves that product without one; this never throws.
 * @param {string} userId
 * @param {{ html?: string, attachments?: { cid?: string, mime?: string, base64?: string }[] }} email
 * @param {{ items: { title: string, url: string|null, image_url: string|null }[] }} extracted
 */
export const attachProductImages = async (userId, email, extracted) => {
  try {
    const items = extracted.items || [];
    const candidates = imageCandidates(email.html);
    const attachments = email.attachments || [];
    const used = new Set();

    // 1. what the AI already tied to a product
    for (const it of items) {
      it.image_url = httpUrl(it.image_url);
      if (it.image_url) {
        const i = candidates.findIndex((c) => c.src === it.image_url);
        if (i >= 0) used.add(i);
      }
    }

    // 2a. a picture whose alt text names the product
    for (const it of items) {
      if (it.image_url) continue;
      const t = norm(it.title);
      const i = candidates.findIndex((c, idx) => !used.has(idx) && norm(c.alt).length >= 4 && (t.includes(norm(c.alt)) || norm(c.alt).includes(t)));
      if (i >= 0) {
        used.add(i);
        it.image_url = candidates[i].src;
      }
    }

    // 2b. as many unused pictures as products still without one: they line up in order
    const missing = items.filter((it) => !it.image_url);
    const spare = candidates.map((c, idx) => ({ c, idx })).filter(({ idx }) => !used.has(idx));
    if (missing.length && spare.length === missing.length) missing.forEach((it, k) => (it.image_url = spare[k].c.src));

    // 3. the product's own page
    await Promise.all(
      items
        .filter((it) => !it.image_url && it.url)
        .slice(0, 6)
        .map(async (it) => {
          const page = await readProductLink(it.url).catch(() => null);
          if (page?.image_url) it.image_url = httpUrl(page.image_url);
        })
    );

    // Copy every chosen picture into our storage (the same picture on several products is saved once)
    const saved = new Map();
    for (const it of items) {
      if (!it.image_url) continue;
      if (!saved.has(it.image_url)) {
        const cand = candidates.find((c) => c.src === it.image_url);
        saved.set(it.image_url, await saveImage(userId, cand || { src: it.image_url, cid: null }, attachments));
      }
      const url = saved.get(it.image_url);
      // a cid: reference means nothing outside the email: drop it if it could not be saved
      it.image_url = url || (/^https?:/i.test(it.image_url) ? it.image_url : null);
    }
  } catch (err) {
    console.warn('[Import] product pictures failed:', err.message);
  }
  return extracted;
};
