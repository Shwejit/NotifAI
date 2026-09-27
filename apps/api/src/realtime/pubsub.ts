import type { FastifyBaseLogger } from 'fastify';
import { Redis } from 'ioredis';
import { getUserChannel } from './channels.js';
import type {
  RealtimeEvent,
  RealtimeListener,
  RealtimeService,
} from './events.js';
export function createRealtimeService(
  redisUrl: string,
  logger: FastifyBaseLogger,
): RealtimeService {
  const options = {
    lazyConnect: true,
    maxRetriesPerRequest: 1,
    retryStrategy: (n: number) => Math.min(n * 100, 1000),
  };
  const publisher = new Redis(redisUrl, options);
  const subscriber = new Redis(redisUrl, options);
  const listeners = new Map<string, Set<RealtimeListener>>();
  const pending = new Map<string, Promise<void>>();
  for (const client of [publisher, subscriber])
    client.on('error', (err: Error) =>
      logger.error({ err }, 'Redis realtime connection error'),
    );
  subscriber.on('message', (channel: string, message: string) => {
    const current = listeners.get(channel);
    if (!current) return;
    let event: RealtimeEvent;
    try {
      event = JSON.parse(message) as RealtimeEvent;
    } catch (err) {
      logger.warn({ err, channel }, 'Invalid realtime event');
      return;
    }
    for (const listener of current) {
      try {
        listener(event);
      } catch (err) {
        logger.error({ err, channel }, 'Realtime listener failed');
      }
    }
  });
  return {
    async publish(event) {
      await publisher.publish(
        getUserChannel(event.tenantId, event.userId),
        JSON.stringify(event),
      );
    },
    async subscribe(tenantId, userId, listener) {
      const channel = getUserChannel(tenantId, userId);
      let current = listeners.get(channel);
      const first = !current;
      if (!current) {
        current = new Set();
        listeners.set(channel, current);
      }
      current.add(listener);
      try {
        if (first) {
          const p = subscriber.subscribe(channel).then(() => undefined);
          pending.set(channel, p);
          try {
            await p;
          } finally {
            if (pending.get(channel) === p) pending.delete(channel);
          }
        } else await pending.get(channel);
      } catch (err) {
        current.delete(listener);
        if (!current.size) listeners.delete(channel);
        throw err;
      }
      let active = true;
      return () => {
        if (!active) return;
        active = false;
        const set = listeners.get(channel);
        set?.delete(listener);
        if (set?.size === 0) {
          listeners.delete(channel);
          void subscriber
            .unsubscribe(channel)
            .catch((err: Error) =>
              logger.error({ err, channel }, 'Redis unsubscribe failed'),
            );
        }
      };
    },
    async close() {
      listeners.clear();
      await Promise.all(
        [publisher, subscriber].map(async (client) => {
          if (client.status !== 'ready') {
            client.disconnect();
            return;
          }
          try {
            await client.quit();
          } catch (err) {
            logger.warn({ err }, 'Redis close failed');
            client.disconnect();
          }
        }),
      );
    },
  };
}
