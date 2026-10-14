import { catchAsync, ApiResponse } from '../utils/error.helper.js';
import { listExtraCosts, createExtraCost, updateExtraCost, deleteExtraCost, decideExtraCost } from '../services/extra-cost.service.js';

/** GET /api/partner/production/orders/:orderId/extras */
export const getOrderExtras = catchAsync(async (req, res) => ApiResponse.success(res, await listExtraCosts(req.params.orderId)));

/** POST /api/partner/production/orders/:orderId/extras  body: { name, quantity, unit_price, notes?, bill?: { name, dataUrl }, unit_id?, client_key? } */
export const addOrderExtra = catchAsync(async (req, res) => {
  const { cost, duplicate } = await createExtraCost({ orderId: req.params.orderId, body: req.body || {}, profile: req.profile, userId: req.userId });
  return duplicate ? ApiResponse.success(res, cost, 'This item was already added.') : ApiResponse.created(res, cost, `${cost.name} added.`);
});

/** PATCH /api/partner/production/extras/:id */
export const editOrderExtra = catchAsync(async (req, res) =>
  ApiResponse.success(res, await updateExtraCost({ id: req.params.id, body: req.body || {}, access: req.access, userId: req.userId }), 'Item updated.')
);

/** DELETE /api/partner/production/extras/:id */
export const removeOrderExtra = catchAsync(async (req, res) => ApiResponse.success(res, await deleteExtraCost({ id: req.params.id, access: req.access }), 'Item removed.'));

/** POST /api/admin/extra-costs/:id/decision  body: { decision: 'approve' | 'reject', note? } */
export const decideOrderExtra = catchAsync(async (req, res) => {
  const cost = await decideExtraCost({ id: req.params.id, decision: req.body?.decision, note: req.body?.note, userId: req.userId });
  return ApiResponse.success(res, cost, cost.status === 'approved' ? 'Approved. It can go on the invoice.' : 'Rejected. It will not be charged.');
});
