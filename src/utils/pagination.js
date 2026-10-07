import { ApiResponse } from './response.helper.js';

/**
 * Parse common list query params: ?page=1&limit=20&search=abc&sort=created_at&dir=desc
 * @param {import('express').Request} req
 * @param {Object} [opts]
 * @param {string[]} [opts.sortable] - columns the client may sort by
 */
export const parseListQuery = (req, opts = {}) => {
  const { defaultLimit = 20, maxLimit = 100, sortable = [], defaultSort = 'created_at', defaultDir = 'desc' } = opts;

  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = Math.min(maxLimit, Math.max(1, parseInt(req.query.limit, 10) || defaultLimit));
  const search = sanitizeSearch(req.query.search);
  const sort = sortable.includes(req.query.sort) ? req.query.sort : defaultSort;
  const ascending = (req.query.dir || defaultDir).toLowerCase() === 'asc';

  return { page, limit, search, sort, ascending, from: (page - 1) * limit, to: page * limit - 1 };
};

/**
 * Strip characters that would break a PostgREST or() filter.
 */
export const sanitizeSearch = (value) =>
  String(value || '')
    .replace(/[,()*%\\:"']/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);

/**
 * Build a PostgREST or() expression matching `search` against several columns.
 */
export const ilikeAny = (columns, search) => columns.map((c) => `${c}.ilike.%${search}%`).join(',');

export const pageMeta = ({ page, limit }, total) => ({
  page,
  limit,
  total: total || 0,
  totalPages: Math.max(1, Math.ceil((total || 0) / limit)),
  hasMore: page * limit < (total || 0),
});

export const sendPage = (res, rows, query, total, extraMeta = {}) =>
  ApiResponse.success(res, rows || [], 'Success', 200, { ...pageMeta(query, total), ...extraMeta });
