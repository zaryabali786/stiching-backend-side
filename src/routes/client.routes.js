import { Router } from 'express';
import {
  getClientOverview,
  getClientOrders,
  getClientOrderCounts,
  getClientOrder,
  createClientOrder,
  updateClientOrder,
  cancelClientOrder,
  deleteClientDraft,
  approveClientOrder,
  requestChanges,
  payClientOrder,
  getClientSizes,
  createClientSize,
  updateClientSize,
  deleteClientSize,
} from '../controllers/client.controller.js';
import {
  listImports,
  getImport,
  deleteImport,
  getForwardAddress,
  resetForwardAddress,
  importInvoice,
  importLinks,
} from '../controllers/order-import.controller.js';
import {
  lookupBrands,
  lookupCouriers,
  lookupArticleTypes,
  lookupArticles,
  addBrandAsCustomer,
} from '../controllers/catalogue.controller.js';
import { listClientPartners } from '../controllers/partner-directory.controller.js';
import { getInbox, getMailbox, getUnreadCount, getEmail, readAll, removeEmail } from '../controllers/inbox.controller.js';
import { previewProduct } from '../controllers/client.controller.js';
import { getMessages, postMessage, uploadVoice, readMessages, uploadVoiceNote, getConversationScopes, getMyConversations } from '../controllers/chat.controller.js';
import { createPaymentIntent, confirmPayment } from '../controllers/payment.controller.js';

import { getClientHomeLayout } from '../controllers/home-layout.controller.js';
import { getActiveBanners } from '../controllers/banner.controller.js';

const router = Router();

router.get('/overview', getClientOverview);
router.get('/banners', getActiveBanners);
router.get('/home-layout', getClientHomeLayout);

router.get('/orders', getClientOrders);
router.get('/orders/counts', getClientOrderCounts);
router.post('/orders', createClientOrder);
router.get('/orders/:id', getClientOrder);
router.patch('/orders/:id', updateClientOrder);
router.post('/orders/:id/cancel', cancelClientOrder);
router.delete('/orders/:id', deleteClientDraft);
router.post('/orders/:id/approve', approveClientOrder);
router.post('/orders/:id/request-changes', requestChanges);
router.post('/orders/:id/payment-intent', createPaymentIntent);
router.post('/orders/:id/payment-intent/confirm', confirmPayment);
// kept only for local development without Stripe keys; refuses to run once Stripe is configured or in production
router.post('/orders/:id/pay', payClientOrder);

// New-order helpers: read a brand invoice, product links or a forwarded email into a draft
router.get('/imports', listImports);
router.get('/imports/forward-address', getForwardAddress);
router.post('/imports/forward-address/reset', resetForwardAddress);
router.post('/imports/invoice', importInvoice);
router.post('/imports/links', importLinks);
router.get('/imports/:id', getImport);
router.delete('/imports/:id', deleteImport);

// Inbox: every email that reaches the customer's personal shopping address
router.get('/inbox', getInbox);
router.get('/inbox/address', getMailbox);
router.get('/inbox/unread-count', getUnreadCount);
router.post('/inbox/read-all', readAll);
router.get('/inbox/:id', getEmail);
router.delete('/inbox/:id', removeEmail);

// Order form lookups: active rows only, searchable and paginated on the server, never any price
router.get('/partners', listClientPartners);
router.get('/brands', lookupBrands);
router.post('/brands', addBrandAsCustomer);
router.get('/couriers', lookupCouriers);
router.get('/article-types', lookupArticleTypes);
router.get('/articles', lookupArticles);
router.post('/products/preview', previewProduct);

// Voice recording for a note (article note, size note, change request)
router.post('/voice-upload', uploadVoiceNote);

// Conversation about an order (text + voice); realtime delivery goes over Socket.IO
router.get('/conversations', getMyConversations);
router.get('/orders/:id/conversation', getConversationScopes);
router.get('/orders/:id/messages', getMessages);
router.post('/orders/:id/messages', postMessage);
router.post('/orders/:id/messages/voice-upload', uploadVoice);
router.post('/orders/:id/messages/read', readMessages);

router.get('/sizes', getClientSizes);
router.post('/sizes', createClientSize);
router.patch('/sizes/:id', updateClientSize);
router.delete('/sizes/:id', deleteClientSize);

export default router;
