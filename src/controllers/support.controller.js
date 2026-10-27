import { catchAsync, ApiResponse } from '../utils/error.helper.js';
import { listThread, sendSupportMessage, uploadSupportVoice, markSupportRead, customerUnread, listConversations, assertCustomer, adminUnreadTotal } from '../services/support-chat.service.js';

// ───────── customer ─────────
export const getMySupport = catchAsync(async (req, res) =>
  ApiResponse.success(res, await listThread(req.userId, { before: req.query.before, limit: parseInt(req.query.limit, 10) || 50 })));

export const sendMySupport = catchAsync(async (req, res) =>
  ApiResponse.success(res, await sendSupportMessage({ customerId: req.userId, profile: req.profile, kind: req.body?.kind, body: req.body?.body, audio: req.body?.audio, clientMsgId: req.body?.client_msg_id })));

export const uploadMySupportVoice = catchAsync(async (req, res) =>
  ApiResponse.created(res, await uploadSupportVoice({ customerId: req.userId, profile: req.profile, audio: req.body?.audio }), 'Voice message uploaded.'));

export const readMySupport = catchAsync(async (req, res) => ApiResponse.success(res, { updated: await markSupportRead(req.userId, 'customer') }));

export const getMySupportUnread = catchAsync(async (req, res) => ApiResponse.success(res, { unread: await customerUnread(req.userId) }));

// ───────── admin ─────────
export const getSupportConversations = catchAsync(async (req, res) =>
  ApiResponse.success(res, { conversations: await listConversations({ search: req.query.search }), unread: await adminUnreadTotal() }));

export const getSupportThread = catchAsync(async (req, res) => {
  const customer = await assertCustomer(req.params.customerId);
  return ApiResponse.success(res, { customer, ...(await listThread(customer.id, { before: req.query.before, limit: parseInt(req.query.limit, 10) || 50 })) });
});

export const sendSupportAsAdmin = catchAsync(async (req, res) => {
  const customer = await assertCustomer(req.params.customerId);
  return ApiResponse.success(res, await sendSupportMessage({ customerId: customer.id, profile: req.profile, kind: req.body?.kind, body: req.body?.body, audio: req.body?.audio, clientMsgId: req.body?.client_msg_id }));
});

export const uploadSupportVoiceAsAdmin = catchAsync(async (req, res) => {
  const customer = await assertCustomer(req.params.customerId);
  return ApiResponse.created(res, await uploadSupportVoice({ customerId: customer.id, profile: req.profile, audio: req.body?.audio }), 'Voice message uploaded.');
});

export const readSupportAsAdmin = catchAsync(async (req, res) => {
  const customer = await assertCustomer(req.params.customerId);
  return ApiResponse.success(res, { updated: await markSupportRead(customer.id, 'admin') });
});
