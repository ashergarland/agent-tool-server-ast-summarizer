import { mkdtemp, mkdir, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

/** Creates a disposable workspace from an in-memory file map. Nothing is checked into the repo. */
export const createWorkspace = async (
  files: Record<string, string>,
  prefix = 'ast-test-',
): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), prefix));
  for (const [relativePath, content] of Object.entries(files)) {
    const target = join(root, relativePath);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content, 'utf8');
  }
  return root;
};

/**
 * Symbolic links require elevation or developer mode on Windows, so tests that depend on them are
 * skipped rather than failing on an unrelated platform restriction.
 */
export const trySymlink = async (
  target: string,
  path: string,
  type?: 'file' | 'dir',
): Promise<boolean> => {
  try {
    await symlink(target, path, type);
    return true;
  } catch {
    return false;
  }
};
