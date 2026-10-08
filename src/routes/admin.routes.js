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

import { listHomeArticles, getAdminHomeLayout, saveAdminHomeLayout, uploadHomeImage } from '../controllers/home-layout.controller.js';
import { getClientTheme, setClientTheme, createClientPreset, deleteClientPreset } from '../controllers/theme.controller.js';
import { getDashboard, getDashboardLayout, setDashboardLayout, resetDashboardLayout } from '../controllers/dashboard.controller.js';
import { getPortalTheme, setPortalTheme, resetPortalTheme, createPortalPreset, deletePortalPreset } from '../controllers/portal-theme.controller.js';
import { getBanners, createBanner, updateBanner, deleteBanner } from '../controllers/banner.controller.js';

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

// Customer app home page sections
router.get('/home-layout', getAdminHomeLayout);
router.get('/home-layout/articles', listHomeArticles);
router.put('/home-layout', saveAdminHomeLayout);
router.post('/home-layout/image', uploadHomeImage);

// Customer app appearance (colours, fonts)
router.get('/settings/client-theme', getClientTheme);
router.put('/settings/client-theme', setClientTheme);
router.post('/settings/client-theme/presets', createClientPreset);
router.delete('/settings/client-theme/presets/:id', deleteClientPreset);
router.get('/dashboard', getDashboard);
router.get('/dashboard/layout', getDashboardLayout);
router.put('/dashboard/layout', setDashboardLayout);
router.delete('/dashboard/layout', resetDashboardLayout);
router.get('/settings/portal-theme', getPortalTheme);
router.put('/settings/portal-theme', setPortalTheme);
router.delete('/settings/portal-theme', resetPortalTheme);
router.post('/settings/portal-theme/presets', createPortalPreset);
router.delete('/settings/portal-theme/presets/:id', deletePortalPreset);

// Home-page banners
router.get('/banners', getBanners);
router.post('/banners', createBanner);
router.patch('/banners/:id', updateBanner);
router.delete('/banners/:id', deleteBanner);

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
