import { lookup } from 'node:dns/promises';
import net from 'node:net';
import { extractOrderWithAi, isAiConfigured, httpUrl } from './ai.service.js';

/**
 * Reads a product page link (title, price, image) the customer pasted.
 * Order: JSON-LD Product → Open Graph / product meta → Shopify ".js" endpoint → AI on page text.
 * Fetching arbitrary URLs from the server is guarded against SSRF: public http(s) hosts only,
 * every redirect re-checked, small response cap, short timeout.
 */

const MAX_BYTES = 2 * 1024 * 1024;
const TIMEOUT_MS = 12_000;
const MAX_REDIRECTS = 4;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';

// Known Pakistani brand sites → display name (falls back to the site name / domain)
const BRAND_HOSTS = [
  [/sapphireonline/, 'Sapphire'], [/khaadi/, 'Khaadi'], [/gulahmed/, 'Gul Ahmed'], [/alkaram/, 'Alkaram'],
  [/izel/, 'Izel Apparel'], [/mariab/, 'Maria B'], [/sanasafinaz/, 'Sana Safinaz'], [/limelight/, 'Limelight'],
  [/nishat/, 'Nishat Linen'], [/bareeze/, 'Bareeze'], [/agha-?noor/, 'Agha Noor'], [/zellbury/, 'Zellbury'],
  [/junaidjamshed|jdot/, 'J.'], [/beechtree/, 'Beechtree'], [/bonanzasatrangi/, 'Bonanza Satrangi'], [/asimjofa/, 'Asim Jofa'],
  [/baroque/, 'Baroque'], [/crossstitch/, 'Cross Stitch'], [/saya/, 'Saya'], [/edenrobe/, 'Edenrobe'], [/ethnc|ethnic/, 'Ethnic'],
];

// ─────────── SSRF guard ───────────

const isPrivateIp = (ip) => {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  const v6 = ip.toLowerCase();
  if (v6.startsWith('::ffff:')) return isPrivateIp(v6.slice(7));
  return v6 === '::1' || v6 === '::' || v6.startsWith('fc') || v6.startsWith('fd') || v6.startsWith('fe80');
};

const assertPublicUrl = async (raw) => {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('Not a valid link.');
  }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Only http(s) links are supported.');
  if (url.port && !['80', '443'].includes(url.port)) throw new Error('This link is not allowed.');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal')) throw new Error('This link is not allowed.');
  const addrs = net.isIP(host) ? [{ address: host }] : await lookup(host, { all: true }).catch(() => []);
  if (!addrs.length) throw new Error('That website could not be found.');
  if (addrs.some((a) => isPrivateIp(a.address))) throw new Error('This link is not allowed.');
  return url;
};

const readCapped = async (res) => {
  const reader = res.body?.getReader();
  if (!reader) return '';
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    chunks.push(value);
    if (size >= MAX_BYTES) {
      await reader.cancel().catch(() => {});
      break;
    }
  }
  return Buffer.concat(chunks).toString('utf8');
};

/** GET a public URL following redirects safely. @returns {{ url: string, text: string, contentType: string }} */
const safeGet = async (raw, accept = 'text/html,application/xhtml+xml') => {
  let current = raw;
  for (let i = 0; i <= MAX_REDIRECTS; i++) {
    const url = await assertPublicUrl(current);
    const res = await fetch(url, {
      redirect: 'manual',
      headers: { 'user-agent': UA, accept, 'accept-language': 'en-GB,en;q=0.9' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      current = new URL(res.headers.get('location'), url).toString();
      continue;
    }
    if (!res.ok) throw new Error(res.status === 403 || res.status === 429 ? 'The shop blocked automatic reading.' : `The page returned ${res.status}.`);
    return { url: url.toString(), text: await readCapped(res), contentType: res.headers.get('content-type') || '' };
  }
  throw new Error('Too many redirects.');
};

// ─────────── HTML parsing ───────────

export const decodeEntities = (s = '') =>
  s.replace(/&(#x?[0-9a-f]+|amp|lt|gt|quot|apos|nbsp|#39);/gi, (m, e) => {
    const k = e.toLowerCase();
    if (k === 'amp') return '&';
    if (k === 'lt') return '<';
    if (k === 'gt') return '>';
    if (k === 'quot') return '"';
    if (k === 'apos' || k === '#39') return "'";
    if (k === 'nbsp') return ' ';
    const code = k.startsWith('#x') ? parseInt(k.slice(2), 16) : parseInt(k.slice(1), 10);
    return Number.isFinite(code) ? String.fromCodePoint(code) : m;
  });

const metaContent = (html, ...names) => {
  for (const name of names) {
    const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re1 = new RegExp(`<meta[^>]+(?:property|name|itemprop)=["']${esc}["'][^>]*content=["']([^"']*)["']`, 'i');
    const re2 = new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]*(?:property|name|itemprop)=["']${esc}["']`, 'i');
    const m = re1.exec(html) || re2.exec(html);
    if (m?.[1]?.trim()) return decodeEntities(m[1].trim());
  }
  return null;
};

const findProductNode = (node, depth = 0) => {
  if (!node || depth > 6) return null;
  if (Array.isArray(node)) {
    for (const n of node) {
      const found = findProductNode(n, depth + 1);
      if (found) return found;
    }
    return null;
  }
  if (typeof node !== 'object') return null;
  const type = [].concat(node['@type'] || []).map(String);
  if (type.includes('Product') || type.includes('ProductGroup')) return node;
  return findProductNode(node['@graph'], depth + 1) || findProductNode(node.mainEntity, depth + 1);
};

const fromJsonLd = (html) => {
  const blocks = html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi);
  for (const [, json] of blocks) {
    let data;
    try {
      data = JSON.parse(json.trim());
    } catch {
      continue;
    }
    const p = findProductNode(data);
    if (!p) continue;
    const variant = Array.isArray(p.hasVariant) ? p.hasVariant[0] : null;
    const offersRaw = p.offers || variant?.offers;
    const offer = Array.isArray(offersRaw) ? offersRaw[0] : offersRaw?.offers?.[0] || offersRaw;
    const image = [].concat(p.image || variant?.image || [])[0];
    return {
      title: p.name ? decodeEntities(String(p.name)) : null,
      unit_price: offer?.price ?? offer?.lowPrice ?? offer?.priceSpecification?.price ?? null,
      currency: offer?.priceCurrency ?? offer?.priceSpecification?.priceCurrency ?? null,
      image_url: typeof image === 'string' ? image : image?.url || image?.contentUrl || null,
      sku: p.sku || variant?.sku || null,
      brand: typeof p.brand === 'string' ? p.brand : p.brand?.name || null,
    };
  }
  return null;
};

const fromMeta = (html) => {
  const title = metaContent(html, 'og:title', 'twitter:title') || decodeEntities(/<title[^>]*>([^<]*)<\/title>/i.exec(html)?.[1]?.trim() || '') || null;
  return {
    title,
    unit_price: metaContent(html, 'product:price:amount', 'og:price:amount', 'price'),
    currency: metaContent(html, 'product:price:currency', 'og:price:currency', 'priceCurrency'),
    image_url: metaContent(html, 'og:image:secure_url', 'og:image', 'twitter:image'),
    site_name: metaContent(html, 'og:site_name', 'application-name'),
  };
};

/** Shopify stores expose  /products/<handle>.js  with price in minor units. */
const fromShopify = async (pageUrl) => {
  const u = new URL(pageUrl);
  const m = /\/products\/([^/?#]+)/.exec(u.pathname);
  if (!m) return null;
  const { text } = await safeGet(`${u.origin}/products/${m[1]}.js`, 'application/json');
  const p = JSON.parse(text);
  const variant = p.variants?.[0];
  return {
    title: p.title || null,
    unit_price: typeof p.price === 'number' ? p.price / 100 : null,
    image_url: p.featured_image ? (p.featured_image.startsWith('//') ? `https:${p.featured_image}` : p.featured_image) : null,
    sku: variant?.sku || null,
    brand: p.vendor || null,
  };
};

const visibleText = (html) =>
  decodeEntities(
    html
      .replace(/<(script|style|noscript|svg)[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
  ).replace(/\s+/g, ' ').trim();

export const brandFromHost = (url, siteName) => {
  let host = '';
  try {
    host = new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return siteName || null;
  }
  const known = BRAND_HOSTS.find(([re]) => re.test(host));
  if (known) return known[1];
  if (siteName) return siteName.slice(0, 80);
  const root = host.split('.').slice(-3).find((p) => !['pk', 'com', 'co', 'uk', 'shop', 'store', 'online', 'www', 'net'].includes(p)) || host;
  return root.charAt(0).toUpperCase() + root.slice(1);
};

const titleFromSlug = (url) => {
  try {
    const seg = new URL(url).pathname.split('/').filter(Boolean).pop() || '';
    const words = decodeURIComponent(seg).replace(/\.(html?|aspx?|php)$/i, '').replace(/[-_]+/g, ' ').replace(/\b\d{5,}\b/g, '').trim();
    return words ? words.charAt(0).toUpperCase() + words.slice(1, 120) : null;
  } catch {
    return null;
  }
};

/** "Lawn 3-Piece | Sapphire" → "Lawn 3-Piece" (only when the suffix is the shop's own name). */
const stripSiteSuffix = (title, names) => {
  if (!title) return null;
  const m = /^(.*\S)\s+[|–—-]\s+([^|–—]{2,60})$/.exec(title.trim());
  const suffix = m?.[2]?.toLowerCase();
  const isSite = suffix && names.filter(Boolean).some((n) => suffix.includes(n.toLowerCase()) || n.toLowerCase().includes(suffix));
  return (isSite ? m[1] : title).trim().slice(0, 160);
};

const absolute = (maybe, base) => {
  if (!maybe) return null;
  try {
    return httpUrl(new URL(maybe.startsWith('//') ? `https:${maybe}` : maybe, base).toString());
  } catch {
    return null;
  }
};

/**
 * @returns {Promise<{ url: string, ok: boolean, error: string|null, title: string|null, unit_price: number|string|null,
 *   currency: string|null, image_url: string|null, sku: string|null, brand: string|null, read_by: string }>}
 */
export const readProductLink = async (rawUrl) => {
  const url = httpUrl(rawUrl);
  const result = { url: url || rawUrl, ok: false, error: null, title: null, unit_price: null, currency: null, image_url: null, sku: null, brand: null, read_by: 'basic' };
  if (!url) return { ...result, error: 'Not a valid link.' };

  try {
    const page = await safeGet(url);
    const ld = fromJsonLd(page.text) || {};
    const meta = fromMeta(page.text);
    let data = { ...meta, ...Object.fromEntries(Object.entries(ld).filter(([, v]) => v != null && v !== '')) };
    result.read_by = 'page';

    if (data.unit_price == null || !data.title) {
      const shop = await fromShopify(page.url).catch(() => null);
      if (shop) data = { ...data, ...Object.fromEntries(Object.entries(shop).filter(([, v]) => v != null && v !== '')) };
    }
    if ((data.unit_price == null || !data.title) && isAiConfigured()) {
      const ai = await extractOrderWithAi(
        [{ type: 'text', text: `Page: ${page.url}\nTitle: ${data.title || ''}\n\n${visibleText(page.text).slice(0, 20_000)}` }],
        'This is a single product page. Return it as one item (quantity 1) with its current price and currency.'
      ).catch(() => null);
      const item = ai?.items?.[0];
      if (item) {
        data = { ...data, title: data.title || item.title, unit_price: data.unit_price ?? item.unit_price, currency: data.currency || ai.currency, image_url: data.image_url || item.image_url };
        result.read_by = 'ai';
      }
    }

    const brand = brandFromHost(page.url, data.brand || data.site_name);
    Object.assign(result, {
      ok: !!data.title,
      title: stripSiteSuffix(data.title, [brand, data.site_name]) || titleFromSlug(page.url),
      unit_price: data.unit_price,
      currency: data.currency,
      image_url: absolute(data.image_url, page.url),
      sku: data.sku || null,
      brand,
    });
    if (!result.ok) result.error = "We couldn't read this page — check the name below.";
  } catch (err) {
    result.error = err.name === 'TimeoutError' ? 'The shop took too long to answer.' : err.message;
    result.title = titleFromSlug(url);
    result.brand = brandFromHost(url);
  }
  return result;
};
