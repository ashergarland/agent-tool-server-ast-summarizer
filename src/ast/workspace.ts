import { stat } from 'node:fs/promises';
import {
  badRequest,
  forbidden,
  limitExceeded,
  notReady,
} from '@agent-tool-platform/runtime/errors';
import {
  createRootBoundary,
  extensionOf,
  type ResolvedPath,
  type RootBoundary,
} from '@agent-tool-platform/runtime/fs';

/**
 * AST workspace policy.
 *
 * The generic mechanics — canonical root resolution, relative-input enforcement, symlink
 * containment, realpath handling, regular-file validation, bounded reads, and the per-file byte
 * ceiling — belong to the platform's {@link RootBoundary}. What stays here is the part that is
 * genuinely about analysing source: which extensions are analysable, that installed package
 * directories are out of scope, and the readiness vocabulary an AST deployment reports.
 *
 * Absolute paths are never revealed to callers.
 */

export { extensionOf };

export interface WorkspaceFile extends ResolvedPath {
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

const nodeModulesSegment = /(^|[\\/])node_modules([\\/]|$)/u;

/** Installed package directories are out of scope for this server, at input and after resolution. */
const assertOutsidePackageDirectories = (path: string): void => {
  if (nodeModulesSegment.test(path)) {
    throw forbidden('Installed package directories are out of scope for this server');
  }
};

export class Workspace {
  private readonly boundary: RootBoundary;

  public constructor(private readonly options: WorkspaceOptions) {
    this.boundary = createRootBoundary({
      root: options.root,
      maxFileBytes: options.maxFileBytes,
    });
  }

  public get configured(): boolean {
    return this.boundary.configured;
  }

  public get maxFileBytes(): number {
    return this.options.maxFileBytes;
  }

  /** Canonicalizes the readable root exactly once and caches the successful result. */
  public async root(): Promise<string> {
    if (!this.boundary.configured) {
      throw notReady('No workspace root is configured; set AST_WORKSPACE_ROOT');
    }
    return this.boundary.root();
  }

  /** Readiness input. Never reads or lists source files. */
  public async status(): Promise<WorkspaceStatus> {
    const status = await this.boundary.status();
    if (!status.configured) {
      return { usable: false, configured: false, reason: 'workspace_root_not_configured' };
    }
    return status.usable
      ? { usable: true, configured: true }
      : { usable: false, configured: true, reason: 'workspace_root_unusable' };
  }

  public formatRelative(root: string, realPath: string): string {
    return this.boundary.formatRelative(root, realPath);
  }

  /**
   * Containment test that tolerates mixed path separators. `includeRoot` allows the root directory
   * itself, which module resolution needs when it probes the top of the workspace.
   */
  public isWithin(root: string, path: string, includeRoot = false): boolean {
    return this.boundary.isWithin(root, path, includeRoot);
  }

  public isSupportedExtension(path: string): boolean {
    return this.options.allowedExtensions.has(extensionOf(path));
  }

  /**
   * Resolves caller input to a canonical, analysable source file beneath the root. Containment is
   * the boundary's job; deciding that the result is something this server will parse is not.
   */
  public async resolveFile(input: string): Promise<WorkspaceFile> {
    assertOutsidePackageDirectories(input);
    if (!this.boundary.configured) {
      throw notReady('No workspace root is configured; set AST_WORKSPACE_ROOT');
    }
    const resolved = await this.boundary.resolve(input);
    assertOutsidePackageDirectories(resolved.relativePath);
    if (!this.isSupportedExtension(resolved.realPath)) {
      const extension = extensionOf(resolved.realPath);
      throw badRequest(
        `Unsupported source file extension: ${extension === '' ? '(none)' : extension}`,
      );
    }
    const metadata = await stat(resolved.realPath);
    if (!metadata.isFile()) throw badRequest('The path is not a regular file');
    this.assertSizeWithinLimit(metadata.size);
    return { ...resolved, sizeBytes: metadata.size };
  }

  /** Reads a resolved file through a single descriptor, re-checking the size as it does. */
  public readFile(file: WorkspaceFile): Promise<{ text: string; bytes: number }> {
    return this.boundary.readFile(file);
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
