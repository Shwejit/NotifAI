import { describe, expect, it } from 'vitest';
import { buildApp } from './app.js';
import { createApiKey, hashApiKey } from './modules/api-keys.js';
import type { PrismaClient, Tenant } from '@prisma/client';

const tenantA: Tenant = {
  id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  name: 'Tenant A',
  slug: 'tenant-a',
  createdAt: new Date(),
  updatedAt: new Date(),
};
const tenantB: Tenant = {
  id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
  name: 'Tenant B',
  slug: 'tenant-b',
  createdAt: new Date(),
  updatedAt: new Date(),
};

function fakePrisma(overrides: Record<string, unknown> = {}) {
  const a = createApiKey();
  const b = createApiKey();
  const keys = new Map([
    [
      a.keyHash,
      { id: 'key-a', tenant: tenantA, revokedAt: null, expiresAt: null },
    ],
    [
      b.keyHash,
      { id: 'key-b', tenant: tenantB, revokedAt: null, expiresAt: null },
    ],
  ]);
  return {
    apiKey: {
      findUnique: async ({ where }: { where: { keyHash: string } }) =>
        overrides[where.keyHash] ?? keys.get(where.keyHash),
      update: async () => undefined,
    },
    tenant: { create: async () => tenantA },
    generated: { a: a.secret, b: b.secret },
    keys,
  } as unknown as PrismaClient & {
    generated: { a: string; b: string };
    keys: Map<string, unknown>;
  };
}

describe('health endpoint', () => {
  it('reports that the API is running', async () => {
    const app = buildApp();
    const response = await app.inject({ method: 'GET', url: '/health' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok' });
    await app.close();
  });
});

describe('API-key authentication and tenant isolation', () => {
  it('missing API key returns 401', async () => {
    const app = buildApp(fakePrisma());
    const response = await app.inject({
      method: 'GET',
      url: '/v1/auth/me',
    });
    expect(response.statusCode).toBe(401);
    await app.close();
  });

  it('invalid API key returns 401', async () => {
    const app = buildApp(fakePrisma());
    const response = await app.inject({
      method: 'GET',
      url: '/v1/auth/me',
      headers: { authorization: 'Bearer nfa_live_invalid' },
    });
    expect(response.statusCode).toBe(401);
    await app.close();
  });

  it('resolves the correct tenant and never crosses tenant data', async () => {
    const prisma = fakePrisma();
    const app = buildApp(prisma);
    const responseA = await app.inject({
      method: 'GET',
      url: '/v1/auth/me',
      headers: { authorization: `Bearer ${prisma.generated.a}` },
    });
    const responseB = await app.inject({
      method: 'GET',
      url: '/v1/auth/me',
      headers: { authorization: `Bearer ${prisma.generated.b}` },
    });
    expect(responseA.json().tenant.id).toBe(tenantA.id);
    expect(responseB.json().tenant.id).toBe(tenantB.id);
    expect(responseA.json().tenant.id).not.toBe(responseB.json().tenant.id);
    await app.close();
  });

  it.each([
    ['revoked', { revokedAt: new Date(), expiresAt: null }],
    ['expired', { revokedAt: null, expiresAt: new Date(Date.now() - 1000) }],
  ])('%s API key returns 401', async (_name, state) => {
    const prisma = fakePrisma();
    const hash = hashApiKey(prisma.generated.a);
    prisma.keys.set(hash, { id: 'key-a', tenant: tenantA, ...state });
    const app = buildApp(prisma);
    const response = await app.inject({
      method: 'GET',
      url: '/v1/auth/me',
      headers: { authorization: `Bearer ${prisma.generated.a}` },
    });
    expect(response.statusCode).toBe(401);
    await app.close();
  });
});
