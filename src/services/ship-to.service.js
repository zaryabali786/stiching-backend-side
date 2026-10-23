import { supabaseAdmin } from '../config/supabase.js';
import { config } from '../config/env.js';

/**
 * The central receiving address customers ship parcels to (until the admin assigns an order to a partner).
 * The admin edits it in Settings > Ship-to address (platform_settings 'ship_to'); the SHIP_TO_* environment values are only the fallback.
 */
const KEYS = ['shipToName', 'shipToCompany', 'shipToAddress', 'shipToAddress2', 'shipToCity', 'shipToPhone', 'shipToCountry', 'shipToCountryCode', 'shipToState', 'shipToProvinceCode', 'shipToZip'];
const clean = (v, max) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
const unset = (v) => !v || v.startsWith('[');

export const loadShipTo = async () => {
  const { data } = await supabaseAdmin.from('platform_settings').select('value').eq('key', 'ship_to').maybeSingle();
  const saved = data?.value || {};
  const out = {};
  for (const k of KEYS) out[k] = saved[k] !== undefined && saved[k] !== null && String(saved[k]).trim() !== '' ? String(saved[k]) : unset(config.platform[k]) ? '' : config.platform[k];
  return out;
};

export const saveShipTo = async (body, userId) => {
  const value = {
    shipToName: clean(body.name, 120),
    shipToCompany: clean(body.company, 120),
    shipToAddress: clean(body.address, 300),
    shipToAddress2: clean(body.address2, 200),
    shipToCity: clean(body.city, 80),
    shipToPhone: clean(body.phone, 40),
    shipToCountry: clean(body.country, 80),
    shipToCountryCode: clean(body.country_code, 2).toUpperCase(),
    shipToState: clean(body.state, 80),
    shipToProvinceCode: clean(body.province_code, 10).toUpperCase(),
    shipToZip: clean(body.zip, 20),
  };
  const { error } = await supabaseAdmin.from('platform_settings').upsert({ key: 'ship_to', value, updated_by: userId, updated_at: new Date().toISOString() });
  if (error) throw error;
  return loadShipTo();
};

/** The address as the admin, the client app and the Shopify extension all see it (one shape). */
export const shipToView = (a) => ({
  name: a.shipToName || '',
  company: a.shipToCompany || '',
  address: a.shipToAddress || '',
  address2: a.shipToAddress2 || '',
  city: a.shipToCity || '',
  phone: a.shipToPhone || '',
  country: a.shipToCountry || '',
  country_code: a.shipToCountryCode || '',
  state: a.shipToState || '',
  province_code: a.shipToProvinceCode || '',
  zip: a.shipToZip || '',
});

/**
 * The country of the atelier for Shopify (an ISO code). An address saved before the country was chosen falls back to the old store setting,
 * then to PK (the original atelier country), so nothing that worked stops working.
 */
export const atelierCountryCode = (atelier, store) => atelier?.shipToCountryCode || store?.settings?.atelier_country_code || 'PK';
export const atelierCountryName = (atelier) => atelier?.shipToCountry || (atelier?.shipToCountryCode ? '' : 'Pakistan');

/** The atelier as the fields of a Shopify mailing address (province and zip only when they are set). */
export const atelierMailingAddress = (atelier, store, extra = {}) => ({
  company: atelier.shipToCompany || atelier.shipToName || 'Stitch&Ship Atelier',
  address1: atelier.shipToAddress,
  ...(atelier.shipToAddress2 ? { address2: atelier.shipToAddress2 } : {}),
  city: atelier.shipToCity,
  countryCode: atelierCountryCode(atelier, store),
  ...(atelier.shipToProvinceCode ? { provinceCode: atelier.shipToProvinceCode } : {}),
  ...(atelier.shipToZip ? { zip: atelier.shipToZip } : {}),
  phone: atelier.shipToPhone || undefined,
  ...extra,
});
