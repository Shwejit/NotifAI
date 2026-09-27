import type { FastifyBaseLogger } from 'fastify';
import type { RealtimeEvent, RealtimeService } from './events.js';
export async function publishRealtimeSafely(
  realtime: RealtimeService,
  event: RealtimeEvent,
  logger: FastifyBaseLogger,
): Promise<void> {
  try {
    await realtime.publish(event);
  } catch (error) {
    logger.error(
      { err: error, eventType: event.type },
      'Redis publish failed after database operation succeeded',
    );
  }
}
