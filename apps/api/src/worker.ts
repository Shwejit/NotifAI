import Fastify from 'fastify';
import { config } from './config.js';
import { prisma } from './db.js';
import { MockEmailProvider } from './delivery/email-provider.js';
import { createEmailWorker } from './delivery/email-worker.js';

const logger = Fastify({ logger: true }).log;
const emailProvider = new MockEmailProvider(logger);
const handle = createEmailWorker(
  config.REDIS_URL,
  prisma,
  emailProvider,
  logger,
  config.EMAIL_FROM,
);

logger.info('Email worker started');
let shuttingDown = false;
const shutdown = async () => {
  if (shuttingDown) return;
  shuttingDown = true;
  await handle.close();
  await prisma.$disconnect();
  process.exit(0);
};
process.once('SIGINT', () => void shutdown());
process.once('SIGTERM', () => void shutdown());
