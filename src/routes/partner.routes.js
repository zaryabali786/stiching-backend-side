import { Router } from 'express';
import {
  getPartnerOverview,
  getReceiving,
  receiveUnit,
  setUnitWeight,
  receiveCorrectedArticle,
  bookReturnCn,
  cancelReturnBooking,
  routeReturn,
  createReturnLoadsheet,
  downloadReturnLoadsheet,
  confirmReturnHandover,
  updateReturnTracking,
  refreshReturnTracking,
  reportUnitIssue,
  receiveAllUnits,
  addParcelMedia,
  sendArticleBack,
  getUnmatchedParcels,
  findParcelElsewhere,
  forwardParcel,
  createUnmatchedParcel,
  updateUnmatchedParcel,
  getTeams,
  createTeamMember,
  createMemberLogin,
  updateTeamMember,
  deactivateTeamMember,
  getPartnerWarehouse,
  setOrderWeight,
  setDispatchRoute,
  bookDispatchCn,
  bulkBookDispatch,
  addDispatchCn,
  printOrderList,
  cancelDispatchCn,
  createDispatchSheet,
  markDispatchSheetDownloaded,
  confirmDispatchSheetHandover,
  updateDispatchTracking,
  confirmDispatchReturnReceived,
  getApiCouriers,
  printDispatchCn,
  refreshDispatchTracking,
  getTransfers,
  dispatchTransfer,
  getEarningsSummary,
  getEarnings,
  getPartnerOrders,
  getPartnerOrder,
  getPartnerBadges,
} from '../controllers/partner.controller.js';
import {
  getBoard,
  getColumnPage,
  getCardDetail,
  moveCard,
  updateCard,
  assignCard,
  addComment,
  getSuggestions,
  scanCards,
  updateQcChecklist,
  askCustomer,
  getQcQueue,
  passQc,
  failQc,
  requestCustomerApproval,
  requestCardApproval,
  packOrder,
  sendOrderToPressing,
  scanReceive,
  scanComplete,
  getProductionReceiving,
  getMasterTracking,
  getProductionOrders,
} from '../controllers/production.controller.js';

import {
  listBrands, createBrand, updateBrand, deleteBrand,
  listCouriers, createCourier, updateCourier, deleteCourier,
  listArticleTypes, createArticleType, updateArticleType, deleteArticleType,
  listArticles, createArticle, updateArticle, deleteArticle, copyStandardSet,
} from '../controllers/catalogue.controller.js';
import {
  getMessages, postMessage, uploadVoice, readMessages, getConversations, getUnreadCount, getOrderSummary, uploadVoiceNote, getConversationScopes,
} from '../controllers/chat.controller.js';

import { requirePermission as need, requireAnyPermission as needAny } from '../middlewares/auth.middleware.js';
import { getOrderExtras, addOrderExtra, editOrderExtra, removeOrderExtra } from '../controllers/extra-costs.controller.js';
import { ownsOrder, ownsUnit, ownsCard, ownsMember, ownsTransfer, ownsParcel } from '../middlewares/ownership.middleware.js';
import { listPartnerUsers, createPartnerUser, updatePartnerUser, resetPartnerUserPassword, deactivatePartnerUser, getPartnerAccess, listTaggableTeamMembers, listTaggableUsers, listPartnerRoles, createPartnerRole, updatePartnerRole, deletePartnerRole } from '../controllers/partner-users.controller.js';

const router = Router();

/**
 * Every route needs the permission of its module (admins pass), and every route that takes an id also checks the
 * record belongs to the caller's partner. List endpoints filter by partner inside their controllers.
 */

router.get('/access', getPartnerAccess);
router.get('/overview', need('overview.view'), getPartnerOverview);
router.get('/badges', getPartnerBadges); // counts only the modules the caller may see

// Receiving
router.get('/receiving', need('receiving.view'), getReceiving);
router.post('/receiving/units/:unitId/weight', need('receiving.receive'), ownsUnit('unitId'), setUnitWeight);
router.post('/receiving/units/:unitId/receive', need('receiving.receive'), ownsUnit('unitId'), receiveUnit);
router.post('/receiving/units/:unitId/receive-corrected', need('receiving.returns'), ownsUnit('unitId'), receiveCorrectedArticle);
router.post('/receiving/units/:unitId/issue', need('receiving.issue'), ownsUnit('unitId'), reportUnitIssue);
router.post('/receiving/orders/:orderId/receive-all', need('receiving.receive'), ownsOrder('orderId'), receiveAllUnits);
router.post('/receiving/orders/:orderId/parcel-media', need('receiving.receive'), ownsOrder('orderId'), addParcelMedia);
router.get('/receiving/unmatched', need('receiving.view'), getUnmatchedParcels);
router.get('/receiving/elsewhere', need('receiving.view'), findParcelElsewhere);
router.post('/receiving/units/:unitId/return/book', need('receiving.returns'), ownsUnit('unitId'), bookReturnCn);
router.post('/receiving/units/:unitId/return/route', need('receiving.returns'), ownsUnit('unitId'), routeReturn);
router.post('/receiving/units/:unitId/return/cancel', need('receiving.returns'), ownsUnit('unitId'), cancelReturnBooking);
router.post('/receiving/returns/loadsheet', need('receiving.returns'), createReturnLoadsheet);
router.get('/receiving/returns/loadsheets/:id/download', need('receiving.view'), downloadReturnLoadsheet);
router.post('/receiving/returns/loadsheets/:id/handed-over', need('receiving.returns'), confirmReturnHandover);
router.get('/receiving/couriers/api', need('receiving.view'), getApiCouriers);
router.post('/receiving/returns/:shipmentId/refresh-tracking', need('receiving.returns'), refreshReturnTracking);
router.post('/receiving/returns/:shipmentId/tracking', need('receiving.returns'), updateReturnTracking);
router.post('/receiving/units/:unitId/sent-back', need('receiving.returns'), ownsUnit('unitId'), sendArticleBack);
router.post('/receiving/orders/:orderId/forward', need('receiving.returns'), forwardParcel);
router.post('/receiving/unmatched', need('receiving.unmatched'), createUnmatchedParcel);
router.patch('/receiving/unmatched/:id', need('receiving.unmatched'), ownsParcel(), updateUnmatchedParcel);

// Teams
router.get('/teams', needAny('teams.view', 'production.view', 'receiving.view'), getTeams);
router.get('/teams/users', need('teams.view'), listTaggableUsers);
router.post('/teams/members', need('teams.update'), createTeamMember);
router.post('/teams/members/:id/login', need('teams.update'), need('users.create'), ownsMember(), createMemberLogin);
router.patch('/teams/members/:id', need('teams.update'), ownsMember(), updateTeamMember);
router.delete('/teams/members/:id', need('teams.update'), ownsMember(), deactivateTeamMember);

// Production board (job cards)
router.get('/production/board', need('production.view'), getBoard);
router.get('/production/columns/:stage', need('production.view'), getColumnPage);
router.get('/production/suggestions', needAny('production.view', 'receiving.view'), getSuggestions);
router.get('/production/scan', need('production.view'), scanCards);
router.post('/production/scan-receive', needAny('production.scan', 'quality.scan'), scanReceive);
router.post('/production/scan-complete', needAny('production.scan', 'quality.scan'), scanComplete);
router.get('/production/receiving', needAny('production.view', 'quality.view'), getProductionReceiving);
router.get('/production/master-tracking', needAny('production.view', 'teams.view'), getMasterTracking);
router.get('/production/orders', need('production.view'), getProductionOrders);
router.get('/production/orders/:orderId/extras', need('production.view'), ownsOrder('orderId'), getOrderExtras);
router.post('/production/orders/:orderId/extras', need('production.extras'), ownsOrder('orderId'), addOrderExtra);
router.patch('/production/extras/:id', need('production.extras'), editOrderExtra);
router.delete('/production/extras/:id', need('production.extras'), removeOrderExtra);
router.get('/production/cards/:id', need('production.view'), ownsCard(), getCardDetail);
router.patch('/production/cards/:id', need('production.assign'), ownsCard(), updateCard);
router.put('/production/cards/:id/move', need('production.move'), ownsCard(), moveCard);
router.post('/production/cards/:id/assign', need('production.assign'), ownsCard(), assignCard);
router.post('/production/cards/:id/comments', need('production.comment'), ownsCard(), addComment);
router.patch('/production/cards/:id/qc-checklist', needAny('quality.pass', 'production.assign'), ownsCard(), updateQcChecklist);
router.post('/production/cards/:id/ask-customer', need('production.comment'), ownsCard(), askCustomer);

// Quality check
router.get('/qc', need('quality.view'), getQcQueue);
router.post('/qc/cards/:id/pass', need('quality.pass'), ownsCard(), passQc);
router.post('/qc/cards/:id/fail', need('quality.pass'), ownsCard(), failQc);
router.post('/qc/cards/:id/request-approval', need('quality.approval'), ownsCard(), requestCardApproval);
router.post('/qc/orders/:orderId/request-approval', need('quality.approval'), ownsOrder('orderId'), requestCustomerApproval);
router.post('/qc/orders/:orderId/pressing', need('quality.pack'), ownsOrder('orderId'), sendOrderToPressing);
router.post('/qc/orders/:orderId/pack', need('quality.pack'), ownsOrder('orderId'), packOrder);

// Warehouse
router.get('/warehouse', need('warehouse.view'), getPartnerWarehouse);
router.post('/warehouse/orders/:id/weight', need('warehouse.book'), ownsOrder(), setOrderWeight);
router.post('/warehouse/orders/:id/route', need('warehouse.book'), ownsOrder(), setDispatchRoute);
router.post('/warehouse/orders/:id/book', need('warehouse.book'), ownsOrder(), bookDispatchCn);
router.get('/warehouse/orders/list', need('warehouse.view'), printOrderList);
router.post('/warehouse/dispatch/bulk-book', need('warehouse.book'), bulkBookDispatch);
router.post('/warehouse/shipments/:shipmentId/cn', need('warehouse.book'), addDispatchCn);
router.post('/warehouse/orders/:id/book/cancel', need('warehouse.book'), ownsOrder(), cancelDispatchCn);
router.post('/warehouse/dispatch/loadsheet', need('warehouse.loadsheet'), createDispatchSheet);
router.get('/warehouse/loadsheets/:id/download', need('warehouse.view'), downloadReturnLoadsheet);
router.post('/warehouse/dispatch/loadsheets/:id/downloaded', need('warehouse.loadsheet'), markDispatchSheetDownloaded);
router.post('/warehouse/dispatch/loadsheets/:id/handed-over', need('warehouse.loadsheet'), confirmDispatchSheetHandover);
router.post('/warehouse/shipments/:shipmentId/tracking', need('warehouse.tracking'), updateDispatchTracking);
router.get('/warehouse/cn/print', need('warehouse.view'), printDispatchCn);
router.get('/warehouse/couriers/api', need('warehouse.view'), getApiCouriers);
router.post('/warehouse/shipments/:shipmentId/refresh-tracking', need('warehouse.tracking'), refreshDispatchTracking);
router.post('/warehouse/shipments/:shipmentId/received-back', need('warehouse.tracking'), confirmDispatchReturnReceived);
router.get('/warehouse/transfers', need('warehouse.view'), getTransfers);
router.post('/warehouse/transfers/:id/dispatch', need('warehouse.transfer'), ownsTransfer(), dispatchTransfer);

// Earnings
router.get('/earnings/summary', need('earnings.view'), getEarningsSummary);
router.get('/orders', need('overview.view'), getPartnerOrders);
router.get('/orders/:id', need('overview.view'), getPartnerOrder);
router.get('/earnings', need('earnings.view'), getEarnings);

// Catalogues the customer order form is built from (partner staff and admins manage them)
router.get('/brands', need('catalogue.view'), listBrands);
router.post('/brands', need('catalogue.update'), createBrand);
router.patch('/brands/:id', need('catalogue.update'), updateBrand);
router.delete('/brands/:id', need('catalogue.update'), deleteBrand);

router.get('/couriers', need('catalogue.view'), listCouriers);
router.post('/couriers', need('catalogue.update'), createCourier);
router.patch('/couriers/:id', need('catalogue.update'), updateCourier);
router.delete('/couriers/:id', need('catalogue.update'), deleteCourier);

router.get('/article-types', need('catalogue.view'), listArticleTypes);
router.post('/article-types', need('catalogue.update'), createArticleType);
router.patch('/article-types/:id', need('catalogue.update'), updateArticleType);
router.delete('/article-types/:id', need('catalogue.update'), deleteArticleType);

router.post('/catalogue/standard-set', need('catalogue.update'), copyStandardSet);
router.get('/articles', need('catalogue.view'), listArticles);
router.post('/articles', need('catalogue.update'), createArticle);
router.patch('/articles/:id', need('catalogue.update'), updateArticle);
router.delete('/articles/:id', need('catalogue.update'), deleteArticle);

// Voice recording for a note (job comment, QC note, receiving issue)
router.post('/voice-upload', needAny('production.comment', 'production.assign', 'quality.pass', 'receiving.issue', 'messages.update'), uploadVoiceNote);

// Customer conversations
router.get('/conversations', need('messages.view'), getConversations);
router.get('/conversations/unread-count', need('messages.view'), getUnreadCount);
router.get('/orders/:id/summary', need('messages.view'), ownsOrder(), getOrderSummary);
router.get('/orders/:id/conversation', need('messages.view'), ownsOrder(), getConversationScopes);
router.get('/orders/:id/messages', need('messages.view'), ownsOrder(), getMessages);
router.post('/orders/:id/messages', need('messages.update'), ownsOrder(), postMessage);
router.post('/orders/:id/messages/voice-upload', need('messages.update'), ownsOrder(), uploadVoice);
router.post('/orders/:id/messages/read', need('messages.view'), ownsOrder(), readMessages);

// The partner's own users (each with their own login and permissions)
router.get('/users', need('users.view'), listPartnerUsers);
router.get('/users/team-members', need('users.view'), listTaggableTeamMembers);
router.get('/roles', need('users.view'), listPartnerRoles);
router.post('/roles', need('users.create'), createPartnerRole);
router.patch('/roles/:id', need('users.update'), updatePartnerRole);
router.delete('/roles/:id', need('users.update'), deletePartnerRole);
router.post('/users', need('users.create'), createPartnerUser);
router.patch('/users/:id', need('users.update'), updatePartnerUser);
router.post('/users/:id/reset-password', need('users.update'), resetPartnerUserPassword);
router.delete('/users/:id', need('users.update'), deactivatePartnerUser);

export default router;
