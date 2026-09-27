import { afterEach, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { buildApp } from './app.js';
import { createApiKey } from './modules/api-keys.js';
import { getUserChannel } from './realtime/channels.js';
import type {
  RealtimeEvent,
  RealtimeListener,
  RealtimeService,
} from './realtime/events.js';
import type { EmailJobPayload, EmailQueueService } from './delivery/types.js';

type TestUser = {
  id: string;
  tenantId: string;
  externalId: string;
  email: string | null;
  name: string | null;
  timezone: string | null;
  dndEnabled: boolean;
  dndStartTime: string | null;
  dndEndTime: string | null;
  createdAt: Date;
  updatedAt: Date;
};
type TestDelivery = {
  id: string;
  notificationId: string;
  channel: 'EMAIL';
  status: 'PENDING' | 'PROCESSING' | 'DELIVERED' | 'FAILED' | 'SUPPRESSED';
  attempts: number;
  error: string | null;
  lastAttemptAt: Date | null;
  deliveredAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};
type TestNotification = {
  id: string;
  tenantId: string;
  userId: string;
  title: string;
  body: string;
  category: string | null;
  actionUrl: string | null;
  priority: 'URGENT' | 'IMPORTANT' | 'LOW';
  idempotencyKey: string | null;
  createdAt: Date;
  updatedAt: Date;
  readAt: Date | null;
  archivedAt: Date | null;
  scheduledAt: Date | null;
};

const tenantA = {
  id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  name: 'Tenant A',
  slug: 'tenant-a',
  createdAt: new Date(),
  updatedAt: new Date(),
};
const tenantB = {
  id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  name: 'Tenant B',
  slug: 'tenant-b',
  createdAt: new Date(),
  updatedAt: new Date(),
};
let idCounter = 0;

function nextId(): string {
  idCounter += 1;
  return `00000000-0000-4000-8000-${String(idCounter).padStart(12, '0')}`;
}

function matchesNotification(
  notification: TestNotification,
  where: Record<string, unknown>,
): boolean {
  for (const field of ['id', 'tenantId', 'userId', 'idempotencyKey'] as const) {
    const expected = where[field];
    if (expected !== undefined && notification[field] !== expected)
      return false;
  }
  if (where.archivedAt === null && notification.archivedAt !== null)
    return false;
  if (where.readAt === null && notification.readAt !== null) return false;
  if (
    typeof where.readAt === 'object' &&
    where.readAt !== null &&
    'not' in where.readAt &&
    notification.readAt === null
  ) {
    return false;
  }
  if (
    where.category !== undefined &&
    notification.category !== where.category
  ) {
    return false;
  }
  if (Array.isArray(where.OR)) {
    const afterCursor = where.OR.some((rawCondition: unknown) => {
      if (typeof rawCondition !== 'object' || rawCondition === null)
        return false;
      const condition = rawCondition as Record<string, unknown>;
      const createdAt = condition.createdAt;
      if (createdAt instanceof Date) {
        if (notification.createdAt.getTime() !== createdAt.getTime())
          return false;
      } else if (
        typeof createdAt === 'object' &&
        createdAt !== null &&
        'lt' in createdAt
      ) {
        const before = (createdAt as { lt: Date }).lt;
        if (notification.createdAt.getTime() >= before.getTime()) return false;
      }
      const idFilter = condition.id;
      if (
        typeof idFilter === 'object' &&
        idFilter !== null &&
        'lt' in idFilter
      ) {
        if (notification.id >= (idFilter as { lt: string }).lt) return false;
      }
      return true;
    });
    if (!afterCursor) return false;
  }
  return true;
}

class FakeRealtime implements RealtimeService {
  events: RealtimeEvent[] = [];
  listeners = new Map<string, Set<RealtimeListener>>();
  failPublish = false;
  async publish(event: RealtimeEvent): Promise<void> {
    if (this.failPublish) throw new Error('Redis unavailable');
    this.events.push(event);
    const channel = getUserChannel(event.tenantId, event.userId);
    for (const listener of this.listeners.get(channel) ?? []) listener(event);
  }
  async subscribe(
    tenantId: string,
    userId: string,
    listener: RealtimeListener,
  ): Promise<() => void> {
    const channel = getUserChannel(tenantId, userId);
    let listeners = this.listeners.get(channel);
    if (!listeners) {
      listeners = new Set();
      this.listeners.set(channel, listeners);
    }
    listeners.add(listener);
    return () => {
      listeners?.delete(listener);
      if (!listeners?.size) this.listeners.delete(channel);
    };
  }
  async close(): Promise<void> {
    this.listeners.clear();
  }
}

class FakeEmailQueue implements EmailQueueService {
  jobs: EmailJobPayload[] = [];
  fail = false;
  async enqueue(payload: EmailJobPayload): Promise<void> {
    if (this.fail) throw new Error('Queue unavailable');
    this.jobs.push(payload);
  }
  async close(): Promise<void> {}
}

function makePrisma() {
  idCounter = 0;
  const users: TestUser[] = [];
  const notifications: TestNotification[] = [];
  const deliveries: TestDelivery[] = [];
  const preferences: Array<{
    id: string;
    userId: string;
    category: string;
    channel: string;
    enabled: boolean;
  }> = [];
  const digests: Array<{
    id: string;
    userId: string;
    enabled: boolean;
    frequency: string;
    channel: string;
    preferredTime: string;
    timezone: string;
  }> = [];
  const keyA = createApiKey();
  const keyB = createApiKey();
  const apiKeys = new Map([
    [
      keyA.keyHash,
      { id: 'key-a', tenant: tenantA, revokedAt: null, expiresAt: null },
    ],
    [
      keyB.keyHash,
      { id: 'key-b', tenant: tenantB, revokedAt: null, expiresAt: null },
    ],
  ]);
  let sequence = 0;
  const fake = {
    apiKey: {
      findUnique: async ({ where }: { where: { keyHash: string } }) =>
        apiKeys.get(where.keyHash),
      update: async () => undefined,
    },
    user: {
      findFirst: async ({ where }: { where: Record<string, string> }) =>
        users.find((user) =>
          Object.entries(where).every(
            ([field, value]) => user[field as keyof TestUser] === value,
          ),
        ) ?? null,
      create: async ({ data }: { data: Record<string, unknown> }) => {
        if (
          users.some(
            (user) =>
              user.tenantId === data.tenantId &&
              user.externalId === data.externalId,
          )
        ) {
          throw Object.assign(new Error('Unique constraint'), {
            code: 'P2002',
          });
        }
        const now = new Date(Date.now() + sequence++);
        const user: TestUser = {
          id: nextId(),
          tenantId: String(data.tenantId),
          externalId: String(data.externalId),
          email: typeof data.email === 'string' ? data.email : null,
          name: typeof data.name === 'string' ? data.name : null,
          timezone: typeof data.timezone === 'string' ? data.timezone : null,
          dndEnabled: false,
          dndStartTime: null,
          dndEndTime: null,
          createdAt: now,
          updatedAt: now,
        };
        users.push(user);
        return user;
      },
      updateMany: async ({
        where,
        data,
      }: {
        where: Record<string, string>;
        data: Record<string, unknown>;
      }) => {
        const user = users.find(
          (item) => item.id === where.id && item.tenantId === where.tenantId,
        );
        if (user) Object.assign(user, data);
        return { count: user ? 1 : 0 };
      },
    },
    preference: {
      findFirst: async ({ where }: { where: Record<string, unknown> }) =>
        preferences.find(
          (item) =>
            item.userId === where.userId &&
            item.category === where.category &&
            item.channel === where.channel,
        ) ?? null,
      findMany: async ({ where }: { where: Record<string, unknown> }) =>
        preferences.filter((item) => item.userId === where.userId),
      upsert: async ({
        where,
        create,
        update,
      }: {
        where: {
          userId_category_channel: {
            userId: string;
            category: string;
            channel: string;
          };
        };
        create: Record<string, unknown>;
        update: Record<string, unknown>;
      }) => {
        let item = preferences.find(
          (row) =>
            row.userId === where.userId_category_channel.userId &&
            row.category === where.userId_category_channel.category &&
            row.channel === where.userId_category_channel.channel,
        );
        if (item) Object.assign(item, update);
        else {
          item = {
            id: nextId(),
            userId: String(create.userId),
            category: String(create.category),
            channel: String(create.channel),
            enabled: Boolean(create.enabled),
          };
          preferences.push(item);
        }
        return item;
      },
    },
    digestPreference: {
      findFirst: async ({ where }: { where: { userId: string } }) =>
        digests.find((item) => item.userId === where.userId) ?? null,
      upsert: async ({
        where,
        create,
        update,
      }: {
        where: { userId: string };
        create: Record<string, unknown>;
        update: Record<string, unknown>;
      }) => {
        let item = digests.find((row) => row.userId === where.userId);
        if (item) Object.assign(item, update);
        else {
          item = {
            id: nextId(),
            userId: where.userId,
            enabled: Boolean(create.enabled),
            frequency: String(create.frequency),
            channel: String(create.channel),
            preferredTime: String(create.preferredTime),
            timezone: String(create.timezone),
          };
          digests.push(item);
        }
        return item;
      },
    },
    notification: {
      findFirst: async ({ where }: { where: Record<string, unknown> }) =>
        notifications.find((item) => matchesNotification(item, where)) ?? null,
      findMany: async ({
        where,
        take,
      }: {
        where: Record<string, unknown>;
        orderBy: unknown;
        take: number;
      }) =>
        notifications
          .filter((item) => matchesNotification(item, where))
          .sort(
            (a, b) =>
              b.createdAt.getTime() - a.createdAt.getTime() ||
              b.id.localeCompare(a.id),
          )
          .slice(0, take),
      count: async ({ where }: { where: Record<string, unknown> }) =>
        notifications.filter((item) => matchesNotification(item, where)).length,
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const idempotencyKey =
          typeof data.idempotencyKey === 'string' ? data.idempotencyKey : null;
        if (
          idempotencyKey &&
          notifications.some(
            (item) =>
              item.tenantId === data.tenantId &&
              item.idempotencyKey === idempotencyKey,
          )
        ) {
          throw Object.assign(new Error('Unique constraint'), {
            code: 'P2002',
          });
        }
        const now = new Date(Date.now() + sequence++);
        const notification: TestNotification = {
          id: nextId(),
          tenantId: String(data.tenantId),
          userId: String(data.userId),
          title: String(data.title),
          body: String(data.body),
          category: typeof data.category === 'string' ? data.category : null,
          actionUrl: typeof data.actionUrl === 'string' ? data.actionUrl : null,
          priority:
            (data.priority as TestNotification['priority'] | undefined) ??
            'IMPORTANT',
          idempotencyKey,
          createdAt: now,
          updatedAt: now,
          readAt: null,
          archivedAt: null,
          scheduledAt: null,
        };
        notifications.push(notification);
        const nested = data.deliveries as
          { create: Record<string, unknown> } | undefined;
        const delivery: TestDelivery = {
          id: nextId(),
          notificationId: notification.id,
          channel: 'EMAIL',
          status:
            (nested?.create.status as TestDelivery['status']) ?? 'PENDING',
          attempts: 0,
          error:
            typeof nested?.create.error === 'string'
              ? nested.create.error
              : null,
          lastAttemptAt: null,
          deliveredAt: null,
          createdAt: now,
          updatedAt: now,
        };
        deliveries.push(delivery);
        return { ...notification, deliveries: [delivery] };
      },
      updateMany: async ({
        where,
        data,
      }: {
        where: Record<string, unknown>;
        data: Record<string, unknown>;
      }) => {
        const matches = notifications.filter((item) =>
          matchesNotification(item, where),
        );
        for (const item of matches)
          Object.assign(item, data, { updatedAt: new Date() });
        return { count: matches.length };
      },
    },
    delivery: {
      findUnique: async ({ where }: { where: { id: string } }) =>
        deliveries.find((item) => item.id === where.id) ?? null,
      findFirst: async ({
        where,
      }: {
        where: { id: string; notification?: { tenantId: string } };
      }) => {
        const item = deliveries.find((candidate) => candidate.id === where.id);
        const notification = notifications.find(
          (candidate) => candidate.id === item?.notificationId,
        );
        return item &&
          (!where.notification ||
            notification?.tenantId === where.notification.tenantId)
          ? item
          : null;
      },
      update: async ({
        where,
        data,
      }: {
        where: { id: string };
        data: Record<string, unknown>;
      }) => {
        const item = deliveries.find((candidate) => candidate.id === where.id);
        if (!item) throw new Error('Delivery not found');
        for (const [key, value] of Object.entries(data)) {
          if (
            key === 'attempts' &&
            typeof value === 'object' &&
            value !== null &&
            'increment' in value
          )
            item.attempts += Number((value as { increment: number }).increment);
          else Object.assign(item, { [key]: value });
        }
        item.updatedAt = new Date();
        return item;
      },
    },
  } as unknown as PrismaClient;

  return {
    prisma: fake,
    secrets: { [tenantA.id]: keyA.secret, [tenantB.id]: keyB.secret } as Record<
      string,
      string
    >,
    users,
    notifications,
    deliveries,
  };
}

const userBody = (externalId: string) => ({
  externalId,
  email: `${externalId}@example.com`,
  name: 'Test User',
  timezone: 'Asia/Kolkata',
});
const notificationBody = (
  externalUserId: string,
  extra: Record<string, unknown> = {},
) => ({
  externalUserId,
  title: 'Payment received',
  body: 'Your payment succeeded.',
  category: 'payment',
  priority: 'IMPORTANT',
  ...extra,
});

async function addUser(
  app: ReturnType<typeof buildApp>,
  secret: string,
  externalId: string,
) {
  return app.inject({
    method: 'POST',
    url: '/v1/users',
    headers: { authorization: `Bearer ${secret}` },
    payload: userBody(externalId),
  });
}

async function addNotification(
  app: ReturnType<typeof buildApp>,
  secret: string,
  externalUserId: string,
  extra: Record<string, unknown> = {},
) {
  return app.inject({
    method: 'POST',
    url: '/v1/notifications',
    headers: { authorization: `Bearer ${secret}` },
    payload: notificationBody(externalUserId, extra),
  });
}

const openApps: Array<ReturnType<typeof buildApp>> = [];
afterEach(async () => {
  await Promise.all(openApps.splice(0).map((app) => app.close()));
});
function newApp() {
  const fixture = makePrisma();
  const realtime = new FakeRealtime();
  const emailQueue = new FakeEmailQueue();
  const app = buildApp(fixture.prisma, realtime, emailQueue);
  openApps.push(app);
  return { ...fixture, app, realtime, emailQueue };
}

const auth = (secret: string) => ({ authorization: `Bearer ${secret}` });

describe('Phase 3 users and notifications', () => {
  it('creates a user in the authenticated tenant', async () => {
    const { app, secrets } = newApp();
    const response = await addUser(app, secrets[tenantA.id]!, 'user-123');
    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({
      tenantId: tenantA.id,
      externalId: 'user-123',
    });
  });

  it('rejects invalid user input and client-supplied tenantId', async () => {
    const { app, secrets } = newApp();
    const badEmail = await app.inject({
      method: 'POST',
      url: '/v1/users',
      headers: auth(secrets[tenantA.id]!),
      payload: { ...userBody('u'), email: 'invalid' },
    });
    const suppliedTenant = await app.inject({
      method: 'POST',
      url: '/v1/users',
      headers: auth(secrets[tenantA.id]!),
      payload: { ...userBody('u2'), tenantId: tenantB.id },
    });
    expect(badEmail.statusCode).toBe(400);
    expect(suppliedTenant.statusCode).toBe(400);
  });

  it('returns 409 for a duplicate externalId in one tenant', async () => {
    const { app, secrets } = newApp();
    expect((await addUser(app, secrets[tenantA.id]!, 'same')).statusCode).toBe(
      201,
    );
    expect((await addUser(app, secrets[tenantA.id]!, 'same')).statusCode).toBe(
      409,
    );
  });

  it('allows the same externalId in different tenants', async () => {
    const { app, secrets } = newApp();
    expect((await addUser(app, secrets[tenantA.id]!, 'same')).statusCode).toBe(
      201,
    );
    const response = await addUser(app, secrets[tenantB.id]!, 'same');
    expect(response.statusCode).toBe(201);
    expect(response.json().tenantId).toBe(tenantB.id);
  });

  it('creates and retrieves tenant-scoped notifications', async () => {
    const { app, secrets } = newApp();
    await addUser(app, secrets[tenantA.id]!, 'user-123');
    const created = await addNotification(
      app,
      secrets[tenantA.id]!,
      'user-123',
    );
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({
      title: 'Payment received',
      tenantId: tenantA.id,
    });
    const fetched = await app.inject({
      method: 'GET',
      url: `/v1/notifications/${created.json().id}`,
      headers: auth(secrets[tenantA.id]!),
    });
    expect(fetched.statusCode).toBe(200);
    expect(fetched.json().id).toBe(created.json().id);
  });

  it('returns 404 for an unknown user and for another tenant notification', async () => {
    const { app, secrets } = newApp();
    expect(
      (await addNotification(app, secrets[tenantA.id]!, 'missing')).statusCode,
    ).toBe(404);
    await addUser(app, secrets[tenantA.id]!, 'user-123');
    const created = await addNotification(
      app,
      secrets[tenantA.id]!,
      'user-123',
    );
    const response = await app.inject({
      method: 'GET',
      url: `/v1/notifications/${created.json().id}`,
      headers: auth(secrets[tenantB.id]!),
    });
    expect(response.statusCode).toBe(404);
  });

  it('requires authentication for user and notification writes', async () => {
    const { app } = newApp();
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/v1/users',
          payload: userBody('u'),
        })
      ).statusCode,
    ).toBe(401);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/v1/notifications',
          headers: auth('invalid'),
          payload: notificationBody('u'),
        })
      ).statusCode,
    ).toBe(401);
  });

  it('returns inbox newest first and filters unread, read, and category', async () => {
    const { app, secrets } = newApp();
    const secret = secrets[tenantA.id]!;
    const user = await addUser(app, secret, 'user-123');
    const userId = user.json().id as string;
    const older = await addNotification(app, secret, 'user-123', {
      title: 'Older',
      category: 'comment',
    });
    const newer = await addNotification(app, secret, 'user-123', {
      title: 'Newer',
      category: 'payment',
    });
    const base = `/v1/inbox?userId=${userId}`;
    const all = await app.inject({
      method: 'GET',
      url: base,
      headers: auth(secret),
    });
    expect(all.json().items.map((item: TestNotification) => item.id)).toEqual([
      newer.json().id,
      older.json().id,
    ]);
    await app.inject({
      method: 'PATCH',
      url: `/v1/inbox/${older.json().id}/read`,
      headers: auth(secret),
    });
    const unread = await app.inject({
      method: 'GET',
      url: `${base}&status=unread`,
      headers: auth(secret),
    });
    const read = await app.inject({
      method: 'GET',
      url: `${base}&status=read&category=comment`,
      headers: auth(secret),
    });
    expect(
      unread.json().items.map((item: TestNotification) => item.id),
    ).toEqual([newer.json().id]);
    expect(read.json().items.map((item: TestNotification) => item.id)).toEqual([
      older.json().id,
    ]);
  });

  it('marks a notification read, then unread', async () => {
    const { app, secrets } = newApp();
    await addUser(app, secrets[tenantA.id]!, 'user-123');
    const created = await addNotification(
      app,
      secrets[tenantA.id]!,
      'user-123',
    );
    const read = await app.inject({
      method: 'PATCH',
      url: `/v1/inbox/${created.json().id}/read`,
      headers: auth(secrets[tenantA.id]!),
    });
    expect(read.json().readAt).toBeTruthy();
    const unread = await app.inject({
      method: 'PATCH',
      url: `/v1/inbox/${created.json().id}/unread`,
      headers: auth(secrets[tenantA.id]!),
    });
    expect(unread.json().readAt).toBeNull();
  });

  it('read-all updates only active unread notifications and archive hides an item', async () => {
    const { app, secrets } = newApp();
    const secret = secrets[tenantA.id]!;
    const user = await addUser(app, secret, 'user-123');
    const first = await addNotification(app, secret, 'user-123');
    const second = await addNotification(app, secret, 'user-123');
    const archived = await app.inject({
      method: 'PATCH',
      url: `/v1/inbox/${second.json().id}/archive`,
      headers: auth(secret),
    });
    expect(archived.json().archivedAt).toBeTruthy();
    const readAll = await app.inject({
      method: 'POST',
      url: '/v1/inbox/read-all',
      headers: auth(secret),
      payload: { userId: user.json().id },
    });
    expect(readAll.json().updated).toBe(1);
    const unreadCount = await app.inject({
      method: 'GET',
      url: `/v1/inbox/unread-count?userId=${user.json().id}`,
      headers: auth(secret),
    });
    expect(unreadCount.json().count).toBe(0);
    const inbox = await app.inject({
      method: 'GET',
      url: `/v1/inbox?userId=${user.json().id}`,
      headers: auth(secret),
    });
    expect(inbox.json().items).toHaveLength(1);
    expect(inbox.json().items[0].id).toBe(first.json().id);
  });

  it('counts only non-archived unread notifications', async () => {
    const { app, secrets } = newApp();
    const secret = secrets[tenantA.id]!;
    const user = await addUser(app, secret, 'user-123');
    const read = await addNotification(app, secret, 'user-123');
    const unread = await addNotification(app, secret, 'user-123');
    await app.inject({
      method: 'PATCH',
      url: `/v1/inbox/${read.json().id}/read`,
      headers: auth(secret),
    });
    const count = await app.inject({
      method: 'GET',
      url: `/v1/inbox/unread-count?userId=${user.json().id}`,
      headers: auth(secret),
    });
    expect(count.json().count).toBe(1);
    await app.inject({
      method: 'PATCH',
      url: `/v1/inbox/${unread.json().id}/archive`,
      headers: auth(secret),
    });
    const afterArchive = await app.inject({
      method: 'GET',
      url: `/v1/inbox/unread-count?userId=${user.json().id}`,
      headers: auth(secret),
    });
    expect(afterArchive.json().count).toBe(0);
  });

  it('rejects malformed cursor, limit, and cross-tenant user queries', async () => {
    const { app, secrets } = newApp();
    const user = await addUser(app, secrets[tenantB.id]!, 'user-b');
    expect(
      (
        await app.inject({
          method: 'GET',
          url: `/v1/inbox?userId=${user.json().id}`,
          headers: auth(secrets[tenantA.id]!),
        })
      ).statusCode,
    ).toBe(404);
    const own = await addUser(app, secrets[tenantA.id]!, 'user-a');
    expect(
      (
        await app.inject({
          method: 'GET',
          url: `/v1/inbox?userId=${own.json().id}&limit=51`,
          headers: auth(secrets[tenantA.id]!),
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          method: 'GET',
          url: `/v1/inbox?userId=${own.json().id}&cursor=not-a-cursor`,
          headers: auth(secrets[tenantA.id]!),
        })
      ).statusCode,
    ).toBe(400);
  });

  it('paginates without duplicates or skipped notifications', async () => {
    const { app, secrets } = newApp();
    const secret = secrets[tenantA.id]!;
    const user = await addUser(app, secret, 'user-123');
    for (let index = 0; index < 5; index += 1) {
      await addNotification(app, secret, 'user-123', {
        title: `Notification ${index}`,
      });
    }
    const ids: string[] = [];
    let cursor: string | null = null;
    do {
      const query = new URLSearchParams({ userId: user.json().id, limit: '2' });
      if (cursor) query.set('cursor', cursor);
      const page = await app.inject({
        method: 'GET',
        url: `/v1/inbox?${query.toString()}`,
        headers: auth(secret),
      });
      ids.push(...page.json().items.map((item: TestNotification) => item.id));
      cursor = page.json().nextCursor;
    } while (cursor);
    expect(ids).toHaveLength(5);
    expect(new Set(ids).size).toBe(5);
    expect(cursor).toBeNull();
  });

  it('returns the existing notification for repeated idempotency keys', async () => {
    const { app, secrets, notifications } = newApp();
    await addUser(app, secrets[tenantA.id]!, 'user-123');
    const first = await addNotification(app, secrets[tenantA.id]!, 'user-123', {
      idempotencyKey: 'payment-123',
    });
    const retry = await addNotification(app, secrets[tenantA.id]!, 'user-123', {
      idempotencyKey: 'payment-123',
      title: 'Retry payload',
    });
    expect(first.statusCode).toBe(201);
    expect(retry.statusCode).toBe(200);
    expect(retry.json().id).toBe(first.json().id);
    expect(notifications).toHaveLength(1);
  });

  it('scopes identical idempotency keys to each tenant', async () => {
    const { app, secrets, notifications } = newApp();
    await addUser(app, secrets[tenantA.id]!, 'user-123');
    await addUser(app, secrets[tenantB.id]!, 'user-123');
    const first = await addNotification(app, secrets[tenantA.id]!, 'user-123', {
      idempotencyKey: 'same-key',
    });
    const second = await addNotification(
      app,
      secrets[tenantB.id]!,
      'user-123',
      {
        idempotencyKey: 'same-key',
      },
    );
    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(201);
    expect(first.json().id).not.toBe(second.json().id);
    expect(notifications).toHaveLength(2);
  });

  it('handles concurrent retries through the database uniqueness conflict path', async () => {
    const { app, secrets, notifications } = newApp();
    await addUser(app, secrets[tenantA.id]!, 'user-123');
    const payload = notificationBody('user-123', {
      idempotencyKey: 'concurrent-key',
    });
    const send = () =>
      app.inject({
        method: 'POST',
        url: '/v1/notifications',
        headers: auth(secrets[tenantA.id]!),
        payload,
      });
    const [first, second] = await Promise.all([send(), send()]);
    expect([first.statusCode, second.statusCode].sort()).toEqual([200, 201]);
    expect(first.json().id).toBe(second.json().id);
    expect(notifications).toHaveLength(1);
  });
});

describe('Phase 4 realtime events and SSE', () => {
  it('publishes create and inbox state events to tenant/user channels', async () => {
    const { app, secrets, realtime } = newApp();
    const secret = secrets[tenantA.id]!;
    const user = await addUser(app, secret, 'user-123');
    const created = await addNotification(app, secret, 'user-123');
    const id = created.json().id as string;
    await app.inject({
      method: 'PATCH',
      url: `/v1/inbox/${id}/read`,
      headers: auth(secret),
    });
    await app.inject({
      method: 'PATCH',
      url: `/v1/inbox/${id}/unread`,
      headers: auth(secret),
    });
    await app.inject({
      method: 'PATCH',
      url: `/v1/inbox/${id}/archive`,
      headers: auth(secret),
    });
    await app.inject({
      method: 'POST',
      url: '/v1/inbox/read-all',
      headers: auth(secret),
      payload: { userId: user.json().id },
    });
    expect(realtime.events.map((event) => event.type)).toEqual([
      'notification.created',
      'notification.read',
      'notification.unread',
      'notification.archived',
      'notification.read_all',
    ]);
    expect(
      getUserChannel(realtime.events[0]!.tenantId, realtime.events[0]!.userId),
    ).toBe(`notifai:${tenantA.id}:user:${user.json().id}`);
    expect(realtime.events[0]!.data?.notification?.title).toBe(
      'Payment received',
    );
    expect(realtime.events[4]!.data?.updatedCount).toBe(0);
  });

  it('keeps a successful notification write when Redis publishing fails', async () => {
    const { app, secrets, notifications, realtime } = newApp();
    await addUser(app, secrets[tenantA.id]!, 'user-123');
    realtime.failPublish = true;
    const response = await addNotification(
      app,
      secrets[tenantA.id]!,
      'user-123',
    );
    expect(response.statusCode).toBe(201);
    expect(notifications).toHaveLength(1);
  });

  it('rejects unauthenticated and cross-tenant SSE requests', async () => {
    const { app, secrets } = newApp();
    const foreignUser = await addUser(app, secrets[tenantB.id]!, 'user-b');
    const missingAuth = await app.inject({
      method: 'GET',
      url: `/v1/inbox/stream?userId=${foreignUser.json().id}`,
    });
    const foreign = await app.inject({
      method: 'GET',
      url: `/v1/inbox/stream?userId=${foreignUser.json().id}`,
      headers: auth(secrets[tenantA.id]!),
    });
    expect(missingAuth.statusCode).toBe(401);
    expect(foreign.statusCode).toBe(404);
  });

  it('routes events only to the matching tenant and user subscription', async () => {
    const { realtime } = newApp();
    const received: RealtimeEvent[] = [];
    const stop = await realtime.subscribe(tenantA.id, 'user-a', (event) =>
      received.push(event),
    );
    await realtime.publish({
      type: 'notification.created',
      tenantId: tenantB.id,
      userId: 'user-b',
      timestamp: new Date().toISOString(),
    });
    expect(received).toHaveLength(0);
    await realtime.publish({
      type: 'notification.created',
      tenantId: tenantA.id,
      userId: 'user-a',
      timestamp: new Date().toISOString(),
    });
    expect(received).toHaveLength(1);
    stop();
    expect(realtime.listeners.size).toBe(0);
  });
});

describe('Phase 4 SSE streaming', () => {
  it('streams created events and cleans its subscription after disconnect', async () => {
    const { app, secrets, realtime } = newApp();
    const secret = secrets[tenantA.id]!;
    const user = await addUser(app, secret, 'stream-user');
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    const controller = new AbortController();
    const response = await fetch(
      address + '/v1/inbox/stream?userId=' + user.json().id,
      {
        headers: auth(secret),
        signal: controller.signal,
      },
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    const reader = response.body!.getReader();
    await reader.read();
    const nextFrame = reader.read();
    await addNotification(app, secret, 'stream-user');
    const frame = await Promise.race([
      nextFrame,
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 2_000)),
    ]);
    expect(frame).not.toBeNull();
    expect(new TextDecoder().decode(frame!.value)).toContain(
      'event: notification.created',
    );
    controller.abort();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(realtime.listeners.size).toBe(0);
  });
});

describe('Phase 5 email delivery API', () => {
  it('creates one pending EMAIL delivery and queues only identifiers', async () => {
    const { app, secrets, deliveries, emailQueue } = newApp();
    await addUser(app, secrets[tenantA.id]!, 'email-user');
    const response = await addNotification(
      app,
      secrets[tenantA.id]!,
      'email-user',
    );
    expect(response.statusCode).toBe(201);
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]).toMatchObject({
      channel: 'EMAIL',
      status: 'PENDING',
      attempts: 0,
    });
    expect(emailQueue.jobs).toEqual([
      {
        deliveryId: deliveries[0]!.id,
        notificationId: response.json().id,
      },
    ]);
    expect(Object.keys(emailQueue.jobs[0]!).sort()).toEqual([
      'deliveryId',
      'notificationId',
    ]);
  });

  it('does not duplicate deliveries or jobs for an idempotent retry', async () => {
    const { app, secrets, deliveries, emailQueue } = newApp();
    await addUser(app, secrets[tenantA.id]!, 'email-user');
    const first = await addNotification(
      app,
      secrets[tenantA.id]!,
      'email-user',
      { idempotencyKey: 'email-once' },
    );
    const retry = await addNotification(
      app,
      secrets[tenantA.id]!,
      'email-user',
      { idempotencyKey: 'email-once' },
    );
    expect(first.json().id).toBe(retry.json().id);
    expect(deliveries).toHaveLength(1);
    expect(emailQueue.jobs).toHaveLength(1);
  });

  it('records missing email without enqueueing or failing the notification', async () => {
    const { app, secrets, deliveries, emailQueue } = newApp();
    await app.inject({
      method: 'POST',
      url: '/v1/users',
      headers: auth(secrets[tenantA.id]!),
      payload: { externalId: 'no-email' },
    });
    const response = await addNotification(
      app,
      secrets[tenantA.id]!,
      'no-email',
    );
    expect(response.statusCode).toBe(201);
    expect(deliveries[0]).toMatchObject({
      status: 'FAILED',
      error: 'User email is missing',
    });
    expect(emailQueue.jobs).toHaveLength(0);
  });

  it('keeps notification success and records a queue failure', async () => {
    const { app, secrets, deliveries, emailQueue } = newApp();
    await addUser(app, secrets[tenantA.id]!, 'email-user');
    emailQueue.fail = true;
    const response = await addNotification(
      app,
      secrets[tenantA.id]!,
      'email-user',
    );
    expect(response.statusCode).toBe(201);
    expect(deliveries[0]).toMatchObject({
      status: 'FAILED',
      error: 'Unable to enqueue email delivery',
    });
  });

  it('exposes delivery status only within the API key tenant', async () => {
    const { app, secrets, deliveries } = newApp();
    await addUser(app, secrets[tenantA.id]!, 'email-a');
    await addUser(app, secrets[tenantB.id]!, 'email-b');
    await addNotification(app, secrets[tenantA.id]!, 'email-a');
    await addNotification(app, secrets[tenantB.id]!, 'email-b');
    const ownId = deliveries[0]!.id;
    const foreignId = deliveries[1]!.id;
    const own = await app.inject({
      method: 'GET',
      url: '/v1/deliveries/' + ownId,
      headers: auth(secrets[tenantA.id]!),
    });
    const foreign = await app.inject({
      method: 'GET',
      url: '/v1/deliveries/' + foreignId,
      headers: auth(secrets[tenantA.id]!),
    });
    expect(own.statusCode).toBe(200);
    expect(own.json().id).toBe(ownId);
    expect(foreign.statusCode).toBe(404);
  });

  describe('Phase 6 preferences, DND, and digest foundation', () => {
    it('stores tenant-scoped category preferences and returns defaults', async () => {
      const { app, secrets } = newApp();
      const user = await addUser(app, secrets[tenantA.id]!, 'pref-user');
      const userId = user.json().id as string;
      const saved = await app.inject({
        method: 'PUT',
        url: '/v1/preferences',
        headers: auth(secrets[tenantA.id]!),
        payload: {
          userId,
          category: 'marketing',
          channel: 'EMAIL',
          enabled: false,
        },
      });
      expect(saved.statusCode).toBe(200);
      const listed = await app.inject({
        method: 'GET',
        url: `/v1/preferences?userId=${userId}`,
        headers: auth(secrets[tenantA.id]!),
      });
      expect(listed.json()).toMatchObject({
        defaults: { EMAIL: true, IN_APP: true },
        items: [{ category: 'marketing', channel: 'EMAIL', enabled: false }],
      });
      const forbidden = await app.inject({
        method: 'GET',
        url: `/v1/preferences?userId=${userId}`,
        headers: auth(secrets[tenantB.id]!),
      });
      expect(forbidden.statusCode).toBe(404);
    });

    it('suppresses email but keeps the notification in the inbox when disabled', async () => {
      const { app, secrets, emailQueue, deliveries } = newApp();
      const user = await addUser(app, secrets[tenantA.id]!, 'marketing-user');
      const userId = user.json().id as string;
      await app.inject({
        method: 'PUT',
        url: '/v1/preferences',
        headers: auth(secrets[tenantA.id]!),
        payload: {
          userId,
          category: 'marketing',
          channel: 'EMAIL',
          enabled: false,
        },
      });
      const created = await addNotification(
        app,
        secrets[tenantA.id]!,
        'marketing-user',
        { category: 'marketing' },
      );
      expect(created.statusCode).toBe(201);
      expect(deliveries[0]).toMatchObject({
        status: 'SUPPRESSED',
        error: 'Email disabled by user preference',
      });
      expect(emailQueue.jobs).toHaveLength(0);
      const inbox = await app.inject({
        method: 'GET',
        url: `/v1/inbox?userId=${userId}`,
        headers: auth(secrets[tenantA.id]!),
      });
      expect(inbox.json().items).toHaveLength(1);
    });

    it('keeps the inbox notification but suppresses email during an active DND window', async () => {
      const { app, secrets, emailQueue, deliveries } = newApp();
      const user = await addUser(app, secrets[tenantA.id]!, 'active-dnd');
      const userId = user.json().id as string;
      const local = new Intl.DateTimeFormat('en-GB', {
        timeZone: 'Asia/Kolkata',
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23',
      }).format(new Date());
      const [hour, minute] = local.split(':').map(Number);
      const total = hour! * 60 + minute!;
      const format = (value: number) =>
        `${String(Math.floor((((value % 1440) + 1440) % 1440) / 60)).padStart(2, '0')}:${String(((value % 1440) + 1440) % 60).padStart(2, '0')}`;
      await app.inject({
        method: 'PUT',
        url: '/v1/preferences/dnd',
        headers: auth(secrets[tenantA.id]!),
        payload: {
          userId,
          enabled: true,
          startTime: format(total - 5),
          endTime: format(total + 5),
          timezone: 'Asia/Kolkata',
        },
      });
      const created = await addNotification(
        app,
        secrets[tenantA.id]!,
        'active-dnd',
      );
      expect(created.statusCode).toBe(201);
      expect(deliveries[0]).toMatchObject({
        status: 'SUPPRESSED',
        error: 'Suppressed by do-not-disturb schedule',
      });
      expect(emailQueue.jobs).toHaveLength(0);
      const inbox = await app.inject({
        method: 'GET',
        url: `/v1/inbox?userId=${userId}`,
        headers: auth(secrets[tenantA.id]!),
      });
      expect(inbox.json().items).toHaveLength(1);
    });

    it('sets DND and digest preferences with validation', async () => {
      const { app, secrets } = newApp();
      const user = await addUser(app, secrets[tenantA.id]!, 'settings-user');
      const userId = user.json().id as string;
      const dnd = await app.inject({
        method: 'PUT',
        url: '/v1/preferences/dnd',
        headers: auth(secrets[tenantA.id]!),
        payload: {
          userId,
          enabled: true,
          startTime: '22:00',
          endTime: '07:00',
          timezone: 'Asia/Kolkata',
        },
      });
      expect(dnd.json()).toMatchObject({
        enabled: true,
        timezone: 'Asia/Kolkata',
      });
      const invalid = await app.inject({
        method: 'PUT',
        url: '/v1/preferences/dnd',
        headers: auth(secrets[tenantA.id]!),
        payload: {
          userId,
          enabled: true,
          startTime: '25:00',
          endTime: '07:00',
          timezone: 'Mars/Olympus',
        },
      });
      expect(invalid.statusCode).toBe(400);
      const digest = await app.inject({
        method: 'PUT',
        url: '/v1/preferences/digest',
        headers: auth(secrets[tenantA.id]!),
        payload: {
          userId,
          enabled: true,
          frequency: 'DAILY',
          channel: 'EMAIL',
          preferredTime: '09:00',
          timezone: 'Asia/Kolkata',
        },
      });
      expect(digest.json()).toMatchObject({
        enabled: true,
        frequency: 'DAILY',
      });
      const fetched = await app.inject({
        method: 'GET',
        url: `/v1/preferences/digest?userId=${userId}`,
        headers: auth(secrets[tenantA.id]!),
      });
      expect(fetched.json().enabled).toBe(true);
    });
  });
});
