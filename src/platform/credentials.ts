import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Credential comparison helpers. Presented secrets are reduced to fixed-width keyed digests before
 * comparison so neither the length nor the content of a configured key can leak through timing.
 */

const fingerprintDomain = 'agent-tool-server:key-fingerprint:v1';

export class KeyedDigest {
  private readonly key: Buffer;

  public constructor(key: Buffer = randomBytes(32)) {
    this.key = key;
  }

  /** A fixed 32-byte digest regardless of the length of the presented secret. */
  public digest(secret: string): Buffer {
    return createHmac('sha256', this.key).update(secret, 'utf8').digest();
  }

  public matches(digest: Buffer, presented: string): boolean {
    const candidate = this.digest(presented);
    return candidate.length === digest.length && timingSafeEqual(candidate, digest);
  }
}

/**
 * A stable, non-reversible identifier that is safe to log. Domain separation keeps it unusable as
 * a comparison oracle against digests produced elsewhere.
 */
export const fingerprint = (secret: string): string =>
  createHash('sha256').update(`${fingerprintDomain}:${secret}`, 'utf8').digest('hex').slice(0, 12);
