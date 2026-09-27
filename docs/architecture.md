# Phase 3 architecture

The API resolves a tenant from the server API key. Users are unique by `(tenantId, externalId)`. Notifications reference both their tenant and tenant-owned user; inbox operations always filter by the authenticated tenant.

PostgreSQL enforces `(tenantId, idempotencyKey)` uniqueness. Inbox pages use a stable descending `(createdAt, id)` cursor. Redis is not used by the Phase 3 request path.

## Phase 5 async delivery

An authenticated notification request atomically inserts the Notification and its EMAIL Delivery in PostgreSQL. The API then enqueues deliveryId and notificationId in BullMQ and returns without waiting on the provider. Missing email is recorded as a FAILED Delivery without queueing a job.

The notification-email worker loads the current Delivery, Notification, and User from PostgreSQL. The provider interface currently uses a mock implementation by default; it logs recipient and subject metadata only. A real provider can implement the same interface without changing route or worker orchestration.

BullMQ retries transient provider errors three times with exponential backoff starting at one second. Permanent provider failures stop immediately. Exhausted jobs remain as failed jobs in BullMQ for inspection, and the Delivery stores FAILED plus its final error. GET /v1/deliveries/:id is tenant-scoped.

PostgreSQL is the source of truth, Redis carries Pub/Sub and queue traffic through separate connections, BullMQ manages asynchronous jobs, and the worker performs the external side effect. If enqueueing fails, the notification remains successful and the Delivery is marked FAILED where possible. A transactional outbox is not included in this phase.
