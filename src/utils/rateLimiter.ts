import type { Request, Response, NextFunction } from 'express';
import { createScopedLogger } from './logger';

const logger = createScopedLogger('rate-limiter');

interface BucketEntry {
  count: number;
  resetAt: number;
}

interface RateLimitOptions {
  windowMs: number;
  maxRequests: number;
  message?: string;
}

function createRateLimiter(opts: RateLimitOptions) {
  const { windowMs, maxRequests, message = 'Too many requests. Please slow down.' } = opts;
  const buckets = new Map<string, BucketEntry>();

  setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of buckets.entries()) {
      if (entry.resetAt <= now) buckets.delete(key);
    }
  }, windowMs).unref();

  return (req: Request, res: Response, next: NextFunction) => {
    const ip = (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim()
      || req.socket.remoteAddress
      || 'unknown';

    const now = Date.now();
    const existing = buckets.get(ip);

    if (!existing || existing.resetAt <= now) {
      buckets.set(ip, { count: 1, resetAt: now + windowMs });
      return next();
    }

    existing.count += 1;

    if (existing.count > maxRequests) {
      const retryAfter = Math.ceil((existing.resetAt - now) / 1000);
      logger.warn(`Rate limit exceeded for IP ${ip}: ${existing.count} requests in window`);
      res.setHeader('Retry-After', String(retryAfter));
      res.setHeader('X-RateLimit-Limit', String(maxRequests));
      res.setHeader('X-RateLimit-Remaining', '0');
      res.setHeader('X-RateLimit-Reset', String(Math.ceil(existing.resetAt / 1000)));
      res.status(429).json({ error: true, message });
      return;
    }

    res.setHeader('X-RateLimit-Limit', String(maxRequests));
    res.setHeader('X-RateLimit-Remaining', String(maxRequests - existing.count));
    res.setHeader('X-RateLimit-Reset', String(Math.ceil(existing.resetAt / 1000)));
    next();
  };
}

export const chatRateLimit = createRateLimiter({
  windowMs: 60_000,
  maxRequests: 30,
  message: 'Chat rate limit exceeded. Maximum 30 requests per minute.',
});

export const llmCallRateLimit = createRateLimiter({
  windowMs: 60_000,
  maxRequests: 60,
  message: 'LLM call rate limit exceeded. Maximum 60 requests per minute.',
});

export const enhancerRateLimit = createRateLimiter({
  windowMs: 60_000,
  maxRequests: 20,
  message: 'Enhancer rate limit exceeded. Maximum 20 requests per minute.',
});
