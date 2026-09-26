# Phase 1 architecture

NotifyBell starts as a modular monolith: one Fastify API process with PostgreSQL as the future source of truth and Redis available for later phases. Docker Compose runs the local data services. Phase 1 exposes only a health check; product APIs arrive in later phases.
