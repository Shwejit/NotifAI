import Fastify, { type FastifyError } from 'fastify';
import { createRealtimeService } from './realtime/pubsub.js';
import {
  createEmailQueue,
  createNoopEmailQueue,
} from './queues/email.queue.js';
import type { EmailQueueService } from './delivery/types.js';
import { deliveryRoutes } from './routes/deliveries.js';
import type { RealtimeService } from './realtime/events.js';
import fastifySensible from '@fastify/sensible';
import type { PrismaClient } from '@prisma/client';
import { prisma as defaultPrisma } from './db.js';
import authPlugin from './plugins/auth.js';
import { adminRoutes } from './routes/admin.js';
import { authRoutes } from './routes/auth.js';
import { inboxRoutes } from './routes/inbox.js';
import { notificationRoutes } from './routes/notifications.js';
import { preferenceRoutes } from './routes/preferences.js';
import { userRoutes } from './routes/users.js';

export function buildApp(
  prisma: PrismaClient = defaultPrisma,
  realtime?: RealtimeService,
  emailQueue?: EmailQueueService,
) {
  const app = Fastify({
    logger: {
      level: process.env.NODE_ENV === 'production' ? 'info' : 'debug',
      redact: ['req.headers.authorization', 'req.headers.cookie'],
    },
  });

  const realtimeService =
    realtime ??
    createRealtimeService(
      process.env.REDIS_URL ?? 'redis://localhost:6379',
      app.log,
    );
  const emailQueueService =
    emailQueue ??
    (process.env.NODE_ENV === 'test'
      ? createNoopEmailQueue()
      : createEmailQueue(
          process.env.REDIS_URL ?? 'redis://localhost:6379',
          app.log,
        ));
  app.addHook('onClose', async () => {
    await Promise.all([realtimeService.close(), emailQueueService.close()]);
  });

  app.setErrorHandler((error: FastifyError, request, reply) => {
    const statusCode = error.statusCode ?? 500;
    if (statusCode >= 500) {
      request.log.error(error);
      return reply.code(500).send({ error: 'Internal server error' });
    }
    return reply.code(statusCode).send({ error: error.message });
  });

  app.register(fastifySensible);
  app.register(authPlugin, { prisma });
  app.register(adminRoutes(prisma));
  app.register(authRoutes);
  app.register(userRoutes(prisma));
  app.register(notificationRoutes(prisma, realtimeService, emailQueueService));
  app.register(inboxRoutes(prisma, realtimeService));
  app.register(deliveryRoutes(prisma));
  app.register(preferenceRoutes(prisma));

  app.get('/health', async () => ({ status: 'ok' }));

  return app;
}
