import type { PrismaClient } from '@prisma/client';

export type PreferenceChannel = 'IN_APP' | 'EMAIL';

export async function shouldDeliverChannel(
  prisma: PrismaClient,
  input: {
    tenantId: string;
    userId: string;
    category: string;
    channel: PreferenceChannel;
  },
): Promise<boolean> {
  const preference = await prisma.preference.findFirst({
    where: {
      userId: input.userId,
      category: input.category,
      channel: input.channel,
      user: { tenantId: input.tenantId },
    },
    select: { enabled: true },
  });
  return preference?.enabled ?? true;
}

export type DndSchedule = {
  dndEnabled: boolean;
  dndStartTime: string | null;
  dndEndTime: string | null;
  timezone: string | null;
};

export function isValidTimezone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

export function isUserInDnd(
  user: DndSchedule,
  currentTime = new Date(),
): boolean {
  if (
    !user.dndEnabled ||
    !user.dndStartTime ||
    !user.dndEndTime ||
    !user.timezone ||
    !isValidTimezone(user.timezone)
  )
    return false;

  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: user.timezone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(currentTime);
  const hour = parts.find((part) => part.type === 'hour')?.value;
  const minute = parts.find((part) => part.type === 'minute')?.value;
  if (!hour || !minute) return false;
  const localTime = hour + ':' + minute;
  const { dndStartTime: start, dndEndTime: end } = user;
  if (start === end) return false;
  return start < end
    ? localTime >= start && localTime < end
    : localTime >= start || localTime < end;
}
