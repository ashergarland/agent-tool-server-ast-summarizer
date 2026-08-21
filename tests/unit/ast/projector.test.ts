import { describe, expect, it } from 'vitest';
import { supportedExtensions } from '../../../src/ast/language.js';
import { AstService } from '../../../src/ast/service.js';
import { defaultLimits, type AnalysisLimits } from '../../../src/ast/limits.js';
import { BoundedSemaphore } from '@agent-tool-platform/runtime/concurrency';
import { Workspace } from '../../../src/ast/workspace.js';
import { createWorkspace } from '../../helpers/workspace.js';

const serviceFor = (
  root: string,
  overrides: Partial<AnalysisLimits> = {},
  options: { typeInference?: 'off' | 'single-file'; includePrivateMembers?: boolean } = {},
): AstService => {
  const ceilings = { ...defaultLimits, ...overrides };
  return new AstService({
    workspace: new Workspace({
      root,
      maxFileBytes: ceilings.maxFileBytes,
      allowedExtensions: supportedExtensions,
    }),
    ceilings,
    semaphore: new BoundedSemaphore(2, 4),
    includePrivateMembers: options.includePrivateMembers ?? false,
    typeInference: options.typeInference ?? 'single-file',
  });
};

const skeletonOf = async (
  files: Record<string, string>,
  path: string,
  overrides: Partial<AnalysisLimits> = {},
  options: { typeInference?: 'off' | 'single-file'; includePrivateMembers?: boolean } = {},
) => {
  const root = await createWorkspace(files);
  return serviceFor(root, overrides, options).getFileSkeleton({ path });
};

const omissionKindsOf = (result: { omissions: { kind: string }[] }): string[] =>
  result.omissions.map((omission) => omission.kind);

describe('declaration projection', () => {
  it('keeps declarations and removes every body', async () => {
    const result = await skeletonOf(
      {
        'src/a.ts': `/** Service docs. */
export class Service {
  /** Looks up a value. */
  public async find(id: string): Promise<string> { return id; }
  get size(): number { return 1; }
  set size(value: number) { this.value = value; }
  constructor(readonly value: number) { this.value = value; }
}
export function make(id: string): string { return id; }
`,
      },
      'src/a.ts',
    );
    expect(result.skeleton).toContain('/** Service docs. */');
    expect(result.skeleton).toContain('export class Service {');
    expect(result.skeleton).toContain('public async find(id: string): Promise<string>;');
    expect(result.skeleton).toContain('get size(): number;');
    expect(result.skeleton).toContain('set size(value: number);');
    expect(result.skeleton).toContain('constructor(readonly value: number);');
    expect(result.skeleton).toContain('export function make(id: string): string;');
    expect(result.skeleton).not.toContain('return id');
    expect(result.complete).toBe(true);
    expect(result.truncated).toBe(false);
    expect(omissionKindsOf(result)).toEqual(
      expect.arrayContaining(['accessor_body', 'constructor_body', 'function_body', 'method_body']),
    );
  });

  it('never emits a variable, property, enum, parameter, or destructuring initializer', async () => {
    const result = await skeletonOf(
      {
        'src/a.ts': `export const token = "super-secret-token";
export class Holder {
  apiKey = "another-secret";
  static ratio = 0.125;
}
export enum Level { Low = "low-value", High = compute() }
export function call(retries = 41, { page = 7 } = {}): void {}
export const { alpha, beta = 99 } = load();
`,
      },
      'src/a.ts',
    );
    for (const value of [
      'super-secret-token',
      'another-secret',
      '0.125',
      'low-value',
      '41',
      '99',
      '7',
    ]) {
      expect(result.skeleton).not.toContain(value);
    }
    expect(result.skeleton).toContain('export const token: string;');
    expect(result.skeleton).toContain('Low,');
    expect(omissionKindsOf(result)).toEqual(
      expect.arrayContaining([
        'destructuring_initializer',
        'enum_member_initializer',
        'parameter_initializer',
        'property_initializer',
        'variable_initializer',
      ]),
    );
  });

  it('removes decorator arguments, static blocks, computed names, and heritage expressions', async () => {
    const result = await skeletonOf(
      {
        'src/a.ts': `@Component({ selector: 'app', token: process.env.SECRET })
export class Widget extends mixin(Base) implements Contract {
  static { register('side-effect'); }
  @Input({ required: true }) label: string;
  [lookupKey()]: string;
}
`,
      },
      'src/a.ts',
    );
    expect(result.skeleton).toContain('@Component');
    expect(result.skeleton).not.toContain('selector');
    expect(result.skeleton).not.toContain('process.env');
    expect(result.skeleton).not.toContain('side-effect');
    expect(result.skeleton).not.toContain('mixin(');
    expect(result.skeleton).toContain('implements Contract');
    expect(result.skeleton).toContain('[computed]');
    expect(omissionKindsOf(result)).toEqual(
      expect.arrayContaining([
        'computed_property_name',
        'decorator_arguments',
        'heritage_expression',
        'static_block',
      ]),
    );
    expect(result.warnings.map((warning) => warning.code)).toContain('heritage_expression_omitted');
  });

  it('strips export-default and export-equals expressions but keeps bare references', async () => {
    const withExpression = await skeletonOf(
      { 'src/a.ts': 'export default { key: "value", run: () => launch() };\n' },
      'src/a.ts',
    );
    expect(withExpression.skeleton).toBe('export default unknown;');
    expect(omissionKindsOf(withExpression)).toContain('export_assignment_expression');

    const withReference = await skeletonOf(
      { 'src/b.ts': 'function make(): void {}\nexport default make;\n' },
      'src/b.ts',
    );
    expect(withReference.skeleton).toContain('export default make;');

    const exportEquals = await skeletonOf(
      { 'src/c.ts': 'declare const api: number;\nexport = api;\n' },
      'src/c.ts',
    );
    expect(exportEquals.skeleton).toContain('export = api;');
  });

  it('preserves callable shape for exported arrow and function expressions', async () => {
    const result = await skeletonOf(
      {
        'src/a.ts': `export const add = (left: number, right: number): number => left + right;
export const later = async (id: string) => id;
export const legacy = function (flag: boolean) { return flag; };
export const built = class Inner {};
`,
      },
      'src/a.ts',
    );
    expect(result.skeleton).toContain('export const add: (left: number, right: number) => number;');
    expect(result.skeleton).toContain('export const later: (id: string) => Promise<unknown>;');
    expect(result.skeleton).toContain('export const legacy: (flag: boolean) => boolean;');
    expect(result.skeleton).toContain('export const built: unknown;');
    expect(result.skeleton).not.toContain('left + right');
    expect(omissionKindsOf(result)).toContain('class_expression_initializer');
  });

  it('falls back to unknown with a warning when inference is unavailable', async () => {
    const inferred = await skeletonOf(
      { 'src/a.ts': 'export const add = (left: number) => left + 1;\n' },
      'src/a.ts',
      {},
      { typeInference: 'off' },
    );
    expect(inferred.skeleton).toContain('export const add: (left: number) => unknown;');
    expect(inferred.warnings.map((warning) => warning.code)).toContain('return_type_not_resolved');
  });

  it('honours visibility defaults and the documented private option', async () => {
    const source = `export class Store {
  public open: boolean;
  protected level: number;
  private hidden: string;
  #secret: string;
}
`;
    const hidden = await skeletonOf({ 'src/a.ts': source }, 'src/a.ts');
    expect(hidden.skeleton).toContain('public open: boolean;');
    expect(hidden.skeleton).toContain('protected level: number;');
    expect(hidden.skeleton).not.toContain('hidden');
    expect(hidden.skeleton).not.toContain('#secret');
    expect(omissionKindsOf(hidden)).toContain('private_member');

    const shown = await skeletonOf(
      { 'src/a.ts': source },
      'src/a.ts',
      {},
      {
        includePrivateMembers: true,
      },
    );
    expect(shown.skeleton).toContain('private hidden: string;');
    expect(shown.skeleton).toContain('#secret: string;');
  });

  it('retains overloads, re-exports, namespaces, ambient modules, and type provenance', async () => {
    const result = await skeletonOf(
      {
        'src/types.ts': 'export interface User { id: string }\n',
        'src/a.ts': `import type { User } from './types.js';
import { unusedHelper } from './types.js';
export function pick(value: string): string;
export function pick(value: number): number;
export function pick(value: unknown): unknown { return value; }
export declare namespace Api { const version: string; }
declare module 'legacy-package' { export function boot(): void; }
export * as helpers from './types.js';
export { type User };
`,
      },
      'src/a.ts',
    );
    expect(result.skeleton).toContain('import type { User } from "./types.js";');
    expect(result.skeleton).not.toContain('unusedHelper');
    expect(result.skeleton.match(/export function pick/gu)).toHaveLength(3);
    expect(result.skeleton).toContain('namespace Api');
    expect(result.skeleton).toContain('declare module "legacy-package"');
    expect(result.skeleton).toContain('export * as helpers from "./types.js";');
    expect(result.skeleton).toContain('export { type User };');
  });

  it('reports a type annotation that contains a runtime expression as unknown', async () => {
    const result = await skeletonOf(
      { 'src/a.ts': 'export declare const value: { [Symbol.iterator]: string };\n' },
      'src/a.ts',
    );
    expect(result.skeleton).toContain('export declare const value: unknown;');
    expect(result.warnings.map((warning) => warning.code)).toContain(
      'type_contained_runtime_expression',
    );
  });

  it('supports every declared extension', async () => {
    const files: Record<string, string> = {
      'a.ts': 'export const a: number = 1;\n',
      'a.tsx': 'export const b: number = 1;\n',
      'a.mts': 'export const c: number = 1;\n',
      'a.cts': 'export const d: number = 1;\n',
      'a.js': 'export const e = 1;\n',
      'a.jsx': 'export const f = 1;\n',
      'a.mjs': 'export const g = 1;\n',
      'a.cjs': 'module.exports = { h: 1 };\n',
    };
    const typescriptPaths = new Set(['a.ts', 'a.tsx', 'a.mts', 'a.cts']);
    const root = await createWorkspace(files);
    const service = serviceFor(root);
    for (const path of Object.keys(files)) {
      const result = await service.getFileSkeleton({ path });
      expect(result.path).toBe(path);
      expect(result.language).toBe(typescriptPaths.has(path) ? 'typescript' : 'javascript');
      expect(result.skeleton.length).toBeGreaterThan(0);
    }
    expect([...supportedExtensions].sort()).toEqual(
      ['.cjs', '.cts', '.js', '.jsx', '.mjs', '.mts', '.ts', '.tsx'].sort(),
    );
  });

  it('describes common CommonJS export shapes without evaluating them', async () => {
    const result = await skeletonOf(
      {
        'lib.cjs': `function add(a, b) { return a + b; }
class Thing {}
module.exports = { add, Thing, ratio: 0.5, make: (n) => n * 2 };
exports.later = async function (value) { return value; };
`,
      },
      'lib.cjs',
    );
    expect(result.skeleton).toContain('module.exports: {');
    expect(result.skeleton).toContain('add: typeof add;');
    expect(result.skeleton).toContain('Thing: typeof Thing;');
    expect(result.skeleton).toContain('make: (n: unknown) => number;');
    expect(result.skeleton).toContain('exports.later: (value: unknown) => Promise<unknown>;');
    expect(result.skeleton).not.toContain('0.5');
    expect(result.skeleton).not.toContain('n * 2');
    expect(omissionKindsOf(result)).toContain('commonjs_export_unsupported');
  });

  it('reports malformed syntax as an incomplete recovery view', async () => {
    const result = await skeletonOf(
      { 'src/a.ts': 'export class Broken { method(: void {\nexport const x = ;\n' },
      'src/a.ts',
    );
    expect(result.complete).toBe(false);
    expect(result.diagnostics.length).toBeGreaterThan(0);
    expect(result.diagnostics[0]).toMatchObject({ category: 'error' });
    expect(result.warnings.map((warning) => warning.code)).toContain('parse_diagnostics_present');
  });

  it('reports non-module files instead of returning nothing', async () => {
    const result = await skeletonOf({ 'script.js': 'function run() {}\n' }, 'script.js');
    expect(result.skeleton).toContain('function run(): void;');
    expect(result.warnings.map((warning) => warning.code)).toContain('file_is_not_a_module');
  });

  it('counts discovered, returned, and omitted declarations', async () => {
    const result = await skeletonOf(
      {
        'src/a.ts': `export const a: number = 1;
const b = 2;
export const c: number = 3;
`,
      },
      'src/a.ts',
    );
    expect(result.metrics).toMatchObject({
      declarationsDiscovered: 3,
      declarationsReturned: 2,
      declarationsOmitted: 1,
    });
  });
});
