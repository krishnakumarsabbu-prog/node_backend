
import express from 'express';
import cors from 'cors';
import { chatHandler } from './routes/chat';
import { enhancerHandler } from './routes/enhancer';
import { llmCallHandler } from './routes/llmcall';
import { templateHandler } from './routes/template';
import { createScopedLogger } from './utils/logger';
import { MCPService } from './llm/mcpService';

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

app.get('/health', (_req, res) => {
  const mcpHealth = MCPService.getInstance().getServerHealth();
  res.json({
    status: 'ok',
    uptime: Math.round(process.uptime()),
    memoryMB: Math.round(process.memoryUsage().rss / 1024 / 1024),
    mcpServers: mcpHealth,
  });
});

app.post('/api/chat', chatHandler);
app.post('/api/enhancer', enhancerHandler);
app.post('/api/llmcall', llmCallHandler);
app.post('/api/template', templateHandler);

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
    logger.warn('Graceful shutdown timed out after 15s, forcing exit');
    process.exit(1);
  }, 15_000).unref();
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
