import { z } from 'zod';
import { isValidTimezone } from './preference.service.js';

export const userIdQuery = z.object({ userId: z.string().uuid() });
export const preferenceBody = z
  .object({
    userId: z.string().uuid(),
    category: z.string().trim().min(1).max(100),
    channel: z.enum(['IN_APP', 'EMAIL']),
    enabled: z.boolean(),
  })
  .strict();

export const timeSchema = z
  .string()
  .regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/, 'Time must use HH:mm');
export const timezoneSchema = z
  .string()
  .min(1)
  .max(100)
  .refine(isValidTimezone, 'Invalid IANA timezone');

export const dndBody = z
  .object({
    userId: z.string().uuid(),
    enabled: z.boolean(),
    startTime: timeSchema,
    endTime: timeSchema,
    timezone: timezoneSchema,
  })
  .strict()
  .refine((value) => value.startTime !== value.endTime, {
    message: 'DND start and end times must differ',
    path: ['endTime'],
  });

export const digestBody = z
  .object({
    userId: z.string().uuid(),
    enabled: z.boolean(),
    frequency: z.enum(['DAILY', 'WEEKLY']),
    channel: z.literal('EMAIL'),
    preferredTime: timeSchema,
    timezone: timezoneSchema,
  })
  .strict();
