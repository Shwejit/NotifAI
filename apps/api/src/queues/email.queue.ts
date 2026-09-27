import { Queue } from 'bullmq';
import type { FastifyBaseLogger } from 'fastify';
import { Redis } from 'ioredis';
import type { EmailJobPayload, EmailQueueService } from '../delivery/types.js';

export const EMAIL_QUEUE_NAME = 'notification-email';
export const EMAIL_JOB_NAME = 'send-email';
export const EMAIL_JOB_ATTEMPTS = 3;

export function createEmailQueue(
  redisUrl: string,
  logger: FastifyBaseLogger,
): EmailQueueService {
  const connection = new Redis(redisUrl, {
    maxRetriesPerRequest: 1,
    retryStrategy: (attempt: number) => Math.min(attempt * 100, 1_000),
  });
  connection.on('error', (err: Error) =>
    logger.error({ err }, 'Email queue Redis connection error'),
  );
  const queue = new Queue<EmailJobPayload>(EMAIL_QUEUE_NAME, {
    connection,
    defaultJobOptions: {
      attempts: EMAIL_JOB_ATTEMPTS,
      backoff: { type: 'exponential', delay: 1_000 },
      removeOnComplete: { age: 3_600, count: 1_000 },
      removeOnFail: false,
    },
  });
  return {
    async enqueue(payload) {
      await queue.add(EMAIL_JOB_NAME, payload, {
        jobId: `delivery-${payload.deliveryId}`,
      });
    },
    async close() {
      try {
        await queue.close();
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

export function createNoopEmailQueue(): EmailQueueService {
  return { async enqueue() {}, async close() {} };
}
