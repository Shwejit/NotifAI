import { UnrecoverableError, Worker, type Job } from 'bullmq';
import type { PrismaClient } from '@prisma/client';
import type { FastifyBaseLogger } from 'fastify';
import { Redis } from 'ioredis';
import { EMAIL_JOB_ATTEMPTS, EMAIL_QUEUE_NAME } from '../queues/email.queue.js';
import {
  createEmailMessage,
  PermanentEmailError,
  type EmailProvider,
} from './email-provider.js';
import type { EmailJobPayload } from './types.js';
import {
  isUserInDnd,
  shouldDeliverChannel,
} from '../preferences/preference.service.js';

function errorMessage(error: unknown): string {
  return (
    error instanceof Error ? error.message : 'Email delivery failed'
  ).slice(0, 2_000);
}

export async function processEmailJob(
  job: Job<EmailJobPayload>,
  prisma: PrismaClient,
  provider: EmailProvider,
  logger: FastifyBaseLogger,
  emailFrom: string,
): Promise<void> {
  const delivery = await prisma.delivery.findUnique({
    where: { id: job.data.deliveryId },
    include: { notification: { include: { user: true } } },
  });
  if (!delivery) throw new UnrecoverableError('Delivery record not found');
  if (delivery.notificationId !== job.data.notificationId) {
    throw new UnrecoverableError('Job delivery reference mismatch');
  }
  if (delivery.status === 'DELIVERED') {
    logger.info(
      { deliveryId: delivery.id },
      'Delivery already completed; skipping duplicate job',
    );
    return;
  }
  const recipient = delivery.notification.user.email?.trim();
  const preferenceAllowsEmail = await shouldDeliverChannel(prisma, {
    tenantId: delivery.notification.tenantId,
    userId: delivery.notification.userId,
    category: delivery.notification.category ?? 'default',
    channel: 'EMAIL',
  });
  const suppressedReason = !preferenceAllowsEmail
    ? 'Email disabled by user preference'
    : isUserInDnd(delivery.notification.user)
      ? 'Suppressed by do-not-disturb schedule'
      : null;
  if (suppressedReason) {
    await prisma.delivery.update({
      where: { id: delivery.id },
      data: { status: 'SUPPRESSED', error: suppressedReason },
    });
    logger.info(
      { deliveryId: delivery.id, notificationId: delivery.notificationId },
      'Email delivery suppressed by current user settings',
    );
    return;
  }

  if (!recipient) {
    const message = 'User email is missing';
    await prisma.delivery.update({
      where: { id: delivery.id },
      data: { status: 'FAILED', error: message },
    });
    throw new UnrecoverableError(message);
  }

  const attempt = delivery.attempts + 1;
  await prisma.delivery.update({
    where: { id: delivery.id },
    data: {
      status: 'PROCESSING',
      attempts: { increment: 1 },
      lastAttemptAt: new Date(),
      error: null,
    },
  });
  try {
    await provider.sendEmail(
      createEmailMessage({
        to: recipient,
        from: emailFrom,
        title: delivery.notification.title,
        body: delivery.notification.body,
        actionUrl: delivery.notification.actionUrl,
      }),
    );
    await prisma.delivery.update({
      where: { id: delivery.id },
      data: { status: 'DELIVERED', deliveredAt: new Date(), error: null },
    });
    logger.info(
      {
        deliveryId: delivery.id,
        notificationId: delivery.notificationId,
        channel: delivery.channel,
        attempt,
      },
      'Email delivery completed',
    );
  } catch (error) {
    const message = errorMessage(error);
    const retryable = !(error instanceof PermanentEmailError);
    const finalAttempt =
      job.attemptsMade + 1 >= (job.opts.attempts ?? EMAIL_JOB_ATTEMPTS);
    const finalFailure = !retryable || finalAttempt;
    await prisma.delivery.update({
      where: { id: delivery.id },
      data: { status: finalFailure ? 'FAILED' : 'PENDING', error: message },
    });
    logger.warn(
      {
        err: error,
        deliveryId: delivery.id,
        notificationId: delivery.notificationId,
        channel: delivery.channel,
        attempt,
        finalFailure,
      },
      'Email delivery attempt failed',
    );
    if (!retryable) throw new UnrecoverableError(message);
    throw error;
  }
}

export type EmailWorkerHandle = {
  worker: Worker<EmailJobPayload>;
  close(): Promise<void>;
};

export function createEmailWorker(
  redisUrl: string,
  prisma: PrismaClient,
  provider: EmailProvider,
  logger: FastifyBaseLogger,
  emailFrom: string,
): EmailWorkerHandle {
  const connection = new Redis(redisUrl, { maxRetriesPerRequest: null });
  connection.on('error', (err: Error) =>
    logger.error({ err }, 'Email worker Redis connection error'),
  );
  const worker = new Worker<EmailJobPayload>(
    EMAIL_QUEUE_NAME,
    (job) => processEmailJob(job, prisma, provider, logger, emailFrom),
    { connection, concurrency: 5 },
  );
  worker.on('failed', (job, error) => {
    const finalFailure = !job || job.attemptsMade >= (job.opts.attempts ?? 1);
    const fields = {
      err: error,
      jobId: job?.id,
      deliveryId: job?.data.deliveryId,
      attemptsMade: job?.attemptsMade,
      finalFailure,
    };
    if (finalFailure)
      logger.error(
        fields,
        'Email job exhausted retries and remains available for inspection',
      );
    else logger.warn(fields, 'Email job failed and will be retried');
  });
  worker.on('error', (error) =>
    logger.error({ err: error }, 'Email worker error'),
  );
  return {
    worker,
    async close() {
      try {
        await worker.close();
      } finally {
        if (connection.status === 'ready') {
          try {
            await connection.quit();
          } catch {
            connection.disconnect();
          }
        } else connection.disconnect();
      }
    },
  };
}
