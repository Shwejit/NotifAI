import type { FastifyPluginAsync } from 'fastify';

export const authRoutes: FastifyPluginAsync = async (app) => {
  app.get('/v1/auth/me', { preHandler: app.authenticate }, async (request) => ({
    tenant: request.tenant,
  }));
};
