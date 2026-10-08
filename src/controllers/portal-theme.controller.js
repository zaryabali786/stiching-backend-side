import { randomUUID } from 'node:crypto';
import { supabaseAdmin } from '../config/supabase.js';
import { catchAsync, ApiResponse, BadRequestError } from '../utils/error.helper.js';

/**
 * Look of the admin and partner portals, set by the admin only (Setup > Portal theme) and delivered to every
 * signed-in portal user through GET /api/config (`portalTheme`). Stored in platform_settings under `portal_theme`.
 * Nothing is applied until the admin saves a theme, so the portals keep their built-in look until then.
 */

export const PORTAL_THEME_KEY = 'portal_theme';

export const PRESETS_KEY = 'portal_theme_presets';
const MAX_PRESETS = 12;

/** Google Fonts the admin can pick from (all offer the 400-700 weights the portals use). */
export const PORTAL_FONTS = {
  sans: ['Inter', 'Poppins', 'Roboto', 'Open Sans', 'Montserrat', 'Nunito', 'DM Sans', 'Manrope', 'Jost', 'Lato'],
  serif: ['Playfair Display', 'Cormorant Garamond', 'Lora', 'Merriweather'],
};
const ALL_FONTS = [...PORTAL_FONTS.sans, ...PORTAL_FONTS.serif];

export const PORTAL_THEME_DEFAULTS = {
  sidebar_bg: '#0F2219', // sidebar background
  sidebar_text: '#B8C4BD', // sidebar menu text and icons
  sidebar_active_bg: '#27382F', // background of the selected menu item
  sidebar_accent: '#7FD3A8', // selected item's marker, icon and focus ring
  primary: '#17362A', // buttons, selected tabs, avatar
  primary_text: '#FFFFFF', // text on buttons
  page_bg: '#F6F3EE', // background of every page
  card_bg: '#FFFFFF', // cards, tables, forms
  heading_font: 'Playfair Display', // page titles and headings
  heading_size: 30, // page title size in px
  body_font: 'Inter', // everything else: text, descriptions, tables, buttons
  body_size: 14, // text size in px
};

const COLOR_KEYS = ['sidebar_bg', 'sidebar_text', 'sidebar_active_bg', 'sidebar_accent', 'primary', 'primary_text', 'page_bg', 'card_bg'];
const HEX = /^#[0-9a-fA-F]{6}$/;

const clean = (input = {}) => {
  const out = {};
  for (const key of COLOR_KEYS) {
    if (input[key] === undefined) continue;
    if (!HEX.test(String(input[key]))) throw new BadRequestError('Colours must look like #1A2B3C.');
    out[key] = String(input[key]).toUpperCase();
  }
  for (const key of ['heading_font', 'body_font']) {
    if (input[key] === undefined) continue;
    if (!ALL_FONTS.includes(input[key])) throw new BadRequestError('Choose the font from the list.');
    out[key] = input[key];
  }
  const size = (key, min, max, label) => {
    if (input[key] === undefined) return;
    const n = Number(input[key]);
    if (!Number.isFinite(n) || n < min || n > max) throw new BadRequestError(`${label} must be between ${min} and ${max}.`);
    out[key] = Math.round(n);
  };
  size('heading_size', 22, 44, 'Heading size');
  size('body_size', 12, 18, 'Text size');
  return out;
};

/** The saved theme merged over the defaults, or null when the admin never saved one. */
export const loadPortalTheme = async () => {
  try {
    const { data } = await supabaseAdmin.from('platform_settings').select('value').eq('key', PORTAL_THEME_KEY).maybeSingle();
    if (!data?.value) return null;
    return { ...PORTAL_THEME_DEFAULTS, ...clean(data.value) };
  } catch {
    return null;
  }
};

const loadPresets = async () => {
  try {
    const { data } = await supabaseAdmin.from('platform_settings').select('value').eq('key', PRESETS_KEY).maybeSingle();
    const items = Array.isArray(data?.value?.items) ? data.value.items : [];
    return items.map((p) => ({ id: String(p.id), name: String(p.name), theme: { ...PORTAL_THEME_DEFAULTS, ...clean(p.theme || {}) } }));
  } catch {
    return [];
  }
};

const savePresets = async (items, userId) => {
  const { error } = await supabaseAdmin
    .from('platform_settings')
    .upsert({ key: PRESETS_KEY, value: { items }, updated_by: userId, updated_at: new Date().toISOString() });
  if (error) throw new BadRequestError('Could not save your theme.');
};

const payload = async () => {
  const saved = await loadPortalTheme();
  return { theme: saved ?? { ...PORTAL_THEME_DEFAULTS }, defaults: PORTAL_THEME_DEFAULTS, saved: !!saved, fonts: PORTAL_FONTS, presets: await loadPresets() };
};

export const getPortalTheme = catchAsync(async (req, res) => ApiResponse.success(res, await payload(), 'Portal theme'));

export const setPortalTheme = catchAsync(async (req, res) => {
  const theme = { ...PORTAL_THEME_DEFAULTS, ...clean(req.body || {}) };
  const { error } = await supabaseAdmin
    .from('platform_settings')
    .upsert({ key: PORTAL_THEME_KEY, value: theme, updated_by: req.userId, updated_at: new Date().toISOString() });
  if (error) throw new BadRequestError('Could not save the portal theme.');
  return ApiResponse.success(res, await payload(), 'Portal theme saved. Everyone sees it the next time the portal opens.');
});

export const resetPortalTheme = catchAsync(async (req, res) => {
  const { error } = await supabaseAdmin.from('platform_settings').delete().eq('key', PORTAL_THEME_KEY);
  if (error) throw new BadRequestError('Could not reset the portal theme.');
  return ApiResponse.success(res, await payload(), 'Portal theme reset to the original look.');
});

/** POST /settings/portal-theme/presets { name, theme } — keep the current look as your own ready-made theme. */
export const createPortalPreset = catchAsync(async (req, res) => {
  const name = String(req.body?.name ?? '').trim().replace(/\s+/g, ' ');
  if (name.length < 2 || name.length > 40) throw new BadRequestError('Give the theme a name (2 to 40 characters).');
  const items = await loadPresets();
  if (items.length >= MAX_PRESETS) throw new BadRequestError(`You can keep up to ${MAX_PRESETS} of your own themes. Delete one first.`);
  if (items.some((p) => p.name.toLowerCase() === name.toLowerCase())) throw new BadRequestError('You already have a theme with that name.');
  items.push({ id: randomUUID(), name, theme: { ...PORTAL_THEME_DEFAULTS, ...clean(req.body?.theme || {}) } });
  await savePresets(items, req.userId);
  return ApiResponse.success(res, await payload(), `"${name}" saved to your themes.`);
});

/** DELETE /settings/portal-theme/presets/:id */
export const deletePortalPreset = catchAsync(async (req, res) => {
  const items = await loadPresets();
  const next = items.filter((p) => p.id !== req.params.id);
  if (next.length === items.length) throw new BadRequestError('That theme no longer exists.');
  await savePresets(next, req.userId);
  return ApiResponse.success(res, await payload(), 'Theme deleted.');
});
