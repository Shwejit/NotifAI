import { describe, expect, it } from 'vitest';
import { isUserInDnd } from './preferences/preference.service.js';
import { timezoneSchema } from './preferences/schemas.js';

describe('DND local-time evaluation', () => {
  const schedule = {
    dndEnabled: true,
    dndStartTime: '22:00',
    dndEndTime: '07:00',
    timezone: 'Asia/Kolkata',
  };
  it('supports a midnight-crossing window in the user timezone', () => {
    expect(isUserInDnd(schedule, new Date('2026-02-01T18:00:00.000Z'))).toBe(
      true,
    );
    expect(isUserInDnd(schedule, new Date('2026-02-02T02:30:00.000Z'))).toBe(
      false,
    );
  });
  it('rejects invalid IANA timezone names', () => {
    expect(timezoneSchema.safeParse('Mars/Olympus').success).toBe(false);
  });
});
