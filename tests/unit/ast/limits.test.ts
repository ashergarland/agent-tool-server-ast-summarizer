import { describe, expect, it } from 'vitest';
import { Budget, defaultLimits, limitNames, resolveLimits } from '../../../src/ast/limits.js';
import { WarningCollector } from '../../../src/ast/warnings.js';

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
