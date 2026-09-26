# NotifAI

A notification infrastructure platform for applications. NotifyBell will provide a tenant-scoped API and an embeddable user inbox. The project is being built incrementally as a TypeScript modular monolith.

## Phase 1 architecture

```mermaid
flowchart LR
  Client[Client application] --> API[Fastify API]
  API -. future persistence .-> PG[(PostgreSQL)]
  API -. future cache and pub/sub .-> Redis[(Redis)]
```

Phase 1 creates the workspace, API shell, configuration, Prisma datasource, and local PostgreSQL/Redis services. Only `GET /health` is implemented; feature APIs and Redis application logic are deferred.

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
| `POSTGRES_USER`     | Compose database user                      | `notifybell`           |
| `POSTGRES_PASSWORD` | Compose database password                  | `notifybell_dev`       |
| `POSTGRES_DB`       | Compose database name                      | `notifybell`           |

## Local services and database

Docker Compose runs PostgreSQL 17 and Redis 7 with health checks. PostgreSQL data persists in the `postgres_data` named volume. Prisma is configured for PostgreSQL and its client can be generated, but Phase 1 has no application schema or migration.

To validate the empty starter schema or regenerate the client:

```powershell
$env:DATABASE_URL = "postgresql://notifybell:notifybell_dev@localhost:5432/notifybell?schema=public"
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

Phase 2 adds the Prisma schema and migrations, tenant and API-key models, authentication, and tenant-isolation tests. Notifications, queues, real-time delivery, SDK/dashboard, and AI are intentionally out of scope for Phase 1.
