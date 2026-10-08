import { randomUUID } from 'node:crypto';
import { supabaseAdmin } from '../config/supabase.js';
import { catchAsync, ApiResponse, BadRequestError } from '../utils/error.helper.js';
import { unwrap } from '../utils/db.js';
import { parseListQuery, sendPage } from '../utils/pagination.js';
import { uploadCatalogueImage } from '../services/storage.service.js';

/**
 * The customer app's home page is built from sections (announcement bar, banners, articles, ...) that the admin
 * arranges in Setup > Home layout. The layout lives in platform_settings under `home_layout`:
 *   { sections: [{ id, type, settings }] }
 * Articles shown in a section always come live from the catalogue (name + picture only: prices stay internal).
 */

export const LAYOUT_KEY = 'home_layout';
const MAX_SECTIONS = 30;
const HEX = /^#[0-9a-fA-F]{6}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const cut = (str, max) => Array.from(str).slice(0, max).join('');
const text = (max) => (v) => cut(String(v ?? '').replace(/\r/g, '').trim(), max);
const oneLine = (max) => (v) => cut(String(v ?? '').replace(/\s+/g, ' ').trim(), max);
const color = (fallback) => (v) => (HEX.test(String(v)) ? String(v).toUpperCase() : fallback);
const oneOf = (list, fallback) => (v) => (list.includes(v) ? v : fallback);
const bool = (fallback) => (v) => (typeof v === 'boolean' ? v : fallback);
const int = (min, max, fallback) => (v) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
};
/** An https address, or a path inside the customer app (/app/orders/new). Anything else is dropped. */
const link = (v) => {
  const s = String(v ?? '').trim();
  if (!s) return '';
  if (/^\/app\/[\w\-/]*$/.test(s)) return s;
  try {
    const u = new URL(s);
    return ['http:', 'https:'].includes(u.protocol) ? u.toString().slice(0, 500) : '';
  } catch {
    return '';
  }
};
const imageUrl = (v) => {
  const s = String(v ?? '').trim();
  return /^https?:\/\/\S+$/i.test(s) ? s.slice(0, 600) : '';
};
const uuidOrEmpty = (v) => (typeof v === 'string' && UUID.test(v) ? v : '');
const ids = (max) => (v) => (Array.isArray(v) ? [...new Set(v.filter((x) => typeof x === 'string' && UUID.test(x)))].slice(0, max) : []);

/** What each section type may store. Anything not listed here is discarded. */
const SCHEMAS = {
  announcement: {
    text: oneLine(200), image_url: imageUrl, link, bg: color('#0F172A'), color: color('#FFFFFF'),
    align: oneOf(['left', 'center'], 'center'), size: oneOf(['small', 'medium'], 'small'), dismissible: bool(true),
  },
  marquee: {
    text: oneLine(300), image_url: imageUrl, image_size: oneOf(['small', 'medium', 'large'], 'small'), link, bg: color('#C29848'), color: color('#FFFFFF'),
    speed: oneOf(['slow', 'normal', 'fast'], 'normal'), direction: oneOf(['left', 'right'], 'left'),
  },
  banners: { autoplay: bool(true) },
  hero: {
    image_url: imageUrl, heading: oneLine(120), subheading: oneLine(240), button_label: oneLine(40), button_link: link,
    overlay: int(0, 80, 35), align: oneOf(['left', 'center'], 'left'), height: oneOf(['small', 'medium', 'large'], 'medium'),
  },
  image_text: {
    image_url: imageUrl, heading: oneLine(120), body: text(600), button_label: oneLine(40), button_link: link,
    layout: oneOf(['image-left', 'image-right'], 'image-left'), bg: color('#FFFFFF'), color: color('#111827'),
  },
  articles: {
    title: oneLine(100), article_ids: ids(24), layout: oneOf(['image-left', 'image-right', 'grid', 'list', 'slider'], 'grid'),
    columns: int(1, 3, 2), autoplay: bool(false), button_label: oneLine(40), button_link: link,
  },
  // a featured collection: hand-picked articles, shown as a grid, a list or a swipeable slider
  collection: {
    title: oneLine(100), article_ids: ids(24), layout: oneOf(['grid', 'list', 'slider'], 'slider'),
    columns: int(1, 3, 2), autoplay: bool(false), button_label: oneLine(40), button_link: link,
  },
  custom: {
    heading: oneLine(120), body: text(1500), align: oneOf(['left', 'center'], 'left'),
    bg: color('#FFFFFF'), color: color('#111827'), button_label: oneLine(40), button_link: link,
  },
};

export const SECTION_TYPES = Object.keys(SCHEMAS);

/** Keep only known types and known, cleaned settings. Throws on a clearly wrong shape. */
export const cleanLayout = (input) => {
  const raw = Array.isArray(input?.sections) ? input.sections : null;
  if (!raw) throw new BadRequestError('The layout must contain a list of sections.');
  if (raw.length > MAX_SECTIONS) throw new BadRequestError(`A home page can have at most ${MAX_SECTIONS} sections.`);
  const seen = new Set();
  const sections = raw.map((s) => {
    const schema = SCHEMAS[s?.type];
    if (!schema) throw new BadRequestError(`Unknown section type "${s?.type}".`);
    let id = String(s.id || '').replace(/[^\w-]/g, '').slice(0, 40);
    if (!id || seen.has(id)) id = randomUUID();
    seen.add(id);
    const settings = {};
    for (const [key, clean] of Object.entries(schema)) settings[key] = clean(s.settings?.[key]);
    return { id, type: s.type, settings, hidden: s.hidden === true };
  });
  return { sections };
};

/** Until the admin saves a layout the home page shows just the banners, as before. */
const DEFAULT_LAYOUT = { sections: [{ id: 'banners-default', type: 'banners', settings: { autoplay: true }, hidden: false }] };

const loadLayout = async () => {
  try {
    const { data } = await supabaseAdmin.from('platform_settings').select('value').eq('key', LAYOUT_KEY).maybeSingle();
    return data?.value?.sections ? cleanLayout(data.value) : DEFAULT_LAYOUT;
  } catch {
    return DEFAULT_LAYOUT;
  }
};

const ARTICLE_FIELDS = 'id, name, image_url, article_type_id, type:article_types(id, name)';
const publicArticle = (a) => ({ id: a.id, name: a.name, image_url: a.image_url, type_id: a.article_type_id, type_name: a.type?.name || '' });

// ───────────── Admin ─────────────

/**
 * GET /admin/home-layout: the saved layout, the article types, and just the articles the layout already uses
 * (so the editor can show them). The full catalogue is searched page by page through /admin/home-layout/articles.
 */
export const getAdminHomeLayout = catchAsync(async (req, res) => {
  const layout = await loadLayout();
  const usedIds = [...new Set(layout.sections.flatMap((s) => s.settings.article_ids || []))];
  const articles = usedIds.length
    ? unwrap(await supabaseAdmin.from('articles').select(ARTICLE_FIELDS).in('id', usedIds), 'Could not load articles').map(publicArticle)
    : [];
  const types = unwrap(
    await supabaseAdmin.from('article_types').select('id, name').eq('status', 'active').order('sort_order', { ascending: true }).order('name', { ascending: true }),
    'Could not load article types'
  );
  return ApiResponse.success(res, { layout, articles, types, sectionTypes: SECTION_TYPES }, 'Home layout');
});

/** GET /admin/home-layout/articles?page&limit&search&type_id: the article picker. Search and paging happen in the database. */
export const listHomeArticles = catchAsync(async (req, res) => {
  const q = parseListQuery(req, { defaultLimit: 12, maxLimit: 40, sortable: ['name'], defaultSort: 'name', defaultDir: 'asc' });
  let query = supabaseAdmin
    .from('articles')
    .select(ARTICLE_FIELDS, { count: 'exact' })
    .eq('status', 'active')
    .order('name', { ascending: true })
    .range(q.from, q.to);
  const typeId = uuidOrEmpty(req.query.type_id);
  if (typeId) query = query.eq('article_type_id', typeId);
  if (q.search) query = query.ilike('name', `%${q.search}%`);
  const result = await query;
  return sendPage(res, unwrap(result, 'Could not load articles').map(publicArticle), q, result.count);
});

/** PUT /admin/home-layout  body: { sections } */
export const saveAdminHomeLayout = catchAsync(async (req, res) => {
  const layout = cleanLayout(req.body);
  const { error } = await supabaseAdmin
    .from('platform_settings')
    .upsert({ key: LAYOUT_KEY, value: layout, updated_by: req.userId, updated_at: new Date().toISOString() });
  if (error) throw new BadRequestError('Could not save. Run the latest database update (0008) first.');
  return ApiResponse.success(res, { layout }, 'Home page saved. Customers see it the next time they open the app.');
});

/** POST /admin/home-layout/image  body: { image_upload: { name, dataUrl } } → { url } for a hero / image + text section */
export const uploadHomeImage = catchAsync(async (req, res) => {
  const upload = req.body?.image_upload;
  if (!upload?.dataUrl) throw new BadRequestError('Choose a picture.');
  const { url } = await uploadCatalogueImage('home', upload);
  return ApiResponse.created(res, { url }, 'Picture uploaded.');
});

// ───────────── Customer app ─────────────

/** GET /client/home-layout: visible sections, with the chosen articles filled in from the catalogue. */
export const getClientHomeLayout = catchAsync(async (req, res) => {
  const layout = await loadLayout();
  const visible = layout.sections.filter((s) => !s.hidden);

  const picks = (s) => s.type === 'articles' || s.type === 'collection';
  const wantedIds = [...new Set(visible.filter(picks).flatMap((s) => s.settings.article_ids))];
  const byId = new Map();
  if (wantedIds.length) {
    const rows = unwrap(await supabaseAdmin.from('articles').select(ARTICLE_FIELDS).in('id', wantedIds).eq('status', 'active'), 'Could not load articles');
    rows.forEach((a) => byId.set(a.id, publicArticle(a)));
  }

  // chosen articles in the admin's order; one that was switched off or deleted just drops out
  const sections = visible.map((s) => (picks(s) ? { ...s, articles: s.settings.article_ids.map((id) => byId.get(id)).filter(Boolean) } : s));
  return ApiResponse.success(res, { sections }, 'Home layout');
});
