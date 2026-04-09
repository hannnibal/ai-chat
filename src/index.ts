import 'dotenv/config';
import express from 'express';
import type { Server } from 'http';
import { config } from './config';
import { logger } from './logger';
import { initAccountManager, getAllAccounts, disconnectAccountById, stopHealthChecks } from './accountManager';
import router from './routes';
import adminRouter from './adminRoutes';

const app = express();
app.use(express.json());
app.use(adminRouter); // admin routes first (includes /health override)
app.use(router);

function listenAsync(): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = app.listen(config.port, () => {
      logger.info({ port: config.port }, 'Baileys Adapter HTTP server started');
      server.off('error', reject);
      resolve(server);
    });

    server.once('error', reject);
  });
}

async function start(): Promise<void> {
  await listenAsync();

  // 初始化多账号管理器（加载已保存账号并自动连接）
  await initAccountManager();
}

// 优雅退出：确保关闭所有 WebSocket 连接
async function gracefulShutdown(signal: string) {
  logger.info({ signal }, 'Received shutdown signal, cleaning up...');
  // 关闭所有账号的 socket 连接
  for (const account of getAllAccounts()) {
    try {
      await disconnectAccountById(account.id);
    } catch {}
  }
  stopHealthChecks();
  process.exit(0);
}

process.on('SIGTERM', () => {
  gracefulShutdown('SIGTERM').catch((err) => {
    logger.error({ err }, 'Graceful shutdown failed on SIGTERM');
    process.exit(1);
  });
});

process.on('SIGINT', () => {
  gracefulShutdown('SIGINT').catch((err) => {
    logger.error({ err }, 'Graceful shutdown failed on SIGINT');
    process.exit(1);
  });
});

process.on('unhandledRejection', (reason) => {
  logger.error(
    {
      reason: typeof reason === 'object' ? reason : String(reason),
    },
    'Unhandled promise rejection'
  );
});

process.on('uncaughtException', (err) => {
  logger.error({ err }, 'Uncaught exception');
});

start().catch((err) => {
  logger.error({ err }, 'Failed to start Baileys Adapter');
  process.exit(1);
});
