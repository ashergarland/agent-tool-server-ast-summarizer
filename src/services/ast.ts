import { realpath, readFile, stat } from 'node:fs/promises';
import { dirname, extname, relative, resolve, sep } from 'node:path';
import ts from 'typescript';
import { badRequest, forbidden, notFound } from '../errors.js';

const supportedExtensions = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs']);
const maximumFileSize = 5 * 1024 * 1024;

export interface FileSkeleton {
  readonly path: string;
  readonly language: 'typescript' | 'javascript';
  readonly skeleton: string;
  readonly originalLines: number;
  readonly skeletonLines: number;
}

export interface Dependency {
  readonly from: string;
  readonly to: string;
  readonly specifier: string;
}

export interface UnresolvedDependency {
  readonly from: string;
  readonly specifier: string;
}

export interface DependencyGraph {
  readonly entry: string;
  readonly files: readonly string[];
  readonly dependencies: readonly Dependency[];
  readonly unresolved: readonly UnresolvedDependency[];
}

const scriptKind = (path: string): ts.ScriptKind => {
  switch (extname(path).toLowerCase()) {
    case '.tsx':
      return ts.ScriptKind.TSX;
    case '.jsx':
      return ts.ScriptKind.JSX;
    case '.js':
    case '.mjs':
    case '.cjs':
      return ts.ScriptKind.JS;
    default:
      return ts.ScriptKind.TS;
  }
};

const isExported = (node: ts.Node): boolean =>
  (ts.getCombinedModifierFlags(node as ts.Declaration) & ts.ModifierFlags.Export) !== 0;

const stripClassMember = (member: ts.ClassElement): ts.ClassElement | undefined => {
  if (ts.isConstructorDeclaration(member)) {
    return ts.factory.updateConstructorDeclaration(member, member.modifiers, member.parameters, undefined);
  }
  if (ts.isMethodDeclaration(member)) {
    return ts.factory.updateMethodDeclaration(
      member,
      member.modifiers,
      member.asteriskToken,
      member.name,
      member.questionToken,
      member.typeParameters,
      member.parameters,
      member.type,
      undefined,
    );
  }
  if (ts.isGetAccessorDeclaration(member)) {
    return ts.factory.updateGetAccessorDeclaration(
      member,
      member.modifiers,
      member.name,
      member.parameters,
      member.type,
      undefined,
    );
  }
  if (ts.isSetAccessorDeclaration(member)) {
    return ts.factory.updateSetAccessorDeclaration(
      member,
      member.modifiers,
      member.name,
      member.parameters,
      undefined,
    );
  }
  if (ts.isPropertyDeclaration(member)) {
    return ts.factory.updatePropertyDeclaration(
      member,
      member.modifiers,
      member.name,
      member.questionToken ?? member.exclamationToken,
      member.type,
      undefined,
    );
  }
  if (ts.isClassStaticBlockDeclaration(member)) return undefined;
  return member;
};

const skeletonStatement = (statement: ts.Statement): ts.Statement | undefined => {
  if (ts.isFunctionDeclaration(statement)) {
    if (!isExported(statement)) return undefined;
    return ts.factory.updateFunctionDeclaration(
      statement,
      statement.modifiers,
      statement.asteriskToken,
      statement.name,
      statement.typeParameters,
      statement.parameters,
      statement.type,
      undefined,
    );
  }
  if (ts.isClassDeclaration(statement)) {
    const members = statement.members
      .map(stripClassMember)
      .filter((member): member is ts.ClassElement => member !== undefined);
    return ts.factory.updateClassDeclaration(
      statement,
      statement.modifiers,
      statement.name,
      statement.typeParameters,
      statement.heritageClauses,
      members,
    );
  }
  if (ts.isVariableStatement(statement)) {
    if (!isExported(statement)) return undefined;
    const declarations = statement.declarationList.declarations.map((declaration) =>
      ts.factory.updateVariableDeclaration(
        declaration,
        declaration.name,
        declaration.exclamationToken,
        declaration.type,
        undefined,
      ),
    );
    return ts.factory.updateVariableStatement(
      statement,
      statement.modifiers,
      ts.factory.updateVariableDeclarationList(statement.declarationList, declarations),
    );
  }
  if (
    ts.isInterfaceDeclaration(statement) ||
    ts.isTypeAliasDeclaration(statement) ||
    ts.isEnumDeclaration(statement) ||
    ts.isExportDeclaration(statement) ||
    ts.isExportAssignment(statement)
  ) {
    return statement;
  }
  return undefined;
};

const moduleSpecifiers = (sourceFile: ts.SourceFile): readonly string[] => {
  const values = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      values.add(node.moduleSpecifier.text);
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference) &&
      node.moduleReference.expression &&
      ts.isStringLiteral(node.moduleReference.expression)
    ) {
      values.add(node.moduleReference.expression.text);
    } else if (
      ts.isCallExpression(node) &&
      node.arguments.length === 1 &&
      ts.isStringLiteral(node.arguments[0]!) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === 'require'))
    ) {
      values.add(node.arguments[0]!.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return [...values];
};

export class AstService {
  private readonly root: string;
  private readonly compilerOptions: ts.CompilerOptions = {
    allowJs: true,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    module: ts.ModuleKind.NodeNext,
  };

  public constructor(root: string = process.cwd()) {
    this.root = resolve(root);
  }

  public async getFileSkeleton(filePath: string): Promise<FileSkeleton> {
    const path = await this.resolveInputFile(filePath);
    const content = await this.readSource(path);
    const sourceFile = ts.createSourceFile(
      path,
      content,
      ts.ScriptTarget.Latest,
      true,
      scriptKind(path),
    );
    const statements = sourceFile.statements
      .map(skeletonStatement)
      .filter((statement): statement is ts.Statement => statement !== undefined);
    const skeletonFile = ts.factory.updateSourceFile(sourceFile, statements);
    const skeleton = ts.createPrinter({ newLine: ts.NewLineKind.LineFeed })
      .printFile(skeletonFile)
      .trim();
    return {
      path: this.relativePath(path),
      language: ['.js', '.jsx', '.mjs', '.cjs'].includes(extname(path).toLowerCase())
        ? 'javascript'
        : 'typescript',
      skeleton,
      originalLines: content === '' ? 0 : content.split(/\r?\n/u).length,
      skeletonLines: skeleton === '' ? 0 : skeleton.split('\n').length,
    };
  }

  public async getDependencyGraph(filePath: string, maxDepth: number): Promise<DependencyGraph> {
    const entryPath = await this.resolveInputFile(filePath);
    const files: string[] = [];
    const dependencies: Dependency[] = [];
    const unresolved: UnresolvedDependency[] = [];
    const visited = new Set<string>();
    const queue: { path: string; depth: number }[] = [{ path: entryPath, depth: 0 }];

    while (queue.length > 0) {
      const current = queue.shift()!;
      if (visited.has(current.path)) continue;
      visited.add(current.path);
      const from = this.relativePath(current.path);
      files.push(from);
      const content = await this.readSource(current.path);
      const sourceFile = ts.createSourceFile(
        current.path,
        content,
        ts.ScriptTarget.Latest,
        true,
        scriptKind(current.path),
      );
      for (const specifier of moduleSpecifiers(sourceFile)) {
        if (!specifier.startsWith('.')) continue;
        const target = await this.resolveLocalModule(specifier, current.path);
        if (!target) {
          unresolved.push({ from, specifier });
          continue;
        }
        dependencies.push({ from, to: this.relativePath(target), specifier });
        if (current.depth < maxDepth && !visited.has(target)) {
          queue.push({ path: target, depth: current.depth + 1 });
        }
      }
    }

    return {
      entry: this.relativePath(entryPath),
      files,
      dependencies,
      unresolved,
    };
  }

  private async resolveInputFile(filePath: string): Promise<string> {
    const candidate = resolve(this.root, filePath);
    let path: string;
    try {
      path = await realpath(candidate);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw notFound(`File not found: ${filePath}`);
      }
      throw error;
    }
    await this.assertWithinRoot(path);
    if (!supportedExtensions.has(extname(path).toLowerCase())) {
      throw badRequest(`Unsupported source file extension: ${extname(path) || '(none)'}`);
    }
    const metadata = await stat(path);
    if (!metadata.isFile()) throw badRequest(`Path is not a file: ${filePath}`);
    return path;
  }

  private async readSource(path: string): Promise<string> {
    const metadata = await stat(path);
    if (metadata.size > maximumFileSize) {
      throw badRequest(`Source file exceeds the ${maximumFileSize}-byte limit`);
    }
    return readFile(path, 'utf8');
  }

  private async resolveLocalModule(specifier: string, containingFile: string): Promise<string | undefined> {
    const resolved = ts.resolveModuleName(
      specifier,
      containingFile,
      this.compilerOptions,
      ts.sys,
    ).resolvedModule?.resolvedFileName;
    if (!resolved || !supportedExtensions.has(extname(resolved).toLowerCase())) return undefined;
    try {
      const path = await realpath(resolved);
      await this.assertWithinRoot(path);
      return path;
    } catch {
      return undefined;
    }
  }

  private async assertWithinRoot(path: string): Promise<void> {
    const root = await realpath(this.root);
    const pathFromRoot = relative(root, path);
    if (pathFromRoot === '..' || pathFromRoot.startsWith(`..${sep}`) || resolve(path) === root) {
      throw forbidden('Source paths must remain within the configured workspace root');
    }
  }

  private relativePath(path: string): string {
    return relative(this.root, path).split(sep).join('/');
  }
}
