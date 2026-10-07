import { Router } from 'express';
import {
  getAdminOverview,
  getAdminOrders,
  getAdminOrder,
  getAdminOrderByRef,
  updateAdminOrder,
  resolveUnitIssue,
  getAdminCustomers,
  getAdminCustomer,
  getUsers,
  setUserRole,
  setUserActive,
  getAdminReports,
  getAdminBadges,
} from '../controllers/admin.controller.js';
import {
  getPermissionCatalogue,
  listPartners,
  getPartner,
  createPartner,
  updatePartner,
  listAdminPartnerUsers,
  createAdminPartnerUser,
  updateAdminPartnerUser,
  resetAdminPartnerUserPassword,
  deactivateAdminPartnerUser,
  assignOrderToPartner,
  getOrderAssignment,
  setOrderAssignment,
} from '../controllers/admin-partners.controller.js';
import {
  getPriceItems,
  createPriceItem,
  updatePriceItem,
  deletePriceItem,
  getShippingRates,
  createShippingRate,
  updateShippingRate,
  deleteShippingRate,
  getAdminInvoices,
  getInvoiceBuilder,
  saveInvoiceDraft,
  issueInvoice,
  reopenInvoice,
  markInvoicePaid,
  getWarehouseSummary,
  getAdminTransfers,
  receiveTransfer,
  getParcels,
  getCourierOptions,
  labelParcel,
  markParcelHanded,
  markParcelDelivered,
} from '../controllers/finance.controller.js';

import { inActivePartnerOrder } from '../middlewares/ownership.middleware.js';

const router = Router();

router.get('/overview', getAdminOverview);
router.get('/badges', getAdminBadges);

// Orders
router.get('/orders', getAdminOrders);
router.get('/orders/by-ref/:reference', getAdminOrderByRef);
router.get('/orders/:id', getAdminOrder);
router.patch('/orders/:id', inActivePartnerOrder(), updateAdminOrder);
router.post('/orders/:id/units/:unitId/resolve', inActivePartnerOrder(), resolveUnitIssue);

// Customers & users
router.get('/customers', getAdminCustomers);
router.get('/customers/:id', getAdminCustomer);
router.get('/users', getUsers);
router.patch('/users/:id/role', setUserRole);
router.patch('/users/:id/active', setUserActive);

// Partners & reports
router.get('/permissions', getPermissionCatalogue);
router.get('/settings/order-assignment', getOrderAssignment);
router.put('/settings/order-assignment', setOrderAssignment);
router.get('/partners', listPartners);
router.post('/partners', createPartner);
router.get('/partners/:id', getPartner);
router.patch('/partners/:id', updatePartner);
router.get('/partners/:id/users', listAdminPartnerUsers);
router.post('/partners/:id/users', createAdminPartnerUser);
router.patch('/partners/:id/users/:userId', updateAdminPartnerUser);
router.post('/partners/:id/users/:userId/reset-password', resetAdminPartnerUserPassword);
router.delete('/partners/:id/users/:userId', deactivateAdminPartnerUser);
router.post('/orders/:id/partner', inActivePartnerOrder(), assignOrderToPartner);
router.get('/reports', getAdminReports);

// Price list
router.get('/price-items', getPriceItems);
router.post('/price-items', createPriceItem);
router.patch('/price-items/:id', updatePriceItem);
router.delete('/price-items/:id', deletePriceItem);

// Shipping rates
router.get('/shipping-rates', getShippingRates);
router.post('/shipping-rates', createShippingRate);
router.patch('/shipping-rates/:id', updateShippingRate);
router.delete('/shipping-rates/:id', deleteShippingRate);

// Invoices
router.get('/invoices', getAdminInvoices);
router.get('/invoices/builder/:orderId', inActivePartnerOrder('orderId'), getInvoiceBuilder);
router.put('/invoices/builder/:orderId', inActivePartnerOrder('orderId'), saveInvoiceDraft);
router.post('/invoices/:id/issue', issueInvoice);
router.post('/invoices/:id/reopen', reopenInvoice);
router.post('/invoices/:id/mark-paid', markInvoicePaid);

// Admin warehouse
router.get('/warehouse/summary', getWarehouseSummary);
router.get('/warehouse/transfers', getAdminTransfers);
router.post('/warehouse/transfers/:id/receive', receiveTransfer);
router.get('/warehouse/parcels', getParcels);
router.get('/warehouse/parcels/:id/courier-options', getCourierOptions);
router.post('/warehouse/parcels/:id/label', labelParcel);
router.post('/warehouse/parcels/:id/handed', markParcelHanded);
router.post('/warehouse/parcels/:id/delivered', markParcelDelivered);

export default router;
