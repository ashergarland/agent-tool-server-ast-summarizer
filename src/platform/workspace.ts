import { constants } from 'node:fs';
import { open, realpath, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { badRequest, forbidden, limitExceeded, notFound, notReady } from '../errors.js';

/**
 * Filesystem policy for a single canonical workspace root.
 *
 * This module is deliberately free of compiler or AST imports so the boundary can be reused by
 * other tool servers later. It never reveals absolute paths to callers.
 */

export interface WorkspaceFile {
  /** Canonical absolute path. Never returned to callers. */
  readonly realPath: string;
  /** Root-relative POSIX path that is safe to return. */
  readonly relativePath: string;
  readonly sizeBytes: number;
}

export interface WorkspaceStatus {
  readonly usable: boolean;
  readonly configured: boolean;
  readonly reason?: string;
}

export interface WorkspaceOptions {
  /** Absolute or relative directory. `undefined` means no workspace was configured. */
  readonly root: string | undefined;
  readonly maxFileBytes: number;
  readonly allowedExtensions: ReadonlySet<string>;
}

const unusableRoot = (reason: string): Error =>
  notReady(`The configured workspace root is unusable: ${reason}`);

export const extensionOf = (path: string): string => {
  const separatorIndex = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  const name = path.slice(separatorIndex + 1);
  const dotIndex = name.lastIndexOf('.');
  return dotIndex <= 0 ? '' : name.slice(dotIndex).toLowerCase();
};

const nodeModulesSegment = /(^|[\\/])node_modules([\\/]|$)/u;

/** Rejects absolute inputs, drive-relative inputs, NUL bytes, UNC paths, and package internals. */
const assertAcceptableInput = (input: string): void => {
  if (input.length === 0) throw badRequest('The path must not be empty');
  if (input.includes('\0')) throw badRequest('The path must not contain NUL bytes');
  if (input.startsWith('\\\\') || input.startsWith('//')) {
    throw badRequest('UNC paths are not supported');
  }
  if (isAbsolute(input) || /^[a-zA-Z]:/u.test(input)) {
    throw badRequest('The path must be relative to the workspace root');
  }
  if (nodeModulesSegment.test(input)) {
    throw forbidden('Installed package directories are out of scope for this server');
  }
};

export class Workspace {
  private canonicalRoot: Promise<string> | undefined;

  public constructor(private readonly options: WorkspaceOptions) {}

  public get configured(): boolean {
    return this.options.root !== undefined;
  }

  public get maxFileBytes(): number {
    return this.options.maxFileBytes;
  }

  /** Canonicalizes the readable root exactly once and caches the successful result. */
  public async root(): Promise<string> {
    const configured = this.options.root;
    if (configured === undefined) {
      throw notReady('No workspace root is configured; set AST_WORKSPACE_ROOT');
    }
    this.canonicalRoot ??= (async (): Promise<string> => {
      let canonical: string;
      try {
        canonical = await realpath(resolve(configured));
      } catch {
        throw unusableRoot('it cannot be resolved');
      }
      let metadata;
      try {
        metadata = await stat(canonical);
      } catch {
        throw unusableRoot('it cannot be read');
      }
      if (!metadata.isDirectory()) throw unusableRoot('it is not a directory');
      return canonical;
    })().catch((error: unknown) => {
      this.canonicalRoot = undefined;
      throw error;
    });
    return this.canonicalRoot;
  }

  /** Readiness input. Never reads or lists source files. */
  public async status(): Promise<WorkspaceStatus> {
    if (!this.configured) {
      return { usable: false, configured: false, reason: 'workspace_root_not_configured' };
    }
    try {
      await this.root();
      return { usable: true, configured: true };
    } catch {
      return { usable: false, configured: true, reason: 'workspace_root_unusable' };
    }
  }

  /** Formats a canonical path as a root-relative POSIX path, or throws when it escapes. */
  public formatRelative(root: string, realPath: string): string {
    const fromRoot = relative(root, realPath);
    if (
      fromRoot === '' ||
      fromRoot === '..' ||
      fromRoot.startsWith(`..${sep}`) ||
      isAbsolute(fromRoot)
    ) {
      throw forbidden('Source paths must remain within the configured workspace root');
    }
    return fromRoot.split(sep).join('/');
  }

  /**
   * Containment test that tolerates mixed path separators. `includeRoot` allows the root directory
   * itself, which module resolution needs when it probes the top of the workspace.
   */
  public isWithin(root: string, path: string, includeRoot = false): boolean {
    if (includeRoot && resolve(path) === resolve(root)) return true;
    try {
      this.formatRelative(root, path);
      return true;
    } catch {
      return false;
    }
  }

  public isSupportedExtension(path: string): boolean {
    return this.options.allowedExtensions.has(extensionOf(path));
  }

  /**
   * Resolves caller input to a canonical file strictly beneath the root. Symlinks are resolved
   * before containment is checked, so a link that escapes the root is rejected.
   */
  public async resolveFile(input: string): Promise<WorkspaceFile> {
    assertAcceptableInput(input);
    const root = await this.root();
    const candidate = resolve(root, input);
    let realPath: string;
    try {
      realPath = await realpath(candidate);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ENOTDIR') throw notFound('File not found');
      if (code === 'EACCES' || code === 'EPERM') throw forbidden('File is not readable');
      if (code === 'ELOOP') throw badRequest('The path contains a symbolic link loop');
      throw badRequest('The path could not be resolved');
    }
    const relativePath = this.formatRelative(root, realPath);
    if (nodeModulesSegment.test(relativePath)) {
      throw forbidden('Installed package directories are out of scope for this server');
    }
    if (!this.isSupportedExtension(realPath)) {
      const extension = extensionOf(realPath);
      throw badRequest(
        `Unsupported source file extension: ${extension === '' ? '(none)' : extension}`,
      );
    }
    const metadata = await stat(realPath);
    if (!metadata.isFile()) throw badRequest('The path is not a regular file');
    this.assertSizeWithinLimit(metadata.size);
    return { realPath, relativePath, sizeBytes: metadata.size };
  }

  /**
   * Reads a resolved file through a single descriptor. The size is re-checked on the open
   * descriptor, so a file that grows between resolution and reading cannot exceed the limit.
   */
  public async readFile(file: WorkspaceFile): Promise<{ text: string; bytes: number }> {
    const noFollow = typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0;
    const handle = await open(file.realPath, constants.O_RDONLY | noFollow).catch(
      (error: unknown) => {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'ELOOP' || code === 'EMLINK') {
          throw forbidden('Source paths must remain within the configured workspace root');
        }
        if (code === 'ENOENT') throw notFound('File not found');
        throw forbidden('File is not readable');
      },
    );
    try {
      const metadata = await handle.stat();
      if (!metadata.isFile()) throw badRequest('The path is not a regular file');
      this.assertSizeWithinLimit(metadata.size);
      const buffer = await handle.readFile();
      this.assertSizeWithinLimit(buffer.byteLength);
      return { text: buffer.toString('utf8'), bytes: buffer.byteLength };
    } finally {
      await handle.close();
    }
  }

  private assertSizeWithinLimit(size: number): void {
    if (size > this.options.maxFileBytes) {
      throw limitExceeded(
        `Source file exceeds the ${this.options.maxFileBytes} byte per-file limit`,
        { limit: 'maxFileBytes', maxFileBytes: this.options.maxFileBytes },
      );
    }
  }
}
