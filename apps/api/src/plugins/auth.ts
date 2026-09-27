import fp from 'fastify-plugin';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import type { PrismaClient, Tenant } from '@prisma/client';
import { hashApiKey } from '../modules/api-keys.js';

declare module 'fastify' {
  interface FastifyRequest {
    tenant: Tenant;
  }
}

type AuthDependencies = { prisma: PrismaClient };

const authPlugin: FastifyPluginAsync<AuthDependencies> = async (
  app,
  { prisma },
) => {
  app.decorateRequest('tenant');
  app.decorate(
    'authenticate',
    async function authenticate(request: FastifyRequest) {
      const header = request.headers.authorization;
      const [scheme, secret] = header?.split(' ') ?? [];
      if (scheme !== 'Bearer' || !secret) {
        throw app.httpErrors.unauthorized('Invalid or missing API key');
      }

      const apiKey = await prisma.apiKey.findUnique({
        where: { keyHash: hashApiKey(secret) },
        include: { tenant: true },
      });
      if (
        !apiKey ||
        apiKey.revokedAt ||
        (apiKey.expiresAt && apiKey.expiresAt <= new Date())
      ) {
        throw app.httpErrors.unauthorized('Invalid or missing API key');
      }

      request.tenant = apiKey.tenant;
      await prisma.apiKey.update({
        where: { id: apiKey.id },
        data: { lastUsedAt: new Date() },
      });
    },
  );
};

declare module 'fastify' {
  interface FastifyInstance {
    authenticate: (request: FastifyRequest) => Promise<void>;
  }
}

export default fp(authPlugin);
