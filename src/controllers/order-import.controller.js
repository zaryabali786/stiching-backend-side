import { timingSafeEqual } from 'node:crypto';
import { supabaseAdmin } from '../config/supabase.js';
import { config } from '../config/env.js';
import { catchAsync, ApiResponse, BadRequestError, UnauthorizedError, AppError } from '../utils/error.helper.js';
import { parseListQuery, sendPage } from '../utils/pagination.js';
import { unwrap, unwrapOne } from '../utils/db.js';
import { decodeDataUrl } from '../services/storage.service.js';
import { isAiConfigured } from '../services/ai.service.js';
import {
  getForwardAddress as forwardAddressFor,
  importInvoice as runInvoiceImport,
  importLinks as runLinksImport,
  receiveForwardedEmail,
  inboundEmailEnabled,
  shapeImport,
} from '../services/order-import.service.js';

const loadOwnImport = async (req) =>
  unwrapOne(
    await supabaseAdmin.from('order_imports').select('*').eq('id', req.params.id).eq('customer_id', req.userId).maybeSingle(),
    'Import not found'
  );

/**
 * GET /api/client/imports?source=invoice|link|email&page&limit&include=used
 * The customer's import drafts, newest first (used ones hidden unless include=used).
 */
export const listImports = catchAsync(async (req, res) => {
  const q = parseListQuery(req, { defaultLimit: 10, maxLimit: 50 });
  let query = supabaseAdmin
    .from('order_imports')
    .select('*', { count: 'exact' })
    .eq('customer_id', req.userId)
    .order('created_at', { ascending: false })
    .range(q.from, q.to);
  if (['invoice', 'link', 'email'].includes(req.query.source)) query = query.eq('source', req.query.source);
  if (req.query.include !== 'used') query = query.neq('status', 'used');
  const result = await query;
  const rows = await Promise.all(unwrap(result, 'Could not load imports').map(shapeImport));
  return sendPage(res, rows, q, result.count, { ai: isAiConfigured() });
});

export const getImport = catchAsync(async (req, res) => {
  return ApiResponse.success(res, await shapeImport(await loadOwnImport(req)));
});

export const deleteImport = catchAsync(async (req, res) => {
  const row = await loadOwnImport(req);
  if (row.status === 'used') throw new BadRequestError('This import is already part of an order.');
  unwrap(await supabaseAdmin.from('order_imports').delete().eq('id', row.id));
  return ApiResponse.success(res, null, 'Removed.');
});

/** GET /api/client/imports/forward-address */
export const getForwardAddress = catchAsync(async (req, res) => {
  return ApiResponse.success(res, { ...(await forwardAddressFor(req.userId)), ai: isAiConfigured() });
});

/** POST /api/client/imports/forward-address/reset — new secret address (old one stops working) */
export const resetForwardAddress = catchAsync(async (req, res) => {
  return ApiResponse.success(res, { ...(await forwardAddressFor(req.userId, { reset: true })), ai: isAiConfigured() }, 'New forwarding address created.');
});

/** POST /api/client/imports/invoice  body: { file: { name, dataUrl } } — PDF or image, max 8 MB */
export const importInvoice = catchAsync(async (req, res) => {
  const file = req.body?.file;
  if (!file?.dataUrl) throw new BadRequestError('Choose the invoice file to upload.');
  const { mime, buffer } = decodeDataUrl(file.dataUrl);
  const row = await runInvoiceImport(req.userId, { mime, buffer, name: String(file.name || 'invoice') });
  return ApiResponse.created(res, await shapeImport(row), row.status === 'failed' ? row.error : 'Invoice read.');
});

/** POST /api/client/imports/links  body: { urls: string[] } — up to 10 product links */
export const importLinks = catchAsync(async (req, res) => {
  const urls = [...new Set((Array.isArray(req.body?.urls) ? req.body.urls : []).map((u) => String(u || '').trim()).filter(Boolean))];
  if (!urls.length) throw new BadRequestError('Paste at least one product link.');
  if (urls.length > 10) throw new BadRequestError('Add at most 10 links at a time.');
  const bad = urls.find((u) => !/^https?:\/\/\S+$/i.test(u));
  if (bad) throw new BadRequestError(`"${bad.slice(0, 60)}" is not a full link — it should start with https://`);
  const row = await runLinksImport(req.userId, urls);
  return ApiResponse.created(res, await shapeImport(row), row.status === 'failed' ? 'None of the links could be read.' : 'Links read.');
});

// ───────────────────────── inbound email webhook (public) ─────────────────────────

const secretMatches = (given) => {
  const expected = Buffer.from(config.inboundEmail.secret);
  const actual = Buffer.from(String(given || ''));
  return expected.length > 0 && actual.length === expected.length && timingSafeEqual(actual, expected);
};

/** Secret via header X-Inbound-Secret, ?secret=, or HTTP basic auth password (Postmark style). */
const providedSecret = (req) => {
  if (req.get('x-inbound-secret')) return req.get('x-inbound-secret');
  if (req.query.secret) return req.query.secret;
  const basic = /^Basic\s+(.+)$/i.exec(req.get('authorization') || '')?.[1];
  if (basic) return Buffer.from(basic, 'base64').toString('utf8').split(':').slice(1).join(':');
  return null;
};

/**
 * POST /api/inbound/email
 * Called by the inbound-mail provider (Postmark inbound JSON, or a generic JSON body:
 * { from, to, subject, text, html, attachments: [{ filename, contentType, content(base64) }] }).
 */
export const inboundEmailWebhook = catchAsync(async (req, res) => {
  if (!inboundEmailEnabled()) throw new AppError('Email forwarding is not configured on this server.', 503);
  if (!secretMatches(providedSecret(req))) throw new UnauthorizedError('Invalid inbound email secret.');
  const result = await receiveForwardedEmail(req.body || {});
  // Always 200 for well-formed calls so the provider does not retry mail we deliberately ignore
  return ApiResponse.success(res, result, result.accepted ? 'Email received.' : 'Email ignored.');
});
