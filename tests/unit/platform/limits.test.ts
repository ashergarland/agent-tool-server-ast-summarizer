import { describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { Budget, defaultLimits, limitNames, resolveLimits } from '../../../src/platform/limits.js';
import { BoundedSemaphore } from '../../../src/platform/semaphore.js';
import { WarningCollector } from '../../../src/platform/warnings.js';
import { Deadline } from '../../../src/platform/cancellation.js';
import {
  assessSecretStrength,
  fingerprint,
  KeyedDigest,
  minimumSecretBits,
} from '../../../src/platform/credentials.js';

describe('platform isolation', () => {
  it('keeps compiler and AST imports out of the reusable layer', async () => {
    const directory = fileURLToPath(new URL('../../../src/platform/', import.meta.url));
    const files = await readdir(directory);
    expect(files.length).toBeGreaterThan(0);
    for (const file of files.filter((name) => name.endsWith('.ts'))) {
      const source = await readFile(join(directory, file), 'utf8');
      expect(source, `${file} must not import the compiler`).not.toMatch(
        /from '(typescript|\.\.\/ast\/[^']*)'/u,
      );
    }
  });
});

describe('limit resolution', () => {
  it('lowers a ceiling but never raises one', () => {
    const resolved = resolveLimits(defaultLimits, { maxDepth: 2, maxFiles: 1_000_000 });
    expect(resolved.limits.maxDepth).toBe(2);
    expect(resolved.limits.maxFiles).toBe(defaultLimits.maxFiles);
    expect(resolved.clamped).toEqual(['maxFiles']);
  });

  it('ignores absent and non-finite overrides', () => {
    const resolved = resolveLimits(defaultLimits, {
      maxDepth: undefined,
      maxEdges: Number.NaN,
    });
    expect(resolved.limits).toEqual(defaultLimits);
    expect(resolved.clamped).toEqual([]);
  });

  it('names every limit exactly once', () => {
    expect([...limitNames].sort()).toEqual(Object.keys(defaultLimits).sort());
  });
});

describe('budget', () => {
  it('records reached limits deterministically and marks truncation', () => {
    const budget = new Budget({ ...defaultLimits, maxTotalBytes: 100, maxFiles: 1 });
    expect(budget.truncated).toBe(false);
    expect(budget.tryConsumeBytes(60)).toBe(true);
    expect(budget.tryConsumeBytes(60)).toBe(false);
    expect(budget.allows('maxFiles', 0)).toBe(true);
    expect(budget.allows('maxFiles', 1)).toBe(false);
    expect(budget.totalBytes).toBe(60);
    expect(budget.truncated).toBe(true);
    expect(budget.limitsReached).toEqual(['maxFiles', 'maxTotalBytes']);
  });
});

describe('bounded semaphore', () => {
  it('queues up to the bound and rejects the surplus as retryable', async () => {
    const semaphore = new BoundedSemaphore(1, 1);
    let release: () => void = () => undefined;
    const first = semaphore.run(() => new Promise<void>((resolve) => (release = resolve)));
    const queued = semaphore.run(() => Promise.resolve());
    await expect(semaphore.run(() => Promise.resolve())).rejects.toMatchObject({
      code: 'busy',
      retryable: true,
    });
    expect(semaphore.stats).toMatchObject({ active: 1, queued: 1 });
    release();
    await Promise.all([first, queued]);
    expect(semaphore.stats).toMatchObject({ active: 0, queued: 0 });
  });

  it('reports saturation for readiness and drains in-flight work on shutdown', async () => {
    const semaphore = new BoundedSemaphore(1, 0);
    expect(semaphore.accepting).toBe(true);
    let release: () => void = () => undefined;
    const first = semaphore.run(() => new Promise<void>((resolve) => (release = resolve)));
    expect(semaphore.accepting).toBe(false);
    setTimeout(() => release(), 10);
    await semaphore.drain();
    await first;
    await expect(semaphore.run(() => Promise.resolve())).rejects.toMatchObject({ code: 'busy' });
  });
});

describe('warnings', () => {
  it('aggregates by code and bounds the number of categories', () => {
    const warnings = new WarningCollector(2);
    warnings.add('a', 'first');
    warnings.add('a', 'first');
    warnings.add('b', 'second');
    warnings.add('c', 'third');
    const list = warnings.list();
    expect(list.map((warning) => warning.code)).toEqual(['a', 'b', 'warnings_suppressed']);
    expect(list[0]?.count).toBe(2);
  });
});

describe('deadline', () => {
  it('cancels on expiry and propagates a caller abort', async () => {
    const expiring = new Deadline(5);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(expiring.cancelled).toBe(true);
    expect(() => expiring.throwIfCancelled()).toThrowError();
    expiring.dispose();

    const controller = new AbortController();
    const linked = new Deadline(10_000, controller.signal);
    expect(linked.cancelled).toBe(false);
    controller.abort(new Error('client went away'));
    expect(linked.cancelled).toBe(true);
    expect(() => linked.throwIfCancelled()).toThrow('client went away');
    linked.dispose();
  });
});

describe('credentials', () => {
  it('produces fixed-width digests regardless of secret length', () => {
    const digest = new KeyedDigest();
    expect(digest.digest('short').length).toBe(32);
    expect(digest.digest('x'.repeat(4096)).length).toBe(32);
    expect(digest.matches(digest.digest('secret-value'), 'secret-value')).toBe(true);
    expect(digest.matches(digest.digest('secret-value'), 'secret-valuf')).toBe(false);
    expect(digest.matches(digest.digest('secret-value'), '')).toBe(false);
  });

  it('uses an independent key per instance so a digest cannot be recomputed elsewhere', () => {
    const secret = ['fixture', 'credential', 'material', 'for', 'digest', 'assertions'].join('-');
    expect(new KeyedDigest().matches(new KeyedDigest().digest(secret), secret)).toBe(false);
  });

  it('refuses credentials that a fast keyed hash cannot protect', () => {
    expect(assessSecretStrength('short')).toMatchObject({
      acceptable: false,
      reason: 'too_short',
    });
    expect(assessSecretStrength('a'.repeat(64))).toMatchObject({
      acceptable: false,
      bits: 0,
      reason: 'repetitive',
    });
    expect(assessSecretStrength('abcdefgh'.repeat(8))).toMatchObject({
      acceptable: false,
      reason: 'repetitive',
    });
    const random = randomBytes(32).toString('hex');
    const assessment = assessSecretStrength(random);
    expect(assessment.acceptable).toBe(true);
    expect(assessment.bits).toBeGreaterThanOrEqual(minimumSecretBits);
  });

  it('produces stable non-reversible fingerprints that never contain the secret', () => {
    // Assembled at runtime so a secret scanner does not treat the fixture as a real credential.
    const secret = ['fixture', 'credential', 'material', 'for', 'digest', 'assertions'].join('-');
    expect(secret.length).toBeGreaterThanOrEqual(32);
    expect(fingerprint(secret)).toBe(fingerprint(secret));
    expect(fingerprint(secret)).toHaveLength(12);
    expect(fingerprint(secret)).not.toContain(secret.slice(0, 8));
    expect(fingerprint(secret)).not.toBe(fingerprint(`${secret}!`));
  });
});
