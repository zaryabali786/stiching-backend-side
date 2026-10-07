import redisClient, { isCacheAvailable } from '../config/redis.js';
import { config } from '../config/env.js';

export class CacheHelper {
  /**
   * Retrieve an item from the Redis cache
   * @param {string} key
   * @returns {Promise<any|null>}
   */
  static async get(key) {
    if (!isCacheAvailable()) return null;

    try {
      const data = await redisClient.get(key);
      if (!data) return null;
      return JSON.parse(data);
    } catch (err) {
      console.warn(`[Cache Error] Failed to get key "${key}":`, err.message);
      return null;
    }
  }

  /**
   * Store an item in Redis cache with TTL
   * @param {string} key
   * @param {any} value
   * @param {number} [ttlSeconds]
   * @returns {Promise<boolean>}
   */
  static async set(key, value, ttlSeconds = config.redis.defaultTtl) {
    if (!isCacheAvailable()) return false;

    try {
      const serialized = JSON.stringify(value);
      if (ttlSeconds && ttlSeconds > 0) {
        await redisClient.set(key, serialized, 'EX', ttlSeconds);
      } else {
        await redisClient.set(key, serialized);
      }
      return true;
    } catch (err) {
      console.warn(`[Cache Error] Failed to set key "${key}":`, err.message);
      return false;
    }
  }

  /**
   * Delete a key from Redis cache
   * @param {string} key
   * @returns {Promise<boolean>}
   */
  static async del(key) {
    if (!isCacheAvailable()) return false;

    try {
      await redisClient.del(key);
      return true;
    } catch (err) {
      console.warn(`[Cache Error] Failed to delete key "${key}":`, err.message);
      return false;
    }
  }

  /**
   * Delete keys matching a wildcard pattern using SCAN (non-blocking)
   * Example: delByPattern('users:*')
   * @param {string} pattern
   * @returns {Promise<number>} Number of keys removed
   */
  static async delByPattern(pattern) {
    if (!isCacheAvailable()) return 0;

    let cursor = '0';
    let totalDeleted = 0;

    try {
      do {
        const [nextCursor, keys] = await redisClient.scan(
          cursor,
          'MATCH',
          pattern,
          'COUNT',
          100
        );
        cursor = nextCursor;

        if (keys.length > 0) {
          await redisClient.del(...keys);
          totalDeleted += keys.length;
        }
      } while (cursor !== '0');

      return totalDeleted;
    } catch (err) {
      console.warn(`[Cache Error] Failed to delete pattern "${pattern}":`, err.message);
      return totalDeleted;
    }
  }

  /**
   * Cache-Aside Helper:
   * Returns cached value if available, otherwise executes fetchFn, caches result, and returns.
   *
   * @param {string} key
   * @param {Function} fetchFn - Async function to retrieve source data
   * @param {number} [ttlSeconds]
   */
  static async getOrSet(key, fetchFn, ttlSeconds = config.redis.defaultTtl) {
    const cached = await this.get(key);
    if (cached !== null) {
      return cached;
    }

    const freshData = await fetchFn();
    if (freshData !== null && freshData !== undefined) {
      await this.set(key, freshData, ttlSeconds);
    }

    return freshData;
  }

  /**
   * Express Middleware for caching GET requests
   * @param {number} [ttlSeconds=300] - Cache duration in seconds
   * @param {Function} [keyGenerator] - Optional custom key generator: (req) => string
   */
  static routeCache(ttlSeconds = config.redis.defaultTtl, keyGenerator = null) {
    return async (req, res, next) => {
      // Only cache GET requests
      if (req.method !== 'GET' || !isCacheAvailable()) {
        res.setHeader('X-Cache', 'BYPASS');
        return next();
      }

      const cacheKey = keyGenerator
        ? keyGenerator(req)
        : `route:${req.originalUrl || req.url}:${req.userId || 'guest'}`;

      try {
        const cachedResponse = await CacheHelper.get(cacheKey);

        if (cachedResponse) {
          res.setHeader('X-Cache', 'HIT');
          return res.status(200).json(cachedResponse);
        }

        // Intercept res.json to capture response and cache it
        res.setHeader('X-Cache', 'MISS');
        const originalJson = res.json.bind(res);

        res.json = (body) => {
          // Only cache successful 200 responses
          if (res.statusCode >= 200 && res.statusCode < 300) {
            CacheHelper.set(cacheKey, body, ttlSeconds).catch(() => {});
          }
          return originalJson(body);
        };

        next();
      } catch (err) {
        console.warn('[Route Cache Middleware Error]:', err.message);
        next();
      }
    };
  }
}

export default CacheHelper;
