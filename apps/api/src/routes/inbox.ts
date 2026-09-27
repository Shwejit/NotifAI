import type { Prisma, PrismaClient } from '@prisma/client';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { decodeCursor, encodeCursor } from '../modules/cursor.js';
import type { RealtimeEventType, RealtimeService } from '../realtime/events.js';
import { publishRealtimeSafely } from '../realtime/publish.js';

const inboxQuery = z.object({
  userId: z.string().uuid(),
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
  status: z.enum(['all', 'unread', 'read']).default('all'),
  category: z.string().trim().min(1).max(100).optional(),
});
const userQuery = z.object({ userId: z.string().uuid() });
const notificationParams = z.object({ id: z.string().uuid() });
const readAllBody = z.object({ userId: z.string().uuid() }).strict();

async function userBelongsToTenant(
  prisma: PrismaClient,
  userId: string,
  tenantId: string,
): Promise<boolean> {
  const user = await prisma.user.findFirst({
    where: { id: userId, tenantId },
    select: { id: true },
  });
  return user !== null;
}

export const inboxRoutes =
  (prisma: PrismaClient, realtime: RealtimeService): FastifyPluginAsync =>
  async (app) => {
    app.get(
      '/v1/inbox/stream',
      { preHandler: app.authenticate },
      async (request, reply) => {
        const parsed = userQuery.safeParse(request.query);
        if (!parsed.success)
          return reply.code(400).send({ error: 'Invalid request' });
        const tenantId = request.tenant.id;
        const userId = parsed.data.userId;
        if (!(await userBelongsToTenant(prisma, userId, tenantId)))
          return reply.code(404).send({ error: 'User not found' });

        let unsubscribe: () => void;
        try {
          unsubscribe = await realtime.subscribe(tenantId, userId, (event) => {
            if (!reply.raw.destroyed) {
              const frame = `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
              if (!reply.raw.write(frame)) reply.raw.destroy();
            }
          });
        } catch (error) {
          request.log.error(
            { err: error },
            'Unable to subscribe to realtime events',
          );
          return reply.code(503).send({ error: 'Realtime stream unavailable' });
        }

        reply.hijack();
        reply.raw.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache, no-transform',
          Connection: 'keep-alive',
          'X-Accel-Buffering': 'no',
        });
        reply.raw.write(': connected\n\n');
        let cleaned = false;
        const cleanup = () => {
          if (cleaned) return;
          cleaned = true;
          clearInterval(heartbeat);
          unsubscribe();
        };
        const heartbeat = setInterval(() => {
          if (!reply.raw.write(': heartbeat\n\n')) {
            cleanup();
            reply.raw.destroy();
          }
        }, 20_000);
        heartbeat.unref();
        reply.raw.once('close', cleanup);
        reply.raw.once('error', cleanup);
        request.raw.once('aborted', cleanup);
      },
    );

    app.get(
      '/v1/inbox',
      { preHandler: app.authenticate },
      async (request, reply) => {
        const parsed = inboxQuery.safeParse(request.query);
        if (!parsed.success) {
          return reply.code(400).send({ error: 'Invalid request' });
        }
        const {
          userId,
          cursor: cursorValue,
          limit,
          status,
          category,
        } = parsed.data;
        const tenantId = request.tenant.id;
        if (!(await userBelongsToTenant(prisma, userId, tenantId))) {
          return reply.code(404).send({ error: 'User not found' });
        }

        const cursor = cursorValue ? decodeCursor(cursorValue) : null;
        if (cursorValue && !cursor) {
          return reply.code(400).send({ error: 'Invalid cursor' });
        }
        const where: Prisma.NotificationWhereInput = {
          tenantId,
          userId,
          archivedAt: null,
          ...(status === 'unread' ? { readAt: null } : {}),
          ...(status === 'read' ? { readAt: { not: null } } : {}),
          ...(category ? { category } : {}),
          ...(cursor
            ? {
                OR: [
                  { createdAt: { lt: cursor.createdAt } },
                  { createdAt: cursor.createdAt, id: { lt: cursor.id } },
                ],
              }
            : {}),
        };
        const rows = await prisma.notification.findMany({
          where,
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          take: limit + 1,
        });
        const hasMore = rows.length > limit;
        const items = hasMore ? rows.slice(0, limit) : rows;
        const last = items.at(-1);
        const nextCursor =
          hasMore && last
            ? encodeCursor({ createdAt: last.createdAt, id: last.id })
            : null;
        return { items, nextCursor };
      },
    );

    app.get(
      '/v1/inbox/unread-count',
      { preHandler: app.authenticate },
      async (request, reply) => {
        const parsed = userQuery.safeParse(request.query);
        if (!parsed.success) {
          return reply.code(400).send({ error: 'Invalid request' });
        }
        const tenantId = request.tenant.id;
        if (
          !(await userBelongsToTenant(prisma, parsed.data.userId, tenantId))
        ) {
          return reply.code(404).send({ error: 'User not found' });
        }
        const count = await prisma.notification.count({
          where: {
            tenantId,
            userId: parsed.data.userId,
            readAt: null,
            archivedAt: null,
          },
        });
        return { count };
      },
    );

    app.post(
      '/v1/inbox/read-all',
      { preHandler: app.authenticate },
      async (request, reply) => {
        const parsed = readAllBody.safeParse(request.body);
        if (!parsed.success) {
          return reply.code(400).send({ error: 'Invalid request' });
        }
        const tenantId = request.tenant.id;
        if (
          !(await userBelongsToTenant(prisma, parsed.data.userId, tenantId))
        ) {
          return reply.code(404).send({ error: 'User not found' });
        }
        const result = await prisma.notification.updateMany({
          where: {
            tenantId,
            userId: parsed.data.userId,
            readAt: null,
            archivedAt: null,
          },
          data: { readAt: new Date() },
        });
        await publishRealtimeSafely(
          realtime,
          {
            type: 'notification.read_all',
            tenantId,
            userId: parsed.data.userId,
            timestamp: new Date().toISOString(),
            data: { updatedCount: result.count },
          },
          request.log,
        );
        return { updated: result.count };
      },
    );

    const updateNotification = async (
      request: FastifyRequest,
      reply: FastifyReply,
      data: { readAt?: Date | null; archivedAt?: Date },
      eventType: Extract<
        RealtimeEventType,
        'notification.read' | 'notification.unread' | 'notification.archived'
      >,
    ) => {
      const parsed = notificationParams.safeParse(request.params);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'Invalid request' });
      }
      const result = await prisma.notification.updateMany({
        where: { id: parsed.data.id, tenantId: request.tenant.id },
        data,
      });
      if (result.count === 0) {
        return reply.code(404).send({ error: 'Notification not found' });
      }
      const notification = await prisma.notification.findFirst({
        where: { id: parsed.data.id, tenantId: request.tenant.id },
      });
      if (!notification)
        return reply.code(404).send({ error: 'Notification not found' });
      await publishRealtimeSafely(
        realtime,
        {
          type: eventType,
          tenantId: notification.tenantId,
          userId: notification.userId,
          notificationId: notification.id,
          timestamp: new Date().toISOString(),
        },
        request.log,
      );
      return notification;
    };

    app.patch(
      '/v1/inbox/:id/read',
      { preHandler: app.authenticate },
      (request, reply) =>
        updateNotification(
          request,
          reply,
          { readAt: new Date() },
          'notification.read',
        ),
    );
    app.patch(
      '/v1/inbox/:id/unread',
      { preHandler: app.authenticate },
      (request, reply) =>
        updateNotification(
          request,
          reply,
          { readAt: null },
          'notification.unread',
        ),
    );
    app.patch(
      '/v1/inbox/:id/archive',
      { preHandler: app.authenticate },
      (request, reply) =>
        updateNotification(
          request,
          reply,
          { archivedAt: new Date() },
          'notification.archived',
        ),
    );
  };
