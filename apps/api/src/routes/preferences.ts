import type { PrismaClient } from '@prisma/client';
import type { FastifyPluginAsync } from 'fastify';
import {
  digestBody,
  dndBody,
  preferenceBody,
  userIdQuery,
} from '../preferences/schemas.js';
import { timezoneSchema } from '../preferences/schemas.js';

async function hasUser(prisma: PrismaClient, userId: string, tenantId: string) {
  return Boolean(
    await prisma.user.findFirst({
      where: { id: userId, tenantId },
      select: { id: true },
    }),
  );
}

export const preferenceRoutes =
  (prisma: PrismaClient): FastifyPluginAsync =>
  async (app) => {
    app.get(
      '/v1/preferences',
      { preHandler: app.authenticate },
      async (request, reply) => {
        const parsed = userIdQuery.safeParse(request.query);
        if (!parsed.success)
          return reply.code(400).send({ error: 'Invalid request' });
        const { userId } = parsed.data;
        if (!(await hasUser(prisma, userId, request.tenant.id)))
          return reply.code(404).send({ error: 'User not found' });
        const items = await prisma.preference.findMany({
          where: { userId, user: { tenantId: request.tenant.id } },
          orderBy: [{ category: 'asc' }, { channel: 'asc' }],
        });
        return { items, defaults: { IN_APP: true, EMAIL: true } };
      },
    );

    app.put(
      '/v1/preferences',
      { preHandler: app.authenticate },
      async (request, reply) => {
        const parsed = preferenceBody.safeParse(request.body);
        if (!parsed.success)
          return reply.code(400).send({ error: 'Invalid request' });
        const { userId, category, channel, enabled } = parsed.data;
        if (!(await hasUser(prisma, userId, request.tenant.id)))
          return reply.code(404).send({ error: 'User not found' });
        const preference = await prisma.preference.upsert({
          where: { userId_category_channel: { userId, category, channel } },
          create: { userId, category, channel, enabled },
          update: { enabled },
        });
        return preference;
      },
    );

    app.get(
      '/v1/preferences/dnd',
      { preHandler: app.authenticate },
      async (request, reply) => {
        const parsed = userIdQuery.safeParse(request.query);
        if (!parsed.success)
          return reply.code(400).send({ error: 'Invalid request' });
        const user = await prisma.user.findFirst({
          where: { id: parsed.data.userId, tenantId: request.tenant.id },
          select: {
            id: true,
            dndEnabled: true,
            dndStartTime: true,
            dndEndTime: true,
            timezone: true,
          },
        });
        if (!user) return reply.code(404).send({ error: 'User not found' });
        return {
          userId: user.id,
          enabled: user.dndEnabled,
          startTime: user.dndStartTime,
          endTime: user.dndEndTime,
          timezone: user.timezone,
        };
      },
    );

    app.put(
      '/v1/preferences/dnd',
      { preHandler: app.authenticate },
      async (request, reply) => {
        const parsed = dndBody.safeParse(request.body);
        if (!parsed.success)
          return reply.code(400).send({ error: 'Invalid request' });
        const { userId, enabled, startTime, endTime, timezone } = parsed.data;
        const update = await prisma.user.updateMany({
          where: { id: userId, tenantId: request.tenant.id },
          data: {
            dndEnabled: enabled,
            dndStartTime: startTime,
            dndEndTime: endTime,
            timezone,
          },
        });
        if (!update.count)
          return reply.code(404).send({ error: 'User not found' });
        return { userId, enabled, startTime, endTime, timezone };
      },
    );

    app.get(
      '/v1/preferences/digest',
      { preHandler: app.authenticate },
      async (request, reply) => {
        const parsed = userIdQuery.safeParse(request.query);
        if (!parsed.success)
          return reply.code(400).send({ error: 'Invalid request' });
        const user = await prisma.user.findFirst({
          where: { id: parsed.data.userId, tenantId: request.tenant.id },
          select: { id: true, timezone: true },
        });
        if (!user) return reply.code(404).send({ error: 'User not found' });
        const preference = await prisma.digestPreference.findFirst({
          where: { userId: user.id, user: { tenantId: request.tenant.id } },
        });
        if (preference) return preference;
        const timezone = timezoneSchema.safeParse(user.timezone).success
          ? user.timezone
          : 'UTC';
        return {
          userId: user.id,
          enabled: false,
          frequency: 'DAILY',
          channel: 'EMAIL',
          preferredTime: '09:00',
          timezone,
        };
      },
    );

    app.put(
      '/v1/preferences/digest',
      { preHandler: app.authenticate },
      async (request, reply) => {
        const parsed = digestBody.safeParse(request.body);
        if (!parsed.success)
          return reply.code(400).send({ error: 'Invalid request' });
        const { userId, ...data } = parsed.data;
        if (!(await hasUser(prisma, userId, request.tenant.id)))
          return reply.code(404).send({ error: 'User not found' });
        return prisma.digestPreference.upsert({
          where: { userId },
          create: { userId, ...data },
          update: data,
        });
      },
    );
  };
