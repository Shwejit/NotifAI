import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { PrismaClient } from '@prisma/client';
import { createApiKey } from '../modules/api-keys.js';

const tenantInput = z.object({
  name: z.string().trim().min(1).max(100),
  slug: z
    .string()
    .regex(/^[a-z0-9-]+$/)
    .min(1)
    .max(63),
});
const keyInput = z.object({
  name: z.string().trim().min(1).max(100),
  expiresAt: z.coerce.date().optional(),
});

export const adminRoutes =
  (prisma: PrismaClient): FastifyPluginAsync =>
  async (app) => {
    app.post('/v1/tenants', async (request, reply) => {
      const parsed = tenantInput.safeParse(request.body);
      if (!parsed.success)
        return reply.code(400).send({ error: 'Invalid request' });
      try {
        const tenant = await prisma.tenant.create({
          data: parsed.data,
          select: {
            id: true,
            name: true,
            slug: true,
            createdAt: true,
            updatedAt: true,
          },
        });
        return reply.code(201).send(tenant);
      } catch {
        return reply.code(409).send({ error: 'Tenant slug already exists' });
      }
    });

    app.post('/v1/tenants/:tenantId/api-keys', async (request, reply) => {
      const params = z
        .object({ tenantId: z.string().uuid() })
        .safeParse(request.params);
      const body = keyInput.safeParse(request.body);
      if (!params.success || !body.success)
        return reply.code(400).send({ error: 'Invalid request' });
      const generated = createApiKey();
      try {
        const key = await prisma.apiKey.create({
          data: {
            keyHash: generated.keyHash,
            prefix: generated.prefix,
            tenantId: params.data.tenantId,
            name: body.data.name,
            ...(body.data.expiresAt ? { expiresAt: body.data.expiresAt } : {}),
          },
          select: {
            id: true,
            tenantId: true,
            name: true,
            prefix: true,
            type: true,
            createdAt: true,
            expiresAt: true,
          },
        });
        return reply.code(201).send({ ...key, secret: generated.secret });
      } catch {
        return reply.code(404).send({ error: 'Tenant not found' });
      }
    });
  };
