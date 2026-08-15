import { describe, expect, it } from 'vitest';
import { supportedExtensions } from '../../../src/ast/language.js';
import { AstService } from '../../../src/ast/service.js';
import { defaultLimits, type AnalysisLimits } from '../../../src/platform/limits.js';
import type { MeasurementEvent } from '../../../src/platform/measurements.js';
import { noopMeasurementSink } from '../../../src/platform/measurements.js';
import { BoundedSemaphore } from '../../../src/platform/semaphore.js';
import { Workspace } from '../../../src/platform/workspace.js';
import { createWorkspace } from '../../helpers/workspace.js';

interface ServiceOptions {
  readonly limits?: Partial<AnalysisLimits>;
  readonly semaphore?: BoundedSemaphore;
  readonly events?: MeasurementEvent[];
}

const serviceFor = (root: string, options: ServiceOptions = {}): AstService => {
  const ceilings = { ...defaultLimits, ...options.limits };
  return new AstService({
    workspace: new Workspace({
      root,
      maxFileBytes: ceilings.maxFileBytes,
      allowedExtensions: supportedExtensions,
    }),
    ceilings,
    semaphore: options.semaphore ?? new BoundedSemaphore(2, 4),
    includePrivateMembers: false,
    typeInference: 'off',
    measurements: options.events
      ? { record: (event) => options.events?.push(event) }
      : noopMeasurementSink,
  });
};

const wide = (declarations: number): string =>
  Array.from({ length: declarations }, (_, index) => `export const value${index}: number;`).join(
    '\n',
  );

describe('analysis limits and admission control', () => {
  it('stops at a declaration boundary when the result character limit is reached', async () => {
    const root = await createWorkspace({ 'src/a.ts': wide(50) });
    const result = await serviceFor(root, { limits: { maxResultChars: 200 } }).getFileSkeleton({
      path: 'src/a.ts',
    });
    expect(result.truncated).toBe(true);
    expect(result.complete).toBe(false);
    expect(result.limitsReached).toContain('maxResultChars');
    expect(result.skeleton.length).toBeLessThanOrEqual(200);
    expect(result.skeleton.endsWith(';')).toBe(true);
    expect(result.metrics.declarationsReturned).toBeLessThan(50);
    expect(result.metrics.declarationsOmitted).toBeGreaterThan(0);
  });

  it('stops at the declaration and member limits', async () => {
    const root = await createWorkspace({
      'src/a.ts': `${wide(20)}\nexport interface Wide { ${Array.from({ length: 30 }, (_, index) => `member${index}: string;`).join(' ')} }\n`,
    });
    const declarationLimited = await serviceFor(root, {
      limits: { maxDeclarations: 5 },
    }).getFileSkeleton({ path: 'src/a.ts' });
    expect(declarationLimited.metrics.declarationsReturned).toBe(5);
    expect(declarationLimited.limitsReached).toContain('maxDeclarations');

    const memberLimited = await serviceFor(root, {
      limits: { maxMembersPerDeclaration: 4 },
    }).getFileSkeleton({ path: 'src/a.ts' });
    expect(memberLimited.limitsReached).toContain('maxMembersPerDeclaration');
    expect(memberLimited.omissions.map((omission) => omission.kind)).toContain(
      'member_limit_reached',
    );
  });

  it('truncates documentation at a line boundary and warns', async () => {
    const root = await createWorkspace({
      'src/a.ts': `/**\n * ${'documentation '.repeat(40)}\n */\nexport const value: number;\n`,
    });
    const result = await serviceFor(root, { limits: { maxJsDocChars: 40 } }).getFileSkeleton({
      path: 'src/a.ts',
    });
    expect(result.limitsReached).toContain('maxJsDocChars');
    expect(result.skeleton).toContain('... documentation truncated');
    expect(result.warnings.map((warning) => warning.code)).toContain('jsdoc_truncated');
  });

  it('clamps per-call limits to the deployment ceiling and warns', async () => {
    const root = await createWorkspace({ 'src/a.ts': wide(10) });
    const result = await serviceFor(root, { limits: { maxDeclarations: 3 } }).getFileSkeleton({
      path: 'src/a.ts',
      limits: { maxDeclarations: 1_000 },
    });
    expect(result.metrics.declarationsReturned).toBe(3);
    expect(result.warnings.map((warning) => warning.code)).toContain('limit_clamped');
  });

  it('refuses a file that exceeds the cumulative byte budget', async () => {
    const root = await createWorkspace({ 'src/a.ts': wide(100) });
    await expect(
      serviceFor(root, { limits: { maxTotalBytes: 10 } }).getFileSkeleton({ path: 'src/a.ts' }),
    ).rejects.toMatchObject({ code: 'limit_exceeded' });
  });

  it('honours a caller abort and a deadline', async () => {
    const root = await createWorkspace({ 'src/a.ts': wide(10) });
    const controller = new AbortController();
    controller.abort(new Error('caller went away'));
    await expect(
      serviceFor(root).getFileSkeleton({ path: 'src/a.ts', signal: controller.signal }),
    ).rejects.toThrow('caller went away');

    await expect(
      serviceFor(root, { limits: { requestTimeoutMs: 100 } }).getFileSkeleton({
        path: 'src/a.ts',
        limits: { requestTimeoutMs: 0 },
      }),
    ).rejects.toMatchObject({ code: 'timeout', retryable: true });
  });

  it('rejects work beyond the queue bound with a retryable error', async () => {
    const root = await createWorkspace({ 'src/a.ts': wide(200) });
    const service = serviceFor(root, { semaphore: new BoundedSemaphore(1, 0) });
    const results = await Promise.allSettled([
      service.getFileSkeleton({ path: 'src/a.ts' }),
      service.getFileSkeleton({ path: 'src/a.ts' }),
      service.getFileSkeleton({ path: 'src/a.ts' }),
    ]);
    const rejected = results.filter((result) => result.status === 'rejected');
    expect(rejected.length).toBeGreaterThan(0);
    expect(rejected[0]).toMatchObject({ reason: { code: 'busy', retryable: true } });
  });

  it('records only safe measurement fields', async () => {
    const events: MeasurementEvent[] = [];
    const root = await createWorkspace({ 'src/a.ts': wide(3) });
    await serviceFor(root, { events }).getFileSkeleton({ path: 'src/a.ts' });
    await serviceFor(root, { events })
      .getFileSkeleton({ path: 'missing.ts' })
      .catch(() => undefined);
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      name: 'ast.analysis',
      tool: 'get_file_skeleton',
      outcome: 'ok',
    });
    expect(events[1]).toMatchObject({ outcome: 'error', errorCode: 'not_found' });
    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain('src/a.ts');
    expect(serialized).not.toContain(root);
  });
});
