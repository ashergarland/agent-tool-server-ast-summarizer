import { describe, expect, it } from 'vitest';
import { supportedExtensions } from '../../../src/ast/language.js';
import { AstService } from '../../../src/ast/service.js';
import { defaultLimits, type AnalysisLimits } from '../../../src/platform/limits.js';
import { noopMeasurementSink } from '../../../src/platform/measurements.js';
import { BoundedSemaphore } from '../../../src/platform/semaphore.js';
import { Workspace } from '../../../src/platform/workspace.js';
import { createWorkspace, trySymlink } from '../../helpers/workspace.js';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const serviceFor = (root: string, overrides: Partial<AnalysisLimits> = {}): AstService => {
  const ceilings = { ...defaultLimits, ...overrides };
  return new AstService({
    workspace: new Workspace({
      root,
      maxFileBytes: ceilings.maxFileBytes,
      allowedExtensions: supportedExtensions,
    }),
    ceilings,
    semaphore: new BoundedSemaphore(2, 4),
    includePrivateMembers: false,
    typeInference: 'off',
    measurements: noopMeasurementSink,
  });
};

const graphOf = async (
  files: Record<string, string>,
  path: string,
  overrides: Partial<AnalysisLimits> = {},
  request: { maxDepth?: number } = {},
) => {
  const root = await createWorkspace(files);
  return serviceFor(root, overrides).getDependencyGraph({ path, ...request });
};

describe('dependency graph', () => {
  it('classifies every reference kind and resolution outcome', async () => {
    const graph = await graphOf(
      {
        'src/entry.ts': `import { a } from './a.js';
export * from './b.js';
import equals = require('./c.js');
const lazy = await import('./d.js');
const legacy = require('./e.cjs');
import data from './data.json';
import express from 'express';
import { gone } from './missing.js';
`,
        'src/a.ts': 'export const a = 1;\n',
        'src/b.ts': 'export const b = 1;\n',
        'src/c.ts': 'export const c = 1;\n',
        'src/d.ts': 'export const d = 1;\n',
        'src/e.cjs': 'module.exports = {};\n',
        'src/data.json': '{}',
      },
      'src/entry.ts',
    );
    expect(graph.entry).toBe('src/entry.ts');
    expect(graph.dependencies.map((edge) => edge.kind).sort()).toEqual([
      'dynamic-import',
      'export',
      'import',
      'import-equals',
      'require',
    ]);
    expect(graph.external).toEqual([
      { from: 'src/entry.ts', specifier: 'express', kind: 'import' },
    ]);
    expect(graph.unresolved).toContainEqual({
      from: 'src/entry.ts',
      specifier: './missing.js',
      kind: 'import',
      reason: 'missing',
    });
    expect(graph.unresolved.some((entry) => entry.specifier === './data.json')).toBe(true);
    expect(graph.metrics.filesReturned).toBe(graph.files.length);
    expect(graph.complete).toBe(true);
  });

  it('is deterministic and terminates on cycles', async () => {
    const files = {
      'src/a.ts': "import './b.js';\nimport './c.js';\n",
      'src/b.ts': "import './c.js';\nimport './a.js';\n",
      'src/c.ts': "import './a.js';\n",
    };
    const first = await graphOf(files, 'src/a.ts');
    const second = await graphOf(files, 'src/a.ts');
    expect(first.files).toEqual(['src/a.ts', 'src/b.ts', 'src/c.ts']);
    expect(first.files).toEqual(second.files);
    expect(first.dependencies).toEqual(second.dependencies);
  });

  it('treats maxDepth as the number of edges followed from the entry', async () => {
    const files = {
      'src/a.ts': "import './b.js';\n",
      'src/b.ts': "import './c.js';\n",
      'src/c.ts': 'export const c = 1;\n',
    };
    const entryOnly = await graphOf(files, 'src/a.ts', {}, { maxDepth: 0 });
    expect(entryOnly.files).toEqual(['src/a.ts']);
    expect(entryOnly.dependencies[0]).toMatchObject({ to: 'src/b.ts', traversed: false });
    expect(entryOnly.truncated).toBe(true);
    expect(entryOnly.complete).toBe(false);
    expect(entryOnly.limitsReached).toContain('maxDepth');

    const oneLevel = await graphOf(files, 'src/a.ts', {}, { maxDepth: 1 });
    expect(oneLevel.files).toEqual(['src/a.ts', 'src/b.ts']);

    const full = await graphOf(files, 'src/a.ts', {}, { maxDepth: 2 });
    expect(full.files).toEqual(['src/a.ts', 'src/b.ts', 'src/c.ts']);
    expect(full.truncated).toBe(false);
  });

  it('clamps a requested depth above the deployment ceiling', async () => {
    const graph = await graphOf(
      { 'src/a.ts': 'export const a = 1;\n' },
      'src/a.ts',
      { maxDepth: 1 },
      { maxDepth: 99 },
    );
    expect(graph.metrics.maxDepth).toBe(1);
    expect(graph.warnings.map((warning) => warning.code)).toContain('limit_clamped');
  });

  it('stops on the file, edge, and byte limits and says so', async () => {
    const files = {
      'src/a.ts': "import './b.js';\nimport './c.js';\n",
      'src/b.ts': 'export const b = 1;\n',
      'src/c.ts': 'export const c = 1;\n',
    };
    const fileLimited = await graphOf(files, 'src/a.ts', { maxFiles: 2 });
    expect(fileLimited.limitsReached).toContain('maxFiles');
    expect(fileLimited.files.length).toBeLessThan(3);

    const edgeLimited = await graphOf(files, 'src/a.ts', { maxEdges: 1 });
    expect(edgeLimited.limitsReached).toContain('maxEdges');
    expect(edgeLimited.unresolved).toContainEqual(
      expect.objectContaining({ reason: 'limit_stopped' }),
    );

    const byteLimited = await graphOf(files, 'src/a.ts', {
      maxFileBytes: 4_096,
      maxTotalBytes: 40,
    });
    expect(byteLimited.limitsReached).toContain('maxTotalBytes');
    expect(byteLimited.complete).toBe(false);
  });

  it('honours in-root tsconfig path aliases and ignores out-of-root configuration', async () => {
    const graph = await graphOf(
      {
        'tsconfig.json': JSON.stringify({
          compilerOptions: { baseUrl: '.', paths: { '@app/*': ['src/*'] } },
        }),
        'src/entry.ts': "import { helper } from '@app/helper.js';\n",
        'src/helper.ts': 'export const helper = 1;\n',
      },
      'src/entry.ts',
    );
    expect(graph.configPath).toBe('tsconfig.json');
    expect(graph.dependencies).toContainEqual({
      from: 'src/entry.ts',
      to: 'src/helper.ts',
      specifier: '@app/helper.js',
      kind: 'import',
      traversed: true,
    });
  });

  it('follows a local extends chain but refuses one that leaves the root', async () => {
    const graph = await graphOf(
      {
        'base/tsconfig.base.json': JSON.stringify({
          compilerOptions: { baseUrl: '..', paths: { '~/*': ['src/*'] } },
        }),
        'tsconfig.json': JSON.stringify({ extends: './base/tsconfig.base.json' }),
        'src/entry.ts': "import { helper } from '~/helper.js';\n",
        'src/helper.ts': 'export const helper = 1;\n',
      },
      'src/entry.ts',
    );
    expect(graph.dependencies.map((edge) => edge.to)).toContain('src/helper.ts');
  });

  it('never reads a package or a file outside the root', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'ast-graph-outside-'));
    await writeFile(join(outside, 'secret.ts'), 'export const secret = true;\n');
    const root = await createWorkspace({
      'src/entry.ts': "import './linked.js';\nimport 'left-pad';\n",
      'node_modules/left-pad/index.js': 'module.exports = () => {};\n',
      'node_modules/left-pad/package.json': JSON.stringify({ name: 'left-pad', main: 'index.js' }),
    });
    const linked = await trySymlink(join(outside, 'secret.ts'), join(root, 'src', 'linked.ts'));
    const graph = await serviceFor(root).getDependencyGraph({ path: 'src/entry.ts' });
    expect(graph.external.map((entry) => entry.specifier)).toContain('left-pad');
    expect(graph.files).toEqual(['src/entry.ts']);
    if (linked) {
      expect(graph.unresolved).toContainEqual(
        expect.objectContaining({ specifier: './linked.js', reason: 'out_of_root' }),
      );
    }
  });

  it('reports diagnostics from a malformed dependency without failing the traversal', async () => {
    const graph = await graphOf(
      {
        'src/a.ts': "import './b.js';\n",
        'src/b.ts': 'export class Broken { method(: void {\n',
      },
      'src/a.ts',
    );
    expect(graph.files).toEqual(['src/a.ts', 'src/b.ts']);
    expect(graph.diagnostics[0]).toMatchObject({ file: 'src/b.ts', category: 'error' });
    expect(graph.complete).toBe(false);
  });
});
