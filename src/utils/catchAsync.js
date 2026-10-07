/**
 * Wraps an async route handler or middleware to catch rejected promises
 * and pass them automatically to next() without repetitive try/catch blocks.
 *
 * @param {Function} fn - Async controller or middleware function
 * @returns {Function} Express request handler
 */
export const catchAsync = (fn) => {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
};

export default catchAsync;
