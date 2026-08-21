import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { supportedExtensions } from '../../../src/ast/language.js';
import { Workspace } from '../../../src/ast/workspace.js';
import { createWorkspace, trySymlink } from '../../helpers/workspace.js';

/**
 * AST workspace policy over the platform root boundary. Generic containment is proven by the
 * testkit's root-boundary conformance; what is asserted here is the part AST owns.
 */
const workspaceFor = (root: string | undefined, maxFileBytes = 1_048_576): Workspace =>
  new Workspace({ root, maxFileBytes, allowedExtensions: supportedExtensions });

describe('AST workspace', () => {
  it('canonicalizes the root once and returns relative paths beneath it', async () => {
    const root = await createWorkspace({ 'src/index.ts': 'export const a = 1;\n' });
    const workspace = workspaceFor(root);
    const file = await workspace.resolveFile('src/index.ts');
    expect(file.relativePath).toBe('src/index.ts');
    expect(await workspace.root()).toBe(await workspace.root());
    expect((await workspace.status()).usable).toBe(true);
  });

  it('accepts Unicode and nested path segments', async () => {
    const root = await createWorkspace({ 'src/ünïcødé/ファイル.ts': 'export const a = 1;\n' });
    const file = await workspaceFor(root).resolveFile('src/ünïcødé/ファイル.ts');
    expect(file.relativePath).toBe('src/ünïcødé/ファイル.ts');
  });

  it('rejects traversal, absolute paths, UNC paths, and NUL bytes', async () => {
    const root = await createWorkspace({ 'a.ts': 'export const a = 1;\n' });
    const workspace = workspaceFor(root);
    await expect(workspace.resolveFile('../outside.ts')).rejects.toMatchObject({
      code: 'not_found',
    });
    await expect(workspace.resolveFile('/etc/passwd')).rejects.toMatchObject({
      code: 'bad_request',
    });
    await expect(workspace.resolveFile('C:\\Windows\\win.ini')).rejects.toMatchObject({
      code: 'bad_request',
    });
    await expect(workspace.resolveFile('\\\\server\\share\\a.ts')).rejects.toMatchObject({
      code: 'bad_request',
    });
    await expect(workspace.resolveFile('a\0.ts')).rejects.toMatchObject({ code: 'bad_request' });
    await expect(workspace.resolveFile('')).rejects.toMatchObject({ code: 'bad_request' });
  });

  it('rejects traversal to a real file outside the root', async () => {
    const root = await createWorkspace({ 'a.ts': 'export const a = 1;\n' });
    const outside = await mkdtemp(join(tmpdir(), 'ast-outside-real-'));
    await writeFile(join(outside, 'secret.ts'), 'export const secret = true;\n');
    const workspace = workspaceFor(root);
    const escape = relative(root, join(outside, 'secret.ts'));
    await expect(workspace.resolveFile(escape)).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('keeps installed package directories out of scope', async () => {
    const root = await createWorkspace({
      'node_modules/left-pad/index.js': 'module.exports = 1;\n',
      'a.ts': 'export const a = 1;\n',
    });
    const workspace = workspaceFor(root);
    await expect(workspace.resolveFile('node_modules/left-pad/index.js')).rejects.toMatchObject({
      code: 'forbidden',
    });
  });

  it('rejects unsupported extensions and directories', async () => {
    const root = await createWorkspace({
      'notes.txt': 'text',
      'src/a.ts': 'export const a = 1;\n',
    });
    const workspace = workspaceFor(root);
    await expect(workspace.resolveFile('notes.txt')).rejects.toMatchObject({
      code: 'bad_request',
    });
    await expect(workspace.resolveFile('src')).rejects.toMatchObject({ code: 'bad_request' });
    await expect(workspace.resolveFile('missing.ts')).rejects.toMatchObject({ code: 'not_found' });
    expect(workspace.isSupportedExtension('a.tsx')).toBe(true);
    expect(workspace.isSupportedExtension('a.json')).toBe(false);
  });

  it('rejects a symbolic link that escapes the root', async () => {
    const root = await createWorkspace({ 'a.ts': 'export const a = 1;\n' });
    const outside = await mkdtemp(join(tmpdir(), 'ast-outside-'));
    await writeFile(join(outside, 'secret.ts'), 'export const secret = true;\n');
    const linked = await trySymlink(join(outside, 'secret.ts'), join(root, 'linked.ts'), 'file');
    if (!linked) return;
    await expect(workspaceFor(root).resolveFile('linked.ts')).rejects.toMatchObject({
      code: 'forbidden',
    });
  });

  it('allows a symbolic link that stays inside the root', async () => {
    const root = await createWorkspace({ 'src/real.ts': 'export const a = 1;\n' });
    const linked = await trySymlink(join(root, 'src', 'real.ts'), join(root, 'alias.ts'), 'file');
    if (!linked) return;
    const file = await workspaceFor(root).resolveFile('alias.ts');
    expect(file.relativePath).toBe('src/real.ts');
  });

  it('reports an unconfigured or unusable root in AST readiness terms', async () => {
    const unconfigured = workspaceFor(undefined);
    expect(unconfigured.configured).toBe(false);
    await expect(unconfigured.root()).rejects.toMatchObject({ code: 'not_ready' });
    await expect(unconfigured.resolveFile('a.ts')).rejects.toMatchObject({ code: 'not_ready' });
    expect(await unconfigured.status()).toMatchObject({
      usable: false,
      reason: 'workspace_root_not_configured',
    });

    const missing = workspaceFor(join(tmpdir(), 'ast-root-that-does-not-exist-12345'));
    expect(await missing.status()).toMatchObject({
      usable: false,
      configured: true,
      reason: 'workspace_root_unusable',
    });
    await expect(missing.resolveFile('a.ts')).rejects.toMatchObject({ code: 'not_ready' });
  });

  it('refuses a root that is a file rather than a directory', async () => {
    const root = await createWorkspace({ 'a.ts': 'export const a = 1;\n' });
    const workspace = workspaceFor(join(root, 'a.ts'));
    expect(await workspace.status()).toMatchObject({ usable: false });
  });

  it('enforces the per-file byte limit on resolution and on the open descriptor', async () => {
    const root = await createWorkspace({ 'big.ts': `export const a = "${'x'.repeat(200)}";\n` });
    const workspace = workspaceFor(root, 64);
    await expect(workspace.resolveFile('big.ts')).rejects.toMatchObject({
      code: 'limit_exceeded',
    });

    const generous = workspaceFor(root, 10_000);
    const file = await generous.resolveFile('big.ts');
    const strict = workspaceFor(root, 64);
    await expect(strict.readFile(file)).rejects.toMatchObject({ code: 'limit_exceeded' });
  });

  it('reads through a single descriptor and reports byte counts', async () => {
    const root = await createWorkspace({ 'a.ts': 'export const a = 1;\n' });
    const workspace = workspaceFor(root);
    const file = await workspace.resolveFile('a.ts');
    const source = await workspace.readFile(file);
    expect(source.text).toContain('export const a');
    expect(source.bytes).toBe(file.sizeBytes);
  });
});
