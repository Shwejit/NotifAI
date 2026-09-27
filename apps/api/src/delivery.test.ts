import { describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import type { FastifyBaseLogger } from 'fastify';
import type { Job } from 'bullmq';
import { processEmailJob } from './delivery/email-worker.js';
import {
  PermanentEmailError,
  type EmailProvider,
} from './delivery/email-provider.js';
import type { EmailJobPayload } from './delivery/types.js';

function setup(email: string | null = 'learner@example.com') {
  let emailEnabled = true;
  const delivery = {
    id: 'delivery-1',
    notificationId: 'notification-1',
    channel: 'EMAIL' as const,
    status: 'PENDING' as 'PENDING' | 'PROCESSING' | 'DELIVERED' | 'FAILED',
    attempts: 0,
    error: null as string | null,
    lastAttemptAt: null as Date | null,
    deliveredAt: null as Date | null,
    createdAt: new Date(),
    updatedAt: new Date(),
    notification: {
      id: 'notification-1',
      tenantId: 'tenant-1',
      userId: 'user-1',
      category: 'general',
      title: 'Hello',
      body: 'You have an update',
      actionUrl: 'https://example.com/open',
      user: {
        email,
        dndEnabled: false,
        dndStartTime: null as string | null,
        dndEndTime: null as string | null,
        timezone: 'UTC' as string | null,
      },
    },
  };
  const prisma = {
    preference: {
      findFirst: async () => (emailEnabled ? null : { enabled: false }),
    },
    delivery: {
      findUnique: async () => ({
        ...delivery,
        notification: { ...delivery.notification },
      }),
      update: async ({ data }: { data: Record<string, unknown> }) => {
        for (const [key, value] of Object.entries(data)) {
          if (key === 'attempts')
            delivery.attempts += Number(
              (value as { increment: number }).increment,
            );
          else Object.assign(delivery, { [key]: value });
        }
        return delivery;
      },
    },
  } as unknown as PrismaClient;
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  } as unknown as FastifyBaseLogger;
  const job = (attemptsMade = 0) =>
    ({
      data: {
        deliveryId: delivery.id,
        notificationId: delivery.notificationId,
      },
      attemptsMade,
      opts: { attempts: 3 },
    }) as Job<EmailJobPayload>;
  return {
    delivery,
    prisma,
    logger,
    job,
    disableEmail: () => {
      emailEnabled = false;
    },
  };
}

describe('Phase 5 email worker', () => {
  it('marks successful sends delivered and records the attempt', async () => {
    const { delivery, prisma, logger, job } = setup();
    const sendEmail = vi.fn(async () => {});
    await processEmailJob(
      job(),
      prisma,
      { sendEmail },
      logger,
      'notifications@notifai.local',
    );
    expect(sendEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        to: 'learner@example.com',
        subject: 'Hello',
        text: expect.stringContaining('https://example.com/open'),
      }),
    );
    expect(delivery).toMatchObject({
      status: 'DELIVERED',
      attempts: 1,
      error: null,
    });
    expect(delivery.deliveredAt).toBeInstanceOf(Date);
    expect(delivery.lastAttemptAt).toBeInstanceOf(Date);
  });

  it('rechecks preferences before sending an already queued job', async () => {
    const { delivery, prisma, logger, job, disableEmail } = setup();
    disableEmail();
    const sendEmail = vi.fn(async () => {});
    await processEmailJob(
      job(),
      prisma,
      { sendEmail },
      logger,
      'notifications@notifai.local',
    );
    expect(sendEmail).not.toHaveBeenCalled();
    expect(delivery).toMatchObject({
      status: 'SUPPRESSED',
      error: 'Email disabled by user preference',
      attempts: 0,
    });
  });

  it('does not send while the user is in an active timezone-aware DND window', async () => {
    const { delivery, prisma, logger, job } = setup();
    const user = delivery.notification.user;
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
    user.dndEnabled = true;
    user.dndStartTime = format(total - 5);
    user.dndEndTime = format(total + 5);
    user.timezone = 'Asia/Kolkata';
    const sendEmail = vi.fn(async () => {});
    await processEmailJob(
      job(),
      prisma,
      { sendEmail },
      logger,
      'notifications@notifai.local',
    );
    expect(sendEmail).not.toHaveBeenCalled();
    expect(delivery.status).toBe('SUPPRESSED');
  });

  it('does not send again when PostgreSQL already records delivery success', async () => {
    const { delivery, prisma, logger, job } = setup();
    delivery.status = 'DELIVERED';
    const sendEmail = vi.fn(async () => {});
    await processEmailJob(
      job(),
      prisma,
      { sendEmail },
      logger,
      'notifications@notifai.local',
    );
    expect(sendEmail).not.toHaveBeenCalled();
    expect(delivery.attempts).toBe(0);
  });

  it('retries temporary provider errors then records final failure', async () => {
    const { delivery, prisma, logger, job } = setup();
    const provider: EmailProvider = {
      sendEmail: async () => {
        throw new Error('Temporary provider error');
      },
    };
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await expect(
        processEmailJob(
          job(attempt),
          prisma,
          provider,
          logger,
          'notifications@notifai.local',
        ),
      ).rejects.toThrow('Temporary provider error');
    }
    expect(delivery).toMatchObject({
      status: 'FAILED',
      attempts: 3,
      error: 'Temporary provider error',
    });
  });

  it('does not retry permanent provider errors', async () => {
    const { delivery, prisma, logger, job } = setup();
    const provider: EmailProvider = {
      sendEmail: async () => {
        throw new PermanentEmailError('Invalid recipient');
      },
    };
    await expect(
      processEmailJob(
        job(),
        prisma,
        provider,
        logger,
        'notifications@notifai.local',
      ),
    ).rejects.toThrow('Invalid recipient');
    expect(delivery).toMatchObject({
      status: 'FAILED',
      attempts: 1,
      error: 'Invalid recipient',
    });
  });

  it('records missing email as permanent and skips the provider', async () => {
    const { delivery, prisma, logger, job } = setup(null);
    const sendEmail = vi.fn(async () => {});
    await expect(
      processEmailJob(
        job(),
        prisma,
        { sendEmail },
        logger,
        'notifications@notifai.local',
      ),
    ).rejects.toThrow('User email is missing');
    expect(sendEmail).not.toHaveBeenCalled();
    expect(delivery).toMatchObject({
      status: 'FAILED',
      error: 'User email is missing',
    });
  });
});
