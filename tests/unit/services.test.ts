import { mkdtemp, mkdir, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createApplication } from '../../src/app.js';
import { createServices } from '../../src/services/index.js';
import { testConfig } from '../helpers/config.js';

const fixture = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), 'ast-summarizer-'));
  await mkdir(join(root, 'src'));
  await writeFile(
    join(root, 'src', 'types.ts'),
    'export interface User { id: string; }\nexport const version = "1";\n',
  );
  await writeFile(
    join(root, 'src', 'main.ts'),
    `import type { User } from './types.js';
/** Public service. */
export class UserService {
  private count = 1;
  /** Look up a user. */
  public async getUser(id: string): Promise<User> {
    for (const value of [id]) console.log(value);
    return { id };
  }
}
export function createUser(id: string): User { return { id }; }
function hidden(): void { console.log('hidden'); }
export const arrow = (value: number) => value + 1;
`,
  );
  return root;
};

describe('AST service', () => {
  it('returns declarations without implementation bodies', async () => {
    const root = await fixture();
    const skeleton = await createServices(testConfig(), root).ast.getFileSkeleton('src/main.ts');
    expect(skeleton).toMatchObject({
      path: 'src/main.ts',
      language: 'typescript',
      originalLines: 14,
    });
    expect(skeleton.skeleton).toContain('/** Public service. */');
    expect(skeleton.skeleton).toContain('export class UserService');
    expect(skeleton.skeleton).toContain('getUser(id: string): Promise<User>;');
    expect(skeleton.skeleton).toContain('export function createUser(id: string): User;');
    expect(skeleton.skeleton).toContain('export const arrow;');
    expect(skeleton.skeleton).not.toContain('return { id }');
    expect(skeleton.skeleton).not.toContain('hidden');
  });

  it('maps local dependencies recursively and reports unresolved imports', async () => {
    const root = await fixture();
    await writeFile(join(root, 'src', 'types.ts'), "export * from './missing.js';\n");
    const graph = await createServices(testConfig(), root).ast.getDependencyGraph(
      'src/main.ts',
      20,
    );
    expect(graph.entry).toBe('src/main.ts');
    expect(graph.files).toEqual(['src/main.ts', 'src/types.ts']);
    expect(graph.dependencies).toContainEqual({
      from: 'src/main.ts',
      to: 'src/types.ts',
      specifier: './types.js',
    });
    expect(graph.unresolved).toContainEqual({
      from: 'src/types.ts',
      specifier: './missing.js',
    });
  });

  it('rejects missing, unsupported, and out-of-root paths', async () => {
    const root = await fixture();
    await writeFile(join(root, 'notes.txt'), 'text');
    const outside = await mkdtemp(join(tmpdir(), 'ast-outside-'));
    await writeFile(join(outside, 'secret.ts'), 'export const secret = true;');
    await symlink(join(outside, 'secret.ts'), join(root, 'linked.ts'));
    const ast = createServices(testConfig(), root).ast;
    await expect(ast.getFileSkeleton('missing.ts')).rejects.toMatchObject({ code: 'not_found' });
    await expect(ast.getFileSkeleton('notes.txt')).rejects.toMatchObject({ code: 'bad_request' });
    await expect(ast.getFileSkeleton('linked.ts')).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('wires an injectable application', async () => {
    const root = await fixture();
    const application = createApplication({
      config: testConfig(),
      workspaceRoot: root,
    });
    expect(application.registry.list()).toHaveLength(2);
    await application.http.close();
  });
});
