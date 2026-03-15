import type { Request, Response, NextFunction } from 'express';
import { createScopedLogger } from './logger';

const logger = createScopedLogger('concurrency-queue');

interface QueueOptions {
  maxConcurrent: number;
  maxQueueSize: number;
  queueTimeoutMs: number;
}

interface QueueStats {
  active: number;
  queued: number;
  totalProcessed: number;
  totalRejected: number;
  totalTimedOut: number;
}

export function createConcurrencyQueue(opts: QueueOptions) {
  const { maxConcurrent, maxQueueSize, queueTimeoutMs } = opts;

  let active = 0;
  let totalProcessed = 0;
  let totalRejected = 0;
  let totalTimedOut = 0;
  const queue: Array<() => void> = [];

  function processNext() {
    if (queue.length === 0 || active >= maxConcurrent) return;

    const next = queue.shift();
    if (next) {
      active++;
      next();
    }
  }

  function release() {
    active--;
    totalProcessed++;
    processNext();
  }

  function getStats(): QueueStats {
    return { active, queued: queue.length, totalProcessed, totalRejected, totalTimedOut };
  }

  const middleware = (req: Request, res: Response, next: NextFunction) => {
    if (active < maxConcurrent) {
      active++;
      res.on('finish', release);
      res.on('close', release);
      return next();
    }

    if (queue.length >= maxQueueSize) {
      totalRejected++;
      logger.warn(`Concurrency queue full: active=${active}, queued=${queue.length} — rejecting request`);
      res.status(503).json({
        error: true,
        message: 'Server is busy. Please retry in a few seconds.',
        retryAfterMs: 2000,
      });
      return;
    }

    logger.info(`Request queued: active=${active}, queued=${queue.length + 1}`);

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      totalTimedOut++;
      const idx = queue.indexOf(proceed);
      if (idx !== -1) queue.splice(idx, 1);
      logger.warn(`Queued request timed out after ${queueTimeoutMs}ms`);
      if (!res.writableEnded) {
        res.status(503).json({
          error: true,
          message: 'Request timed out in queue. Server is overloaded. Please retry.',
          retryAfterMs: 5000,
        });
      }
    }, queueTimeoutMs);

    function proceed() {
      clearTimeout(timer);
      if (timedOut) {
        release();
        return;
      }
      res.on('finish', release);
      res.on('close', release);
      next();
    }

    queue.push(proceed);
  };

  return { middleware, getStats };
}
