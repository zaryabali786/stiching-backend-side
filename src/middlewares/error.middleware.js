/**
 * 404 Not Found handler
 */
export const notFoundHandler = (req, res, next) => {
  res.status(404).json({
    success: false,
    message: `Cannot ${req.method} ${req.originalUrl} - Endpoint not found`,
  });
};

/**
 * Global Express error handling middleware
 */
export const errorHandler = (err, req, res, next) => {
  let statusCode = err.statusCode || err.status || 500;
  let message = err.message || 'Internal Server Error';
  let details = err.details || null;
  let status = err.status && typeof err.status === 'string' 
    ? err.status 
    : `${statusCode}`.startsWith('4') ? 'fail' : 'error';

  // Handle malformed JSON body errors
  if (err instanceof SyntaxError && err.status === 400 && 'body' in err) {
    statusCode = 400;
    status = 'fail';
    message = 'Malformed JSON in request body.';
  }

  // Handle Supabase Auth common errors
  if (err.message) {
    if (err.code === 'email_exists' || err.message.includes('already been registered') || err.message.includes('User already registered')) {
      statusCode = 409;
      status = 'fail';
      message = 'An account with this email address already exists.';
    } else if (err.message.includes('Invalid login credentials')) {
      statusCode = 401;
      status = 'fail';
      message = 'Invalid email or password.';
    } else if (err.message.includes('Email not confirmed')) {
      statusCode = 403;
      status = 'fail';
      message = 'Email address is not confirmed. Please check your inbox.';
    } else if (err.message.includes('Email logins are disabled') || err.code === 'email_provider_disabled') {
      statusCode = 503;
      status = 'error';
      message = 'Email login is disabled in Supabase. Enable it under Authentication → Sign In / Providers → Email.';
    } else if (err.message.includes('Password should be') || err.code === 'weak_password') {
      statusCode = 400;
      status = 'fail';
    } else if (err.message.includes('JWT expired') || err.message.includes('invalid claim')) {
      statusCode = 401;
      status = 'fail';
      message = 'Your session has expired. Please log in again.';
    }
  }

  // Log 5xx errors to console
  if (statusCode >= 500) {
    console.error(`[Server Error ${statusCode}]:`, err);
  }

  res.status(statusCode).json({
    success: false,
    statusCode,
    status,
    message,
    ...(details && { details }),
    // Stack traces expose server paths: only include them when explicitly debugging
    ...(process.env.DEBUG_ERRORS === 'true' && {
      name: err.name,
      stack: err.stack,
    }),
  });
};
