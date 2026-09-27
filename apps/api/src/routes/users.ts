import type { PrismaClient } from '@prisma/client';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';

const createUserBody = z
  .object({
    externalId: z.string().trim().min(1).max(255),
    email: z.string().trim().email().max(320).optional(),
    name: z.string().trim().min(1).max(200).optional(),
    timezone: z.string().trim().min(1).max(100).optional(),
  })
  .strict();

function isUniqueConflict(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 'P2002'
  );
}

export const userRoutes =
  (prisma: PrismaClient): FastifyPluginAsync =>
  async (app) => {
    app.post(
      '/v1/users',
      { preHandler: app.authenticate },
      async (request, reply) => {
        const parsed = createUserBody.safeParse(request.body);
        if (!parsed.success) {
          return reply.code(400).send({ error: 'Invalid request' });
        }

        try {
          const user = await prisma.user.create({
            data: {
              tenantId: request.tenant.id,
              externalId: parsed.data.externalId,
              ...(parsed.data.email !== undefined
                ? { email: parsed.data.email }
                : {}),
              ...(parsed.data.name !== undefined
                ? { name: parsed.data.name }
                : {}),
              ...(parsed.data.timezone !== undefined
                ? { timezone: parsed.data.timezone }
                : {}),
            },
          });
          return reply.code(201).send(user);
        } catch (error) {
          if (isUniqueConflict(error)) {
            return reply
              .code(409)
              .send({ error: 'externalId already exists for this tenant' });
          }
          throw error;
        }
      },
    );
  };
