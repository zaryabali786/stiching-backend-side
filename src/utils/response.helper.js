/**
 * Standardized API Response Helper
 */
export class ApiResponse {
  /**
   * Send a successful HTTP response
   * @param {Object} res - Express response object
   * @param {any} data - Response payload
   * @param {string} [message='Success'] - Optional status message
   * @param {number} [statusCode=200] - HTTP status code
   * @param {Object} [meta=null] - Optional pagination or metadata
   */
  static success(res, data = null, message = 'Success', statusCode = 200, meta = null) {
    const payload = {
      success: true,
      statusCode,
      message,
      data,
    };

    if (meta) {
      payload.meta = meta;
      // Same paging info under the name list consumers expect: { page, limit, total, totalPages }
      if (typeof meta.totalPages === 'number') payload.pagination = meta;
    }

    return res.status(statusCode).json(payload);
  }

  /**
   * Send a 201 Created HTTP response
   */
  static created(res, data = null, message = 'Resource created successfully', meta = null) {
    return this.success(res, data, message, 201, meta);
  }

  /**
   * Send an error HTTP response directly
   */
  static error(res, message = 'An error occurred', statusCode = 500, details = null) {
    return res.status(statusCode).json({
      success: false,
      statusCode,
      message,
      ...(details && { details }),
    });
  }
}

export default ApiResponse;
