import { createHash, randomBytes } from 'node:crypto';

const KEY_PREFIX = 'nfa_live_';

export function createApiKey() {
  const secret = `${KEY_PREFIX}${randomBytes(32).toString('base64url')}`;
  return {
    secret,
    prefix: secret.slice(0, KEY_PREFIX.length + 8),
    keyHash: hashApiKey(secret),
  };
}

export function hashApiKey(secret: string) {
  return createHash('sha256').update(secret).digest('hex');
}
