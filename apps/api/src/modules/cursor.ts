import { z } from 'zod';

const cursorPayload = z.object({
  createdAt: z.string().datetime({ offset: true }),
  id: z.string().uuid(),
});

export type InboxCursor = { createdAt: Date; id: string };

export function encodeCursor(cursor: InboxCursor): string {
  return Buffer.from(
    JSON.stringify({
      createdAt: cursor.createdAt.toISOString(),
      id: cursor.id,
    }),
  ).toString('base64url');
}

export function decodeCursor(value: string): InboxCursor | null {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return null;
  try {
    const parsed = cursorPayload.safeParse(
      JSON.parse(Buffer.from(value, 'base64url').toString('utf8')),
    );
    if (!parsed.success) return null;
    return { createdAt: new Date(parsed.data.createdAt), id: parsed.data.id };
  } catch {
    return null;
  }
}
