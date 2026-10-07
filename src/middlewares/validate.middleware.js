import { BadRequestError } from '../utils/error.helper.js';

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const validateRegister = (req, res, next) => {
  const { email, password, fullName, phone, portal = 'customer' } = req.body || {};
  const errors = [];

  if (!email || !EMAIL_REGEX.test(String(email).trim())) errors.push('A valid email address is required.');
  if (!password || typeof password !== 'string' || password.length < 8) errors.push('Password must be at least 8 characters long.');
  if (!fullName || typeof fullName !== 'string' || fullName.trim().length < 2) errors.push('Full name is required.');
  if (!['customer', 'staff'].includes(portal)) errors.push("portal must be 'customer' or 'staff'.");

  if (portal === 'customer') {
    if (!phone || String(phone).trim().length < 6) errors.push('Phone number is required.');
    for (const field of ['country', 'city', 'address']) {
      if (!req.body[field] || !String(req.body[field]).trim()) errors.push(`${field[0].toUpperCase()}${field.slice(1)} is required.`);
    }
  }

  if (errors.length > 0) {
    return next(new BadRequestError(errors[0], errors));
  }
  next();
};

export const validateLogin = (req, res, next) => {
  const { email, password } = req.body || {};
  const errors = [];

  if (!email || !EMAIL_REGEX.test(String(email).trim())) errors.push('A valid email address is required.');
  if (!password) errors.push('Password is required.');

  if (errors.length > 0) {
    return next(new BadRequestError(errors[0], errors));
  }
  next();
};
