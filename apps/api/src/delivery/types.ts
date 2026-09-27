export type EmailJobPayload = { deliveryId: string; notificationId: string };
export interface EmailQueueService {
  enqueue(payload: EmailJobPayload): Promise<void>;
  close(): Promise<void>;
}
