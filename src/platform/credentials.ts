import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Credential comparison helpers. Presented secrets are reduced to fixed-width keyed digests before
 * comparison so neither the length nor the content of a configured key can leak through timing.
 *
 * These credentials are machine tokens, not user-chosen passwords, and the distinction drives the
 * design:
 *
 * - A digest is never stored, transmitted, or written to disk. It exists only inside one process
 *   for the lifetime of a comparison, so there is no artefact for an attacker to crack offline.
 * - The HMAC key is a fresh 32 random bytes per process, so a digest cannot even be recomputed
 *   elsewhere, let alone attacked with a precomputed table.
 * - `assessSecretStrength` refuses to accept a low-entropy key at configuration time, so the input
 *   is a high-entropy random token rather than something a wordlist can reach.
 *
 * A deliberately slow KDF is therefore the wrong tool here. It defends stored password hashes
 * against offline cracking; against a high-entropy token verified in memory it adds nothing, and
 * running one per request would hand an unauthenticated caller a cheap CPU-exhaustion lever on a
 * container sized for a fraction of a core.
 */

const fingerprintDomain = 'agent-tool-server:key-fingerprint:v1';

/** Estimated entropy below which a configured credential is refused. */
export const minimumSecretBits = 96;

/** Shannon entropy of the observed character distribution, scaled by length. */
const estimateBits = (secret: string): number => {
  const counts = new Map<string, number>();
  for (const character of secret) counts.set(character, (counts.get(character) ?? 0) + 1);
  let perCharacter = 0;
  for (const count of counts.values()) {
    const probability = count / secret.length;
    perCharacter -= probability * Math.log2(probability);
  }
  return perCharacter * secret.length;
};

/**
 * Length of the shortest repeating unit. A character histogram cannot see structure, so
 * `1234567890` repeated three times would otherwise look acceptably random.
 */
const shortestPeriod = (secret: string): number => {
  for (let period = 1; period < secret.length; period += 1) {
    let repeats = true;
    for (let index = period; index < secret.length; index += 1) {
      if (secret[index] !== secret[index - period]) {
        repeats = false;
        break;
      }
    }
    if (repeats) return period;
  }
  return secret.length;
};

export interface SecretStrength {
  readonly acceptable: boolean;
  readonly bits: number;
  readonly reason?: 'too_short' | 'repetitive' | 'insufficient_entropy';
}

/**
 * Rejects credentials a fast keyed hash cannot safely protect. Callers must supply a randomly
 * generated token, for example `openssl rand -hex 32`.
 */
export const assessSecretStrength = (secret: string): SecretStrength => {
  const bits = estimateBits(secret);
  if (secret.length < 32) return { acceptable: false, bits, reason: 'too_short' };
  if (shortestPeriod(secret) * 3 <= secret.length) {
    return { acceptable: false, bits, reason: 'repetitive' };
  }
  if (bits < minimumSecretBits) {
    return { acceptable: false, bits, reason: 'insufficient_entropy' };
  }
  return { acceptable: true, bits };
};

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
 * a comparison oracle against digests produced elsewhere, and truncation keeps it useless as a
 * cracking target: many distinct keys share any given fingerprint. It stays stable across restarts
 * so operators can correlate a key across deployments during rotation.
 */
export const fingerprint = (secret: string): string =>
  createHash('sha256').update(`${fingerprintDomain}:${secret}`, 'utf8').digest('hex').slice(0, 12);
