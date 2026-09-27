import Fastify from 'fastify';
import fastifySensible from '@fastify/sensible';
import { prisma as defaultPrisma } from './db.js';
import authPlugin from './plugins/auth.js';
import { adminRoutes } from './routes/admin.js';
import { authRoutes } from './routes/auth.js';
import type { PrismaClient } from '@prisma/client';

export function buildApp(prisma: PrismaClient = defaultPrisma) {
  const app = Fastify({
    logger: {
      level: process.env.NODE_ENV === 'production' ? 'info' : 'debug',
      redact: ['req.headers.authorization', 'req.headers.cookie'],
    },
  });
  app.register(fastifySensible);
  app.register(authPlugin, { prisma });2
  app.register(adminRoutes(prisma));
  app.register(authRoutes);

  app.get('/health', async () => ({ status: 'ok' }));

  return app;
}
