import { randomUUID } from 'node:crypto';
import { supabaseAdmin } from '../config/supabase.js';
import { catchAsync, ApiResponse, BadRequestError } from '../utils/error.helper.js';

/**
 * Look of the customer app, set by the admin (Setup > Appearance) and delivered to every customer through GET /api/config.
 * Stored in platform_settings under the key `client_theme`.
 */

export const THEME_KEY = 'client_theme';

/** Google Fonts the admin can pick from (all offer the 400-700 weights the app uses). */
export const THEME_FONTS = {
  sans: ['Jost', 'Inter', 'Poppins', 'Roboto', 'Open Sans', 'Montserrat', 'Nunito', 'DM Sans', 'Manrope'],
  serif: ['Cormorant Garamond', 'Playfair Display', 'Lora', 'Merriweather'],
};

export const THEME_DEFAULTS = {
  primary: '#0F172A', // active tab, buttons, links
  primary_text: '#FFFFFF', // text and icons on buttons and other main-colour surfaces
  primary_2: '#1E293B', // second colour of the main gradient (same as primary = solid)
  accent: '#7C5CBF', // soft cards: draft orders, order details, profile, inbox (faded tint, icons, highlights)
  badge_bg: '#EF4444', // the red count bubbles (inbox, notifications, draft orders)
  badge_bg_2: '#EF4444',
  badge_text: '#FFFFFF',
  notification_bg: '#1C2B23', // pop-up notifications (toasts)
  notification_bg_2: '#1C2B23',
  notification_text: '#FFFFFF',
  body_font: 'Jost',
  heading_font: 'Cormorant Garamond',
  font_size: 15, // body text in px; the other text sizes scale with it
  heading_size: 32, // page title in px; other headings scale with it
  button_style: 'solid', // 'solid' = filled buttons, 'outline' = outlined with a faded fill, 'fade' = faded fill only
};

export const BUTTON_STYLES = ['solid', 'outline', 'fade'];

const COLOR_KEYS = ['accent', 'primary', 'primary_text', 'primary_2', 'badge_bg', 'badge_bg_2', 'badge_text', 'notification_bg', 'notification_bg_2', 'notification_text'];
// a theme saved before the second colours existed stays a single solid colour
const PAIRS = [['primary', 'primary_2'], ['badge_bg', 'badge_bg_2'], ['notification_bg', 'notification_bg_2']];
const HEX = /^#[0-9a-fA-F]{6}$/;

const clean = (input = {}) => {
  const out = {};
  for (const key of COLOR_KEYS) {
    if (input[key] === undefined) continue;
    if (!HEX.test(String(input[key]))) throw new BadRequestError('Colours must look like #1A2B3C.');
    out[key] = String(input[key]).toUpperCase();
  }
  if (input.body_font !== undefined) {
    if (!THEME_FONTS.sans.includes(input.body_font)) throw new BadRequestError('Choose the body font from the list.');
    out.body_font = input.body_font;
  }
  if (input.heading_font !== undefined) {
    if (!THEME_FONTS.serif.includes(input.heading_font) && !THEME_FONTS.sans.includes(input.heading_font)) throw new BadRequestError('Choose the heading font from the list.');
    out.heading_font = input.heading_font;
  }
  if (input.button_style !== undefined) {
    if (!BUTTON_STYLES.includes(input.button_style)) throw new BadRequestError('Choose a button style from the list.');
    out.button_style = input.button_style;
  }
  if (input.heading_size !== undefined) {
    const size = Number(input.heading_size);
    if (!Number.isFinite(size) || size < 24 || size > 44) throw new BadRequestError('Heading size must be between 24 and 44.');
    out.heading_size = Math.round(size);
  }
  if (input.font_size !== undefined) {
    const size = Number(input.font_size);
    if (!Number.isFinite(size) || size < 13 || size > 19) throw new BadRequestError('Font size must be between 13 and 19.');
    out.font_size = Math.round(size);
  }
  return out;
};

/** The saved theme merged over the defaults; defaults when nothing is saved or the table is missing. */
export const loadClientTheme = async () => {
  try {
    const { data } = await supabaseAdmin.from('platform_settings').select('value').eq('key', THEME_KEY).maybeSingle();
    const saved = clean(data?.value || {});
    for (const [first, second] of PAIRS) if (saved[first] && !saved[second]) saved[second] = saved[first];
    return { ...THEME_DEFAULTS, ...saved };
  } catch {
    return { ...THEME_DEFAULTS };
  }
};

const PRESETS_KEY = 'client_theme_presets';
const MAX_PRESETS = 12;

const loadPresets = async () => {
  try {
    const { data } = await supabaseAdmin.from('platform_settings').select('value').eq('key', PRESETS_KEY).maybeSingle();
    const items = Array.isArray(data?.value?.items) ? data.value.items : [];
    return items.map((p) => ({ id: String(p.id), name: String(p.name), theme: { ...THEME_DEFAULTS, ...clean(p.theme || {}) } }));
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

const payload = async () => ({ theme: await loadClientTheme(), defaults: THEME_DEFAULTS, fonts: THEME_FONTS, presets: await loadPresets() });

export const getClientTheme = catchAsync(async (req, res) => ApiResponse.success(res, await payload(), 'Appearance'));

export const setClientTheme = catchAsync(async (req, res) => {
  const theme = { ...THEME_DEFAULTS, ...clean(req.body || {}) };
  const { error } = await supabaseAdmin
    .from('platform_settings')
    .upsert({ key: THEME_KEY, value: theme, updated_by: req.userId, updated_at: new Date().toISOString() });
  if (error) throw new BadRequestError('Could not save. Run the latest database update (0008) first.');
  return ApiResponse.success(res, await payload(), 'Appearance saved. Customers see it the next time the app opens.');
});

/** POST /settings/client-theme/presets { name, theme } — keep the current look as your own ready-made theme. */
export const createClientPreset = catchAsync(async (req, res) => {
  const name = String(req.body?.name ?? '').trim().replace(/\s+/g, ' ');
  if (name.length < 2 || name.length > 40) throw new BadRequestError('Give the theme a name (2 to 40 characters).');
  const items = await loadPresets();
  if (items.length >= MAX_PRESETS) throw new BadRequestError(`You can keep up to ${MAX_PRESETS} of your own themes. Delete one first.`);
  if (items.some((p) => p.name.toLowerCase() === name.toLowerCase())) throw new BadRequestError('You already have a theme with that name.');
  items.push({ id: randomUUID(), name, theme: { ...THEME_DEFAULTS, ...clean(req.body?.theme || {}) } });
  await savePresets(items, req.userId);
  return ApiResponse.success(res, await payload(), `"${name}" saved to your themes.`);
});

/** DELETE /settings/client-theme/presets/:id */
export const deleteClientPreset = catchAsync(async (req, res) => {
  const items = await loadPresets();
  const next = items.filter((p) => p.id !== req.params.id);
  if (next.length === items.length) throw new BadRequestError('That theme no longer exists.');
  await savePresets(next, req.userId);
  return ApiResponse.success(res, await payload(), 'Theme deleted.');
});
