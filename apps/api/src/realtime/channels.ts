export function getUserChannel(tenantId: string, userId: string): string {
  return `notifai:${tenantId}:user:${userId}`;
}
