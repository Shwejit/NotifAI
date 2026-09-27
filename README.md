# NotifAI

A notification infrastructure platform for applications. NotifAI will provide a tenant-scoped API and an embeddable user inbox. The project is being built incrementally as a TypeScript modular monolith.

## Phase 2 architecture

```mermaid
flowchart LR
  Client[Client application] --> API[Fastify API]
  API -. future persistence .-> PG[(PostgreSQL)]
  API -. future cache and pub/sub .-> Redis[(Redis)]
```

Phase 2 adds the multi-tenant database foundation and server-to-server API-key authentication. A tenant owns many API keys; authenticated requests resolve exactly one tenant and future tenant-owned queries must include `tenantId`. Notifications, queues, Redis application logic, dashboards, and user authentication remain deferred.

## Prerequisites

- Node.js 20 or newer
- Corepack (included with Node.js)
- Docker Desktop with Docker Compose

The repository pins pnpm 10.12.1 in `package.json`; use Corepack to run it without a global install.

## Setup and run

```powershell
Copy-Item .env.example .env
corepack pnpm install
corepack pnpm format:check
corepack pnpm lint
corepack pnpm typecheck
corepack pnpm test
corepack pnpm build
docker compose up -d --wait
corepack pnpm start
```

The API listens on `http://localhost:3000`; check `http://localhost:3000/health`. Stop the API with Ctrl+C. Stop the local services with `docker compose down` (add `-v` only when you intend to remove the local database volume).

`corepack pnpm dev` starts the TypeScript watch process. In environments where `tsx` cannot resolve the current Windows user identity, use the verified build-and-start commands above.

## Environment variables

`.env.example` documents all local settings. Copy it to `.env` before startup. The checked-in example credentials are for local development only.

| Variable            | Purpose                                    | Default                |
| ------------------- | ------------------------------------------ | ---------------------- |
| `NODE_ENV`          | Runtime mode                               | `development`          |
| `HOST`              | API bind address                           | `0.0.0.0`              |
| `PORT`              | API port                                   | `3000`                 |
| `DATABASE_URL`      | PostgreSQL connection used by Prisma       | local Compose database |
| `REDIS_URL`         | Redis connection reserved for later phases | local Compose Redis    |
| `POSTGRES_USER`     | Compose database user                      | `notifai`              |
| `POSTGRES_PASSWORD` | Compose database password                  | `notifai_dev`          |
| `POSTGRES_DB`       | Compose database name                      | `notifai`              |

## Local services and database

Docker Compose runs PostgreSQL 17 and Redis 7 with health checks. PostgreSQL data persists in the `postgres_data` named volume. Apply the first migration after starting PostgreSQL:

```powershell
docker compose up -d --wait
corepack pnpm exec prisma migrate deploy
corepack pnpm exec prisma generate
```

The migration creates `Tenant` and `ApiKey`. Raw API keys are never stored: only a SHA-256 hash and short identification prefix are persisted. The secret is returned once by the development/admin key-creation endpoint.

For local development, create a tenant and key, then call the protected endpoint:

```powershell
$tenant = Invoke-RestMethod http://localhost:3000/v1/tenants -Method Post -ContentType 'application/json' -Body '{"name":"Demo","slug":"demo"}'
$key = Invoke-RestMethod "http://localhost:3000/v1/tenants/$($tenant.id)/api-keys" -Method Post -ContentType 'application/json' -Body '{"name":"Demo server"}'
curl.exe http://localhost:3000/v1/auth/me -H "Authorization: Bearer $($key.secret)"
```

`POST /v1/tenants` and `POST /v1/tenants/:tenantId/api-keys` are intentionally minimal development/admin endpoints for Phase 2, not a production user-management system. Protected routes use `Authorization: Bearer <secret-api-key>` and return 401 for missing, invalid, revoked, or expired keys.

To validate the empty starter schema or regenerate the client:

```powershell
$env:DATABASE_URL = "postgresql://notifai:notifai_dev@127.0.0.1:5433/notifai?schema=public"
corepack pnpm exec prisma validate
corepack pnpm exec prisma generate
```

## Scripts

- `corepack pnpm dev` — run the API with reload on changes
- `corepack pnpm format` / `corepack pnpm format:check` — format or verify formatting
- `corepack pnpm lint` — lint API TypeScript
- `corepack pnpm typecheck` — strict TypeScript check
- `corepack pnpm test` — run API tests
- `corepack pnpm build` — compile the API to `apps/api/dist`
- `corepack pnpm start` — run the compiled API

## Next phases

Phase 2 complete: Prisma schema/migration, tenant/API-key authentication, strict tenant resolution, and isolation tests are implemented. The next phase should add the notification domain model and tenant-scoped notification creation/query APIs only after confirmation.
