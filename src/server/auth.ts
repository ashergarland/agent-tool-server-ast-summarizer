import type { FastifyRequest } from 'fastify';
import type { AppConfig } from '../config/index.js';
import { unauthorized } from '../errors.js';
import { KeyedDigest, fingerprint } from '../platform/credentials.js';

export interface Principal {
  readonly id: string;
  readonly kind: 'api-key' | 'anonymous';
  /** Non-reversible identifier that is safe to log. */
  readonly fingerprint: string;
}

export interface Authenticator {
  authenticate(request: FastifyRequest): Promise<Principal>;
}

const credential = (request: FastifyRequest): string | undefined => {
  const authorization = request.headers.authorization;
  if (typeof authorization === 'string' && authorization.toLowerCase().startsWith('bearer ')) {
    return authorization.slice(7).trim() || undefined;
  }
  const apiKey = request.headers['x-api-key'];
  return typeof apiKey === 'string' && apiKey.length > 0 ? apiKey : undefined;
};

class DisabledAuthenticator implements Authenticator {
  public authenticate(): Promise<Principal> {
    return Promise.resolve({ id: 'anonymous', kind: 'anonymous', fingerprint: 'anonymous' });
  }
}

/**
 * Compares fixed-width HMAC digests of the presented secret rather than the raw bytes, so neither
 * the length nor the content of a configured key is observable through comparison timing. Only
 * digests and non-reversible fingerprints are retained. Every candidate is checked so the number
 * of configured keys does not change the work performed.
 */
class ApiKeyAuthenticator implements Authenticator {
  private readonly digest = new KeyedDigest();
  private readonly keys: ReadonlyArray<{ value: Buffer; principalId: string; fingerprint: string }>;

  public constructor(apiKeys: readonly string[]) {
    this.keys = apiKeys.map((key, index) => ({
      value: this.digest.digest(key),
      principalId: `key:${index + 1}`,
      fingerprint: fingerprint(key),
    }));
  }

  public authenticate(request: FastifyRequest): Promise<Principal> {
    const presented = credential(request);
    if (!presented) throw unauthorized('Missing bearer token or x-api-key header');
    let match: { principalId: string; fingerprint: string } | undefined;
    for (const candidate of this.keys) {
      if (this.digest.matches(candidate.value, presented)) match = candidate;
    }
    if (!match) throw unauthorized('Invalid API key');
    return Promise.resolve({
      id: match.principalId,
      kind: 'api-key',
      fingerprint: match.fingerprint,
    });
  }
}

export const createAuthenticator = (config: AppConfig): Authenticator =>
  config.auth.mode === 'disabled'
    ? new DisabledAuthenticator()
    : new ApiKeyAuthenticator(config.auth.apiKeys);
