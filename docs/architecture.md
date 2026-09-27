# Phase 2 architecture

NotifAI is a modular monolith: one Fastify API process and PostgreSQL as the source of truth. Redis is available for later phases but has no application logic yet.

## Multi-tenancy

`Tenant` is the isolation boundary. One tenant has many `ApiKey` records through `ApiKey.tenantId`; API keys are server-to-server credentials. `Tenant.slug` is unique, and `ApiKey.tenantId` is indexed and protected by a foreign key.

## API-key authentication

Keys are generated with Node crypto, returned only at creation, and stored as a SHA-256 hash with a safe prefix. The auth plugin hashes the Bearer secret, rejects missing/invalid/revoked/expired records with 401, updates `lastUsedAt`, and attaches the resolved tenant to the Fastify request. Authorization headers are redacted from logs.

## Tenant isolation pattern

Every future tenant-owned query must carry the authenticated `request.tenant.id` as `tenantId` in its Prisma `where` or `data` clause. The database relation and indexed foreign key make tenant ownership explicit; application code must never query tenant-owned records by an unscoped global identifier.

Run `docker compose up -d --wait` followed by `corepack pnpm exec prisma migrate deploy` against the local PostgreSQL service to apply the first migration. Docker PostgreSQL is exposed on host port `5433` to avoid conflicts with a locally installed PostgreSQL server on `5432`. The development/admin endpoints and authenticated request example are documented in the root README.
