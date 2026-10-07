import Redis from 'ioredis';
import { config } from './env.js';

let redisClient = null;
let isRedisConnected = false;
let warnedUnavailable = false;

if (config.redis.enabled) {
  try {
    const redisOptions = {
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      retryStrategy(times) {
        if (times > 5) {
          // Stop retrying after 5 attempts to avoid flooding logs if Redis is down
          console.warn('[Redis] Max reconnection attempts reached. Continuing with cache disabled.');
          return null;
        }
        const delay = Math.min(times * 500, 2000);
        return delay;
      },
      enableOfflineQueue: false, // Don't queue commands when offline to avoid latency spikes
    };

    if (config.redis.url) {
      redisClient = new Redis(config.redis.url, redisOptions);
    } else {
      redisClient = new Redis({
        host: config.redis.host,
        port: config.redis.port,
        password: config.redis.password,
        ...redisOptions,
      });
    }

    redisClient.on('connect', () => {
      isRedisConnected = true;
      warnedUnavailable = false;
      console.log(`[Redis] Connected to ${config.redis.host}:${config.redis.port}`);
    });

    redisClient.on('ready', () => {
      isRedisConnected = true;
      console.log('[Redis] Client ready to receive commands.');
    });

    redisClient.on('error', (err) => {
      isRedisConnected = false;
      // One warning per outage (not one per retry); the app keeps working without the cache
      if (!warnedUnavailable) {
        warnedUnavailable = true;
        console.warn(`[Redis Warning]: ${err.message}. Caching is bypassed - set REDIS_ENABLED=false in .env if you don't run Redis.`);
      }
    });

    redisClient.on('close', () => {
      isRedisConnected = false;
    });

    // Attempt initial connection asynchronously
    redisClient.connect().catch(() => {
      isRedisConnected = false; // already reported once by the 'error' handler
    });
  } catch (err) {
    console.warn('[Redis] Failed to initialize Redis client:', err.message);
  }
} else {
  console.log('[Redis] Redis is explicitly disabled via configuration.');
}

export const getRedisStatus = () => ({
  enabled: config.redis.enabled,
  connected: isRedisConnected,
  host: config.redis.host,
  port: config.redis.port,
});

export const isCacheAvailable = () => isRedisConnected && redisClient !== null;

export { redisClient };
export default redisClient;
