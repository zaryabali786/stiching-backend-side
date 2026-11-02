import { catchAsync, ApiResponse } from '../utils/error.helper.js';
import { loadReviewSettings, saveReviewSettings, listReviews, getReview, reviewSummary, reviewStateForOrder, reviewStateByToken, submitReview, submitReviewByToken, MAX_REVIEW_DAYS } from '../services/review.service.js';
import { pageMeta } from '../utils/pagination.js';

// ─────────────── public: the link in the email (the signed token identifies the invitation, so no sign-in is needed) ───────────────

/** GET /api/reviews/invite/:token -> { order, customer_name, reviewable, review } */
export const getReviewByToken = catchAsync(async (req, res) => ApiResponse.success(res, await reviewStateByToken(req.params.token)));

/** POST /api/reviews/invite/:token  body: { rating: 1-5, comment? } */
export const postReviewByToken = catchAsync(async (req, res) =>
  ApiResponse.success(res, await submitReviewByToken(req.params.token, req.body || {}), 'Thank you for your review!', 201));

// ─────────────── customer (signed in): only their own orders ───────────────

/** GET /api/client/orders/:id/review */
export const getOrderReview = catchAsync(async (req, res) => ApiResponse.success(res, await reviewStateForOrder(req.params.id, req.userId)));

/** POST /api/client/orders/:id/review  body: { rating, comment? } */
export const postOrderReview = catchAsync(async (req, res) =>
  ApiResponse.success(res, await submitReview({ orderId: req.params.id, customerId: req.userId, rating: req.body?.rating, comment: req.body?.comment, source: 'app' }), 'Thank you for your review!', 201));

// ─────────────── admin ───────────────

const filtersOf = (q) => ({ type: q.type, rating: q.rating, search: q.search, from: q.from, to: q.to });

/** GET /api/admin/reviews?type=&rating=&search=&from=&to=&dir=&page=&limit= */
export const adminListReviews = catchAsync(async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 15));
  const { rows, total } = await listReviews({ ...filtersOf(req.query), dir: req.query.dir === 'asc' ? 'asc' : 'desc', page, limit });
  return ApiResponse.success(res, rows, 'Success', 200, pageMeta({ page, limit }, total));
});

/** GET /api/admin/reviews/summary?type=&from=&to= */
export const adminReviewSummary = catchAsync(async (req, res) => ApiResponse.success(res, await reviewSummary(filtersOf(req.query))));

/** GET /api/admin/reviews/:id */
export const adminGetReview = catchAsync(async (req, res) => ApiResponse.success(res, await getReview(req.params.id)));

/** GET /api/admin/settings/reviews */
export const getReviewSettings = catchAsync(async (req, res) => ApiResponse.success(res, { ...(await loadReviewSettings()), maxDays: MAX_REVIEW_DAYS }));

/** PUT /api/admin/settings/reviews  body: { nationalEnabled, nationalReviewDays, internationalEnabled, internationalReviewDays } */
export const setReviewSettings = catchAsync(async (req, res) => {
  const { settings, redated } = await saveReviewSettings(req.body, req.userId);
  return ApiResponse.success(res, { ...settings, maxDays: MAX_REVIEW_DAYS, redated }, redated ? `Saved. ${redated} waiting review email${redated === 1 ? ' was' : 's were'} re-scheduled.` : 'Customer review settings saved.');
});
