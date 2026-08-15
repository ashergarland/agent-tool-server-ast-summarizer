import ts from 'typescript';

/**
 * Type rendering.
 *
 * Type syntax is retained because it is the contract an agent needs, but every type node is
 * validated first: any node that could carry runtime behaviour causes the type to be reported as
 * `unknown` rather than printed.
 */

export const unknownType = 'unknown';

const printer = ts.createPrinter({
  removeComments: true,
  newLine: ts.NewLineKind.LineFeed,
  omitTrailingSemicolon: true,
});

const isNegatedNumericLiteral = (node: ts.PrefixUnaryExpression): boolean =>
  (node.operator === ts.SyntaxKind.MinusToken || node.operator === ts.SyntaxKind.PlusToken) &&
  (ts.isNumericLiteral(node.operand) || ts.isBigIntLiteral(node.operand));

/**
 * True when the subtree contains a construct that can express runtime behaviour. Literal types,
 * type queries, and import types are permitted because they carry no evaluation.
 */
export const containsRuntimeExpression = (node: ts.Node): boolean => {
  let found = false;
  const visit = (current: ts.Node): void => {
    if (found) return;
    if (ts.isPrefixUnaryExpression(current)) {
      if (!isNegatedNumericLiteral(current)) found = true;
      return;
    }
    if (
      ts.isCallExpression(current) ||
      ts.isNewExpression(current) ||
      ts.isTaggedTemplateExpression(current) ||
      ts.isTemplateExpression(current) ||
      ts.isFunctionExpression(current) ||
      ts.isArrowFunction(current) ||
      ts.isClassExpression(current) ||
      ts.isAwaitExpression(current) ||
      ts.isYieldExpression(current) ||
      ts.isBinaryExpression(current) ||
      ts.isConditionalExpression(current) ||
      ts.isObjectLiteralExpression(current) ||
      ts.isArrayLiteralExpression(current) ||
      ts.isSpreadElement(current) ||
      ts.isDeleteExpression(current) ||
      ts.isTypeOfExpression(current) ||
      ts.isVoidExpression(current) ||
      ts.isNonNullExpression(current) ||
      ts.isPostfixUnaryExpression(current) ||
      ts.isPropertyAccessExpression(current) ||
      ts.isElementAccessExpression(current) ||
      ts.isCommaListExpression(current)
    ) {
      found = true;
      return;
    }
    ts.forEachChild(current, visit);
  };
  visit(node);
  return found;
};

export interface TypeRenderOptions {
  readonly maxTypeChars: number;
  onUnsafeType(reason: string): void;
}

const normalize = (text: string): string => text.replace(/\s+/gu, ' ').trim();

/** Prints a validated type node structurally, without comments and without original formatting. */
export const renderTypeNode = (
  typeNode: ts.TypeNode | undefined,
  sourceFile: ts.SourceFile,
  options: TypeRenderOptions,
): string | undefined => {
  if (!typeNode) return undefined;
  if (containsRuntimeExpression(typeNode)) {
    options.onUnsafeType('type_contained_runtime_expression');
    return unknownType;
  }
  const text = normalize(printer.printNode(ts.EmitHint.Unspecified, typeNode, sourceFile));
  if (text.length === 0) return unknownType;
  if (text.length > options.maxTypeChars) {
    options.onUnsafeType('type_exceeded_length_limit');
    return unknownType;
  }
  return text;
};

export interface TypeResolver {
  /** An inferred, widened type name, or undefined when inference is unavailable or unsafe. */
  inferredTypeOf(node: ts.Node): string | undefined;
  /** The inferred return type of a callable declaration, or undefined when unavailable. */
  inferredReturnTypeOf(node: ts.SignatureDeclaration): string | undefined;
}

export const noTypeResolver: TypeResolver = {
  inferredTypeOf: () => undefined,
  inferredReturnTypeOf: () => undefined,
};

/** Inferred type text must never restate a literal value from the source. */
const looksLikeAValue = (text: string): boolean =>
  /["'`]/u.test(text) || /(^|[^\w$.])-?\d/u.test(text);

/**
 * Type inference limited to one already-loaded file.
 *
 * The program has no lib, no module resolution, and no additional root files, so a single type
 * query can never pull an entire project into memory.
 */
export class SingleFileTypeResolver implements TypeResolver {
  private readonly checker: ts.TypeChecker;

  public constructor(
    private readonly sourceFile: ts.SourceFile,
    private readonly maxTypeChars: number,
  ) {
    const fileName = sourceFile.fileName;
    const host: ts.CompilerHost = {
      getSourceFile: (name) => (name === fileName ? sourceFile : undefined),
      getDefaultLibFileName: () => 'lib.d.ts',
      writeFile: () => undefined,
      getCurrentDirectory: () => '',
      getDirectories: () => [],
      fileExists: (name) => name === fileName,
      readFile: (name) => (name === fileName ? sourceFile.text : undefined),
      getCanonicalFileName: (name) => name,
      useCaseSensitiveFileNames: () => true,
      getNewLine: () => '\n',
    };
    const program = ts.createProgram({
      rootNames: [fileName],
      options: {
        noLib: true,
        noResolve: true,
        allowJs: true,
        checkJs: false,
        types: [],
        skipLibCheck: true,
        skipDefaultLibCheck: true,
      },
      host,
    });
    this.checker = program.getTypeChecker();
  }

  public inferredTypeOf(node: ts.Node): string | undefined {
    if (node.getSourceFile() !== this.sourceFile) return undefined;
    try {
      const type = this.checker.getTypeAtLocation(node);
      return this.render(
        this.checker.getWidenedType(this.checker.getBaseTypeOfLiteralType(type)),
        node,
      );
    } catch {
      return undefined;
    }
  }

  public inferredReturnTypeOf(node: ts.SignatureDeclaration): string | undefined {
    if (node.getSourceFile() !== this.sourceFile) return undefined;
    try {
      const signature = this.checker.getSignatureFromDeclaration(node);
      if (!signature) return undefined;
      const returnType = this.checker.getReturnTypeOfSignature(signature);
      return this.render(
        this.checker.getWidenedType(this.checker.getBaseTypeOfLiteralType(returnType)),
        node,
      );
    } catch {
      return undefined;
    }
  }

  private render(type: ts.Type, node: ts.Node): string | undefined {
    const text = normalize(
      this.checker.typeToString(
        type,
        node,
        ts.TypeFormatFlags.NoTruncation | ts.TypeFormatFlags.UseSingleQuotesForStringLiteralType,
      ),
    );
    if (text.length === 0 || text.length > this.maxTypeChars) return undefined;
    if (text === 'error' || text === 'unknown') return undefined;
    // An `any`-bearing inferred type carries no contract information worth returning.
    if (/\bany\b/u.test(text)) return undefined;
    return looksLikeAValue(text) ? undefined : text;
  }
}
