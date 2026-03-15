
import express from 'express';
import cors from 'cors';
import { chatHandler } from './routes/chat';
import { enhancerHandler } from './routes/enhancer';
import { llmCallHandler } from './routes/llmcall';
import { templateHandler } from './routes/template';
import { createScopedLogger } from './utils/logger';
import { chatRateLimit, llmCallRateLimit, enhancerRateLimit } from './utils/rateLimiter';
import { createConcurrencyQueue } from './utils/concurrencyQueue';

const logger = createScopedLogger('server');

const app = express();

app.use(cors());
app.use(express.json({ limit: '50mb' }));

app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  next();
});

const chatQueue = createConcurrencyQueue({
  maxConcurrent: 8,
  maxQueueSize: 32,
  queueTimeoutMs: 30_000,
});

const serverStartTime = Date.now();

app.get('/health', (_req, res) => {
  const mem = process.memoryUsage();
  const uptimeSeconds = Math.floor((Date.now() - serverStartTime) / 1000);
  const queueStats = chatQueue.getStats();

  res.json({
    status: 'ok',
    uptime: uptimeSeconds,
    memory: {
      heapUsedMb: Math.round(mem.heapUsed / 1024 / 1024),
      heapTotalMb: Math.round(mem.heapTotal / 1024 / 1024),
      rssM: Math.round(mem.rss / 1024 / 1024),
    },
    concurrency: queueStats,
    version: process.env.npm_package_version || '1.0.0',
    nodeVersion: process.version,
  });
});

app.get('/health/live', (_req, res) => {
  res.status(200).json({ alive: true });
});

app.get('/health/ready', (_req, res) => {
  const mem = process.memoryUsage();
  const heapUsedMb = mem.heapUsed / 1024 / 1024;

  if (heapUsedMb > 1800) {
    res.status(503).json({ ready: false, reason: 'memory pressure', heapUsedMb: Math.round(heapUsedMb) });
    return;
  }

  res.status(200).json({ ready: true });
});

app.post('/api/chat', chatRateLimit, chatQueue.middleware, chatHandler);
app.post('/api/enhancer', enhancerRateLimit, enhancerHandler);
app.post('/api/llmcall', llmCallRateLimit, llmCallHandler);
app.post('/api/template', templateHandler);

app.use((_req, res) => {
  res.status(404).json({ error: true, message: 'Not found' });
});

app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  logger.error('Unhandled error:', err);
  if (!res.headersSent) {
    res.status(500).json({ error: true, message: 'Internal server error' });
  }
});

const PORT = Number(process.env.PORT) || 8999;

const server = app.listen(PORT, () => {
  logger.info(`Gateway running at http://localhost:${PORT}`);
});

server.keepAliveTimeout = 65_000;
server.headersTimeout = 66_000;

let shuttingDown = false;

function gracefulShutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info(`${signal} received — starting graceful shutdown`);

  server.close(() => {
    logger.info('All connections drained, exiting');
    process.exit(0);
  });

  setTimeout(() => {
    logger.warn('Graceful shutdown timed out after 30s, forcing exit');
    process.exit(1);
  }, 30_000).unref();
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

process.on('uncaughtException', (err) => {
  logger.error('Uncaught exception:', err);
  gracefulShutdown('uncaughtException');
});

process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled rejection:', reason);
});
