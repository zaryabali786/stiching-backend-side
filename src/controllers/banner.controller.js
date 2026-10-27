import { supabaseAdmin } from '../config/supabase.js';
import { catchAsync, ApiResponse, BadRequestError } from '../utils/error.helper.js';
import { unwrap, unwrapOne } from '../utils/db.js';
import { uploadCatalogueImage, removeStoredFile } from '../services/storage.service.js';

/**
 * Home-page banners. The admin manages them (/admin/banners); customers only get the active ones
 * (/client/banners). Tapping a banner opens its `link_url`.
 */

const cleanTitle = (value) => {
  const title = String(value ?? '').replace(/\s+/g, ' ').trim();
  if (title.length > 120) throw new BadRequestError('The title must be 120 characters or fewer.');
  return title || null;
};

const HEX = /^#[0-9a-fA-F]{6}$/;
const oneLine = (max) => (value) => Array.from(String(value ?? '').replace(/\s+/g, ' ').trim()).slice(0, max).join('');
const percent = (value) => {
  const n = Math.round(Number(value));
  return Number.isFinite(n) ? Math.min(100, Math.max(0, n)) : 50;
};
const hex = (fallback) => (value) => (HEX.test(String(value)) ? String(value).toUpperCase() : fallback);

/** A banner link is a full http(s) address, a page inside the customer app (/app/orders/new), or empty for a banner that is not clickable. */
const cleanLink = (value) => {
  const link = String(value ?? '').trim();
  if (!link) return null;
  if (/^\/app\/[\w\-/]*$/.test(link)) return link;
  let url;
  try {
    url = new URL(link);
  } catch {
    throw new BadRequestError('Enter a full address like https://example.com/sale, or pick a page inside the app.');
  }
  if (!['http:', 'https:'].includes(url.protocol)) throw new BadRequestError('The link must start with http:// or https://.');
  return url.toString();
};

/**
 * The words and look of the text on a banner. `partial` (an edit) keeps only what was sent; a new banner gets every field with its default.
 * The button link is checked like the banner link: a full web address or a page inside the app.
 */
export const cleanBannerCopy = (body = {}, { partial = false } = {}) => {
  const rules = {
    heading: (v) => oneLine(80)(v) || null,
    subheading: (v) => oneLine(160)(v) || null,
    button_label: (v) => oneLine(40)(v) || null,
    button_link: cleanLink,
    text_color: hex('#FFFFFF'),
    button_bg: hex('#FFFFFF'),
    button_color: hex('#62003E'),
    overlay: (v) => {
      const n = Math.round(Number(v));
      return Number.isFinite(n) ? Math.min(80, Math.max(0, n)) : 35;
    },
    text_align: (v) => (v === 'center' ? 'center' : 'left'),
    // the part of the picture that stays in view (percent across and down; 50 / 50 = the middle)
    focus_x: percent,
    focus_y: percent,
  };
  const out = {};
  for (const [key, clean] of Object.entries(rules)) {
    if (partial && !(key in body)) continue;
    out[key] = clean(body[key]);
  }
  return out;
};

/** What a customer's app gets of a banner: the picture, where it goes, and the text with its look (a column that is not there yet gives the defaults). */
const publicBanner = (b) => ({
  id: b.id,
  title: b.title,
  image_url: b.image_url,
  link_url: b.link_url,
  ...cleanBannerCopy({ heading: b.heading, subheading: b.subheading, button_label: b.button_label, button_link: b.button_link ?? '', text_color: b.text_color, button_bg: b.button_bg, button_color: b.button_color, overlay: b.overlay ?? 35, text_align: b.text_align, focus_x: b.focus_x, focus_y: b.focus_y }),
});

/** A column the newest banner features need is not in the database yet: say which update to run, instead of a database message. */
const missingColumn = (error) => {
  const m = String(error?.message || '');
  if (!/column|schema cache/i.test(m)) return;
  if (/focus_[xy]/.test(m)) throw new BadRequestError('Run the latest database update first: 0050_banner_focus.sql (Supabase > SQL editor).');
  if (/heading|subheading|button_|text_color|text_align|overlay/.test(m)) throw new BadRequestError('Run the latest database update first: 0049_banner_text.sql (Supabase > SQL editor).');
};

export const getBanners = catchAsync(async (req, res) => {
  const rows = unwrap(
    await supabaseAdmin.from('banners').select('*').order('sort_order', { ascending: true }).order('created_at', { ascending: false }),
    'Could not load banners'
  );
  return ApiResponse.success(res, rows, 'Banners');
});

export const createBanner = catchAsync(async (req, res) => {
  const upload = req.body?.image_upload;
  if (!upload?.dataUrl) throw new BadRequestError('Choose a banner picture.');
  const fields = { title: cleanTitle(req.body.title), link_url: cleanLink(req.body.link_url), ...cleanBannerCopy(req.body) };
  const stored = await uploadCatalogueImage('banners', upload);

  const { data: last } = await supabaseAdmin.from('banners').select('sort_order').order('sort_order', { ascending: false }).limit(1).maybeSingle();
  const result = await supabaseAdmin
    .from('banners')
    .insert({ ...fields, image_url: stored.url, image_path: stored.path, sort_order: (last?.sort_order ?? -1) + 1, is_active: req.body.is_active !== false })
    .select('*')
    .single();
  if (result.error) {
    await removeStoredFile('evidence', stored.path);
    missingColumn(result.error);
  }
  return ApiResponse.created(res, unwrap(result, 'Could not add the banner'), 'Banner added.');
});

export const updateBanner = catchAsync(async (req, res) => {
  const current = unwrapOne(await supabaseAdmin.from('banners').select('*').eq('id', req.params.id).maybeSingle(), 'Banner not found');
  const patch = { updated_at: new Date().toISOString() };
  if ('title' in req.body) patch.title = cleanTitle(req.body.title);
  if ('link_url' in req.body) patch.link_url = cleanLink(req.body.link_url);
  Object.assign(patch, cleanBannerCopy(req.body, { partial: true }));
  if (typeof req.body.is_active === 'boolean') patch.is_active = req.body.is_active;
  if (Number.isInteger(req.body.sort_order)) patch.sort_order = req.body.sort_order;

  let replaced = null;
  if (req.body.image_upload?.dataUrl) {
    replaced = await uploadCatalogueImage('banners', req.body.image_upload);
    patch.image_url = replaced.url;
    patch.image_path = replaced.path;
  }

  const result = await supabaseAdmin.from('banners').update(patch).eq('id', current.id).select('*').single();
  if (result.error) {
    if (replaced) await removeStoredFile('evidence', replaced.path);
    missingColumn(result.error);
  } else if (replaced && current.image_path) {
    await removeStoredFile('evidence', current.image_path);
  }
  return ApiResponse.success(res, unwrap(result, 'Could not update the banner'), 'Banner updated.');
});

export const deleteBanner = catchAsync(async (req, res) => {
  const current = unwrapOne(await supabaseAdmin.from('banners').select('id, image_path').eq('id', req.params.id).maybeSingle(), 'Banner not found');
  unwrap(await supabaseAdmin.from('banners').delete().eq('id', current.id));
  await removeStoredFile('evidence', current.image_path);
  return ApiResponse.success(res, null, 'Banner deleted.');
});

/** Customer app: active banners in the order the admin arranged them. */
export const getActiveBanners = catchAsync(async (req, res) => {
  const rows = unwrap(
    await supabaseAdmin.from('banners').select('*').eq('is_active', true).order('sort_order', { ascending: true }).order('created_at', { ascending: false }),
    'Could not load banners'
  );
  return ApiResponse.success(res, rows.map(publicBanner), 'Banners');
});
