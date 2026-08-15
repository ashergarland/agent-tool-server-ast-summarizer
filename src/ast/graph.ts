import { relative } from 'node:path';
import ts from 'typescript';
import type { Cancellation } from '../platform/cancellation.js';
import type { Budget } from '../platform/limits.js';
import type { WarningCollector } from '../platform/warnings.js';
import { extensionOf, type Workspace, type WorkspaceFile } from '../platform/workspace.js';
import { parseDiagnosticCount, parseDiagnosticsOf, type ParseDiagnostic } from './diagnostics.js';
import { parseSourceFile, supportedExtensions } from './language.js';
import { loadProjectConfiguration } from './project-config.js';

export type DependencyKind = 'import' | 'export' | 'require' | 'dynamic-import' | 'import-equals';

export type UnresolvedReason = 'missing' | 'unsupported' | 'out_of_root' | 'limit_stopped';

export interface ResolvedDependency {
  readonly from: string;
  readonly to: string;
  readonly specifier: string;
  readonly kind: DependencyKind;
  /** False when a limit stopped the traversal before the target was analysed. */
  readonly traversed: boolean;
}

export interface ExternalDependency {
  readonly from: string;
  readonly specifier: string;
  readonly kind: DependencyKind;
}

export interface UnresolvedDependency {
  readonly from: string;
  readonly specifier: string;
  readonly kind: DependencyKind;
  readonly reason: UnresolvedReason;
}

export interface GraphOptions {
  readonly workspace: Workspace;
  readonly root: string;
  readonly budget: Budget;
  readonly warnings: WarningCollector;
  readonly cancellation: Cancellation;
  readonly maxDiagnostics: number;
}

export interface GraphDiagnostic extends ParseDiagnostic {
  readonly file: string;
}

export interface GraphAnalysis {
  readonly entry: string;
  readonly files: readonly string[];
  readonly dependencies: readonly ResolvedDependency[];
  readonly external: readonly ExternalDependency[];
  readonly unresolved: readonly UnresolvedDependency[];
  readonly configPath: string | undefined;
  readonly diagnostics: readonly GraphDiagnostic[];
  readonly sourceBytes: number;
}

interface SpecifierReference {
  readonly specifier: string;
  readonly kind: DependencyKind;
}

const isRelative = (specifier: string): boolean =>
  specifier.startsWith('./') ||
  specifier.startsWith('../') ||
  specifier === '.' ||
  specifier === '..';

const nodeModulesSegment = /(^|[\\/])node_modules([\\/]|$)/u;

/** Collects module specifiers in source order, de-duplicated by specifier and reference kind. */
export const moduleSpecifiersOf = (sourceFile: ts.SourceFile): readonly SpecifierReference[] => {
  const found: SpecifierReference[] = [];
  const seen = new Set<string>();
  const add = (specifier: string, kind: DependencyKind): void => {
    const key = `${kind}\u0000${specifier}`;
    if (specifier.length === 0 || seen.has(key)) return;
    seen.add(key);
    found.push({ specifier, kind });
  };
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      add(node.moduleSpecifier.text, 'import');
    } else if (
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      add(node.moduleSpecifier.text, 'export');
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference) &&
      ts.isStringLiteral(node.moduleReference.expression)
    ) {
      add(node.moduleReference.expression.text, 'import-equals');
    } else if (
      ts.isCallExpression(node) &&
      node.arguments.length >= 1 &&
      node.arguments[0] !== undefined &&
      ts.isStringLiteral(node.arguments[0])
    ) {
      const first = node.arguments[0];
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        add(first.text, 'dynamic-import');
      } else if (ts.isIdentifier(node.expression) && node.expression.text === 'require') {
        add(first.text, 'require');
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return found;
};

/**
 * Breadth-first traversal of local source relationships.
 *
 * Ordering is deterministic: files are visited in breadth-first order and each file's specifiers
 * are processed in source order. The queue is indexed rather than shifted so a wide graph does not
 * degrade into repeated array copies.
 */
export const analyseDependencyGraph = async (
  entry: WorkspaceFile,
  options: GraphOptions,
): Promise<GraphAnalysis> => {
  const { workspace, root, budget, warnings, cancellation } = options;
  const project = loadProjectConfiguration(workspace, root, entry.realPath, warnings);
  const resolutionCache = ts.createModuleResolutionCache(root, (name) => name, project.options);
  const usesPathMapping =
    project.options.paths !== undefined || project.options.baseUrl !== undefined;
  const restrictedHost: ts.ModuleResolutionHost = {
    fileExists: (path) => workspace.isWithin(root, path) && ts.sys.fileExists(path),
    readFile: (path) => (workspace.isWithin(root, path) ? ts.sys.readFile(path) : undefined),
    directoryExists: (path) => workspace.isWithin(root, path, true) && ts.sys.directoryExists(path),
    getDirectories: (path) =>
      workspace.isWithin(root, path, true) ? ts.sys.getDirectories(path) : [],
    ...(ts.sys.realpath === undefined
      ? {}
      : { realpath: (path: string): string => ts.sys.realpath?.(path) ?? path }),
    useCaseSensitiveFileNames: ts.sys.useCaseSensitiveFileNames,
  };

  const files: string[] = [];
  const dependencies: ResolvedDependency[] = [];
  const external: ExternalDependency[] = [];
  const unresolved: UnresolvedDependency[] = [];
  const diagnostics: GraphDiagnostic[] = [];
  const visited = new Set<string>([entry.realPath]);
  const queue: { file: WorkspaceFile; depth: number }[] = [{ file: entry, depth: 0 }];
  let head = 0;
  let sourceBytes = 0;
  let edges = 0;

  const recordEdge = (): boolean => {
    if (!budget.allows('maxEdges', edges)) return false;
    edges += 1;
    return true;
  };

  while (head < queue.length) {
    cancellation.throwIfCancelled();
    const current = queue[head];
    head += 1;
    if (!current) break;

    const source = await workspace.readFile(current.file);
    if (!budget.tryConsumeBytes(source.bytes)) break;
    sourceBytes += source.bytes;
    files.push(current.file.relativePath);

    const sourceFile = parseSourceFile(current.file.realPath, source.text);
    if (parseDiagnosticCount(sourceFile) > 0 && diagnostics.length < options.maxDiagnostics) {
      diagnostics.push(
        ...parseDiagnosticsOf(sourceFile, options.maxDiagnostics - diagnostics.length).map(
          (diagnostic) => ({ ...diagnostic, file: current.file.relativePath }),
        ),
      );
      warnings.add(
        'parse_diagnostics_present',
        'At least one file failed to parse cleanly, so its relationships may be incomplete',
      );
    }

    for (const reference of moduleSpecifiersOf(sourceFile)) {
      cancellation.throwIfCancelled();
      const from = current.file.relativePath;
      if (!recordEdge()) {
        unresolved.push({
          from,
          specifier: reference.specifier,
          kind: reference.kind,
          reason: 'limit_stopped',
        });
        break;
      }
      if (!isRelative(reference.specifier) && !usesPathMapping) {
        external.push({ from, specifier: reference.specifier, kind: reference.kind });
        continue;
      }
      const resolved = ts.resolveModuleName(
        reference.specifier,
        current.file.realPath,
        project.options,
        restrictedHost,
        resolutionCache,
      ).resolvedModule?.resolvedFileName;
      if (resolved === undefined) {
        if (!isRelative(reference.specifier)) {
          external.push({ from, specifier: reference.specifier, kind: reference.kind });
          continue;
        }
        unresolved.push({
          from,
          specifier: reference.specifier,
          kind: reference.kind,
          reason: 'missing',
        });
        continue;
      }
      if (nodeModulesSegment.test(resolved)) {
        external.push({ from, specifier: reference.specifier, kind: reference.kind });
        continue;
      }
      if (!supportedExtensions.has(extensionOf(resolved))) {
        unresolved.push({
          from,
          specifier: reference.specifier,
          kind: reference.kind,
          reason: 'unsupported',
        });
        continue;
      }
      let target: WorkspaceFile;
      try {
        target = await workspace.resolveFile(relative(root, resolved));
      } catch {
        unresolved.push({
          from,
          specifier: reference.specifier,
          kind: reference.kind,
          reason: 'out_of_root',
        });
        continue;
      }
      const withinDepth = current.depth < budget.limits.maxDepth;
      const alreadyQueued = visited.has(target.realPath);
      const hasFileCapacity = alreadyQueued || budget.allows('maxFiles', queue.length);
      const traversable = withinDepth && hasFileCapacity;
      if (!withinDepth) budget.markReached('maxDepth');
      dependencies.push({
        from,
        to: target.relativePath,
        specifier: reference.specifier,
        kind: reference.kind,
        traversed: alreadyQueued || traversable,
      });
      if (traversable && !alreadyQueued) {
        visited.add(target.realPath);
        queue.push({ file: target, depth: current.depth + 1 });
      }
    }
  }

  return {
    entry: entry.relativePath,
    files,
    dependencies,
    external,
    unresolved,
    configPath: project.configPath,
    diagnostics,
    sourceBytes,
  };
};
