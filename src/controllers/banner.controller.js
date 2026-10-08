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
  const fields = { title: cleanTitle(req.body.title), link_url: cleanLink(req.body.link_url) };
  const stored = await uploadCatalogueImage('banners', upload);

  const { data: last } = await supabaseAdmin.from('banners').select('sort_order').order('sort_order', { ascending: false }).limit(1).maybeSingle();
  const result = await supabaseAdmin
    .from('banners')
    .insert({ ...fields, image_url: stored.url, image_path: stored.path, sort_order: (last?.sort_order ?? -1) + 1, is_active: req.body.is_active !== false })
    .select('*')
    .single();
  if (result.error) await removeStoredFile('evidence', stored.path);
  return ApiResponse.created(res, unwrap(result, 'Could not add the banner'), 'Banner added.');
});

export const updateBanner = catchAsync(async (req, res) => {
  const current = unwrapOne(await supabaseAdmin.from('banners').select('*').eq('id', req.params.id).maybeSingle(), 'Banner not found');
  const patch = { updated_at: new Date().toISOString() };
  if ('title' in req.body) patch.title = cleanTitle(req.body.title);
  if ('link_url' in req.body) patch.link_url = cleanLink(req.body.link_url);
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
    await supabaseAdmin
      .from('banners')
      .select('id, title, image_url, link_url')
      .eq('is_active', true)
      .order('sort_order', { ascending: true })
      .order('created_at', { ascending: false }),
    'Could not load banners'
  );
  return ApiResponse.success(res, rows, 'Banners');
});
