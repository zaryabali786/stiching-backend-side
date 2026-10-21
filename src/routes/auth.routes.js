import { Router } from 'express';
import {
  register,
  login,
  googleLogin,
  appleLogin,
  getMe,
  updateMe,
  logout,
  refreshSession,
  forgotPassword,
  resetPassword,
  changePassword,
  deleteMyAccount,
  requestLoginCode,
  verifyLoginCode,
} from '../controllers/auth.controller.js';
import { authenticate } from '../middlewares/auth.middleware.js';
import { validateRegister, validateLogin } from '../middlewares/validate.middleware.js';

const router = Router();

router.post('/register', validateRegister, register);
router.post('/login', validateLogin, login);
router.post('/google', googleLogin);
router.post('/apple', appleLogin);
router.post('/refresh', refreshSession);
router.post('/forgot-password', forgotPassword);
router.post('/reset-password', resetPassword);

router.get('/me', authenticate, getMe);
router.patch('/me', authenticate, updateMe);
router.post('/change-password', authenticate, changePassword);
router.post('/code/request', requestLoginCode);
router.post('/code/verify', verifyLoginCode);
router.post('/delete-account', authenticate, deleteMyAccount);
router.post('/logout', authenticate, logout);

export default router;
