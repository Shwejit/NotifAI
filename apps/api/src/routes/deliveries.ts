import type { PrismaClient } from '@prisma/client';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';

const deliveryParams = z.object({ id: z.string().uuid() });

export const deliveryRoutes =
  (prisma: PrismaClient): FastifyPluginAsync =>
  async (app) => {
    app.get(
      '/v1/deliveries/:id',
      { preHandler: app.authenticate },
      async (request, reply) => {
        const parsed = deliveryParams.safeParse(request.params);
        if (!parsed.success) {
          return reply.code(400).send({ error: 'Invalid request' });
        }
        const delivery = await prisma.delivery.findFirst({
          where: {
            id: parsed.data.id,
            notification: { tenantId: request.tenant.id },
          },
          select: {
            id: true,
            notificationId: true,
            channel: true,
            status: true,
            attempts: true,
            error: true,
            lastAttemptAt: true,
            deliveredAt: true,
            createdAt: true,
            updatedAt: true,
          },
        });
        if (!delivery)
          return reply.code(404).send({ error: 'Delivery not found' });
        return delivery;
      },
    );
  };
