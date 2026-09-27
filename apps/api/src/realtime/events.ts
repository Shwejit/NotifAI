export type RealtimeEventType =
  | 'notification.created'
  | 'notification.read'
  | 'notification.unread'
  | 'notification.archived'
  | 'notification.read_all';
export type RealtimeEvent = {
  type: RealtimeEventType;
  tenantId: string;
  userId: string;
  notificationId?: string;
  timestamp: string;
  data?: {
    notification?: {
      id: string;
      title: string;
      body: string;
      category: string | null;
      actionUrl: string | null;
      priority: 'URGENT' | 'IMPORTANT' | 'LOW';
      createdAt: Date;
      readAt: Date | null;
      archivedAt: Date | null;
    };
    updatedCount?: number;
  };
};
export type RealtimeListener = (event: RealtimeEvent) => void;
export interface RealtimeService {
  publish(event: RealtimeEvent): Promise<void>;
  subscribe(
    tenantId: string,
    userId: string,
    listener: RealtimeListener,
  ): Promise<() => void>;
  close(): Promise<void>;
}
