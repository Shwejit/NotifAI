import type { PrismaClient } from '@prisma/client';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { RealtimeService } from '../realtime/events.js';
import { publishRealtimeSafely } from '../realtime/publish.js';
import type { EmailQueueService } from '../delivery/types.js';
import {
  isUserInDnd,
  shouldDeliverChannel,
} from '../preferences/preference.service.js';

const createNotificationBody = z
  .object({
    externalUserId: z.string().trim().min(1).max(255),
    title: z.string().trim().min(1).max(200),
    body: z.string().trim().min(1).max(10000),
    category: z.string().trim().min(1).max(100).optional(),
    actionUrl: z.string().max(2048).optional(),
    priority: z.enum(['URGENT', 'IMPORTANT', 'LOW']).default('IMPORTANT'),
    idempotencyKey: z.string().trim().min(1).max(255).optional(),
  })
  .strict();
const notificationIdParams = z.object({ id: z.string().uuid() });

function isUniqueConflict(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 'P2002'
  );
}

export const notificationRoutes =
  (
    prisma: PrismaClient,
    realtime: RealtimeService,
    emailQueue: EmailQueueService,
  ): FastifyPluginAsync =>
  async (app) => {
    app.post(
      '/v1/notifications',
      { preHandler: app.authenticate },
      async (request, reply) => {
        const parsed = createNotificationBody.safeParse(request.body);
        if (!parsed.success) {
          return reply.code(400).send({ error: 'Invalid request' });
        }
        const tenantId = request.tenant.id;
        const { externalUserId, idempotencyKey, ...fields } = parsed.data;
        const user = await prisma.user.findFirst({
          where: { tenantId, externalId: externalUserId },
          select: {
            id: true,
            email: true,
            timezone: true,
            dndEnabled: true,
            dndStartTime: true,
            dndEndTime: true,
          },
        });
        if (!user) return reply.code(404).send({ error: 'User not found' });

        if (idempotencyKey) {
          const existing = await prisma.notification.findFirst({
            where: { tenantId, idempotencyKey },
          });
          if (existing) return reply.code(200).send(existing);
        }

        const emailAllowed = await shouldDeliverChannel(prisma, {
          tenantId,
          userId: user.id,
          category: fields.category ?? 'default',
          channel: 'EMAIL',
        });
        const inDnd = isUserInDnd(user);
        const hasEmail = Boolean(user.email?.trim());
        const shouldQueueEmail = hasEmail && emailAllowed && !inDnd;

        let created;
        try {
          created = await prisma.notification.create({
            data: {
              tenantId,
              userId: user.id,
              title: fields.title,
              body: fields.body,
              priority: fields.priority,
              ...(fields.category !== undefined
                ? { category: fields.category }
                : {}),
              ...(fields.actionUrl !== undefined
                ? { actionUrl: fields.actionUrl }
                : {}),
              ...(idempotencyKey ? { idempotencyKey } : {}),
              deliveries: {
                create: {
                  channel: 'EMAIL',
                  status: !hasEmail
                    ? 'FAILED'
                    : shouldQueueEmail
                      ? 'PENDING'
                      : 'SUPPRESSED',
                  ...(!hasEmail
                    ? { error: 'User email is missing' }
                    : !emailAllowed
                      ? { error: 'Email disabled by user preference' }
                      : inDnd
                        ? { error: 'Suppressed by do-not-disturb schedule' }
                        : {}),
                },
              },
            },
            include: { deliveries: true },
          });
        } catch (error) {
          if (idempotencyKey && isUniqueConflict(error)) {
            const existing = await prisma.notification.findFirst({
              where: { tenantId, idempotencyKey },
            });
            if (existing) return reply.code(200).send(existing);
          }
          throw error;
        }

        const { deliveries, ...notification } = created;
        const delivery = deliveries[0];
        if (shouldQueueEmail && delivery) {
          try {
            await emailQueue.enqueue({
              deliveryId: delivery.id,
              notificationId: notification.id,
            });
          } catch (error) {
            request.log.error(
              {
                err: error,
                deliveryId: delivery.id,
                notificationId: notification.id,
              },
              'Email job enqueue failed; notification was created',
            );
            try {
              await prisma.delivery.update({
                where: { id: delivery.id },
                data: {
                  status: 'FAILED',
                  error: 'Unable to enqueue email delivery',
                },
              });
            } catch (updateError) {
              request.log.error(
                { err: updateError, deliveryId: delivery.id },
                'Unable to record queue failure',
              );
            }
          }
        } else {
          request.log.warn(
            { notificationId: notification.id },
            !hasEmail
              ? 'Email delivery not queued because user email is missing'
              : 'Email delivery suppressed by preference or DND',
          );
        }

        await publishRealtimeSafely(
          realtime,
          {
            type: 'notification.created',
            tenantId,
            userId: user.id,
            notificationId: notification.id,
            timestamp: new Date().toISOString(),
            data: {
              notification: {
                id: notification.id,
                title: notification.title,
                body: notification.body,
                category: notification.category,
                actionUrl: notification.actionUrl,
                priority: notification.priority,
                createdAt: notification.createdAt,
                readAt: notification.readAt,
                archivedAt: notification.archivedAt,
              },
            },
          },
          request.log,
        );
        return reply.code(201).send(notification);
      },
    );

    app.get(
      '/v1/notifications/:id',
      { preHandler: app.authenticate },
      async (request, reply) => {
        const parsed = notificationIdParams.safeParse(request.params);
        if (!parsed.success) {
          return reply.code(400).send({ error: 'Invalid request' });
        }
        const notification = await prisma.notification.findFirst({
          where: { id: parsed.data.id, tenantId: request.tenant.id },
        });
        if (!notification)
          return reply.code(404).send({ error: 'Notification not found' });
        return notification;
      },
    );
  };
