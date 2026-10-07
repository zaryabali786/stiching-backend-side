import { AppError, NotFoundError } from './errors.js';

/**
 * Unwrap a Supabase query result, throwing an AppError on failure.
 * @template T
 * @param {{ data: T, error: any, count?: number }} result
 * @param {string} [context]
 * @returns {T}
 */
export const unwrap = (result, context = 'Database error') => {
  if (result.error) {
    const { message, code, details, hint } = result.error;
    // Missing table/column usually means the SQL migrations were not run yet
    if (code === 'PGRST205' || code === '42P01' || code === 'PGRST204' || code === '42703') {
      throw new AppError(
        `${context}: ${message}. Run backend/migrations/0001_init.sql and 0002_platform.sql in the Supabase SQL Editor.`,
        500
      );
    }
    const status = code === '23505' ? 409 : code === '23514' || code === '22P02' ? 400 : 500;
    throw new AppError(`${context}: ${message}`, status, details || hint || null);
  }
  return result.data;
};

/**
 * Like unwrap, but also throws 404 when no row was returned.
 */
export const unwrapOne = (result, notFoundMessage = 'Resource not found') => {
  const data = unwrap(result);
  if (!data) throw new NotFoundError(notFoundMessage);
  return data;
};

export const todayISO = () => new Date().toISOString().slice(0, 10);

export const daysAgoISO = (days) => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString();
};

export const startOfMonthISO = (monthsBack = 0) => {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - monthsBack, 1)).toISOString();
};

export const sum = (rows, key) => rows.reduce((acc, r) => acc + Number(r[key] || 0), 0);

export const round2 = (n) => Math.round(Number(n || 0) * 100) / 100;
