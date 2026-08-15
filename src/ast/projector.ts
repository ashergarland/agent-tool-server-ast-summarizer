import ts from 'typescript';
import type { Cancellation } from '../platform/cancellation.js';
import type { Budget } from '../platform/limits.js';
import type { WarningCollector } from '../platform/warnings.js';
import { noTypeResolver, renderTypeNode, unknownType, type TypeResolver } from './type-text.js';

/**
 * Safe declaration projection.
 *
 * Nothing here reuses an original statement node. Every retained construct is re-rendered from an
 * explicit whitelist of structural pieces (modifier keywords, names, type syntax, signatures), so
 * no initializer, decorator argument, heritage expression, or body can survive into the output.
 */

export const omissionKinds = [
  'accessor_body',
  'class_expression_initializer',
  'commonjs_export_unsupported',
  'computed_property_name',
  'constructor_body',
  'decorator_arguments',
  'destructuring_initializer',
  'enum_member_initializer',
  'executable_statement',
  'export_assignment_expression',
  'function_body',
  'heritage_expression',
  'member_limit_reached',
  'method_body',
  'parameter_initializer',
  'private_member',
  'property_initializer',
  'static_block',
  'variable_initializer',
] as const;

export type OmissionKind = (typeof omissionKinds)[number];

export interface Omission {
  readonly kind: OmissionKind;
  readonly count: number;
}

export interface ProjectionResult {
  readonly text: string;
  readonly declarationsDiscovered: number;
  readonly declarationsReturned: number;
  readonly declarationsOmitted: number;
  readonly omissions: readonly Omission[];
}

export interface ProjectorOptions {
  readonly includePrivateMembers: boolean;
  readonly maxTypeChars: number;
  readonly typeResolver?: TypeResolver;
  readonly cancellation?: Cancellation;
}

const modifierKeywords: ReadonlyMap<ts.SyntaxKind, string> = new Map([
  [ts.SyntaxKind.ExportKeyword, 'export'],
  [ts.SyntaxKind.DefaultKeyword, 'default'],
  [ts.SyntaxKind.DeclareKeyword, 'declare'],
  [ts.SyntaxKind.AbstractKeyword, 'abstract'],
  [ts.SyntaxKind.AsyncKeyword, 'async'],
  [ts.SyntaxKind.StaticKeyword, 'static'],
  [ts.SyntaxKind.ReadonlyKeyword, 'readonly'],
  [ts.SyntaxKind.PublicKeyword, 'public'],
  [ts.SyntaxKind.ProtectedKeyword, 'protected'],
  [ts.SyntaxKind.PrivateKeyword, 'private'],
  [ts.SyntaxKind.OverrideKeyword, 'override'],
  [ts.SyntaxKind.AccessorKeyword, 'accessor'],
  [ts.SyntaxKind.ConstKeyword, 'const'],
  [ts.SyntaxKind.InKeyword, 'in'],
  [ts.SyntaxKind.OutKeyword, 'out'],
]);

const computedNamePlaceholder = '[computed]';
const unnamedPlaceholder = '[unnamed]';

const quote = (value: string): string => JSON.stringify(value);

const indentLines = (lines: readonly string[], depth: number): string[] =>
  lines.map((line) => (line === '' ? '' : `${'  '.repeat(depth)}${line}`));

/** A rendered top-level declaration. */
const isIgnorableStatement = (statement: ts.Statement): boolean =>
  ts.isImportDeclaration(statement) || ts.isEmptyStatement(statement);

export class DeclarationProjector {
  private readonly omissions = new Map<OmissionKind, number>();
  private readonly typeResolver: TypeResolver;

  public constructor(
    private readonly sourceFile: ts.SourceFile,
    private readonly budget: Budget,
    private readonly warnings: WarningCollector,
    private readonly options: ProjectorOptions,
  ) {
    this.typeResolver = options.typeResolver ?? noTypeResolver;
  }

  public project(): ProjectionResult {
    const isModule = ts.isExternalModule(this.sourceFile);
    if (!isModule) {
      this.warnings.add(
        'file_is_not_a_module',
        'The file declares no imports or exports, so every top-level declaration is reported',
      );
    }
    const blocks: string[][] = [];
    let discovered = 0;
    let returned = 0;

    for (const statement of this.sourceFile.statements) {
      this.options.cancellation?.throwIfCancelled();
      if (!this.isDeclarationLike(statement)) {
        if (!isIgnorableStatement(statement)) this.record('executable_statement');
        continue;
      }
      discovered += 1;
      if (!this.budget.allows('maxDeclarations', returned)) continue;
      const lines = this.renderStatement(statement, isModule);
      if (!lines || lines.length === 0) continue;
      blocks.push(lines);
      returned += 1;
    }

    const provenance = this.provenanceImports(blocks);
    const assembled = this.assemble(provenance, blocks);
    return {
      text: assembled.text,
      declarationsDiscovered: discovered,
      declarationsReturned: returned - assembled.dropped,
      declarationsOmitted: discovered - (returned - assembled.dropped),
      omissions: [...this.omissions.entries()]
        .map(([kind, count]) => ({ kind, count }))
        .sort((left, right) => left.kind.localeCompare(right.kind)),
    };
  }

  /** Drops whole declarations from the end until the rendered result fits the character budget. */
  private assemble(
    provenance: readonly string[],
    blocks: readonly string[][],
  ): { text: string; dropped: number } {
    const limit = this.budget.limits.maxResultChars;
    const header = provenance.length === 0 ? '' : `${provenance.join('\n')}\n\n`;
    const kept: string[][] = [];
    let size = header.length;
    let dropped = 0;
    for (const block of blocks) {
      const rendered = `${block.join('\n')}\n\n`;
      if (size + rendered.length > limit) {
        this.budget.markReached('maxResultChars');
        dropped = blocks.length - kept.length;
        break;
      }
      size += rendered.length;
      kept.push(block);
    }
    const body = kept.map((block) => block.join('\n')).join('\n\n');
    const text = `${header}${body}`.trim();
    return { text: text.length > limit ? '' : text, dropped };
  }

  private isDeclarationLike(statement: ts.Statement): boolean {
    return (
      ts.isFunctionDeclaration(statement) ||
      ts.isClassDeclaration(statement) ||
      ts.isInterfaceDeclaration(statement) ||
      ts.isTypeAliasDeclaration(statement) ||
      ts.isEnumDeclaration(statement) ||
      ts.isVariableStatement(statement) ||
      ts.isModuleDeclaration(statement) ||
      ts.isExportDeclaration(statement) ||
      ts.isExportAssignment(statement) ||
      ts.isImportEqualsDeclaration(statement) ||
      this.commonJsExportOf(statement) !== undefined
    );
  }

  private isExported(node: ts.Node): boolean {
    return (
      (ts.getCombinedModifierFlags(node as ts.Declaration) & ts.ModifierFlags.Export) !== 0 ||
      (ts.getCombinedModifierFlags(node as ts.Declaration) & ts.ModifierFlags.Ambient) !== 0
    );
  }

  private renderStatement(statement: ts.Statement, isModule: boolean): string[] | undefined {
    const include = !isModule || this.isExported(statement);
    if (ts.isFunctionDeclaration(statement)) {
      return include ? this.renderFunction(statement) : undefined;
    }
    if (ts.isClassDeclaration(statement)) return include ? this.renderClass(statement) : undefined;
    if (ts.isInterfaceDeclaration(statement)) {
      return include ? this.renderInterface(statement) : undefined;
    }
    if (ts.isTypeAliasDeclaration(statement)) {
      return include ? this.renderTypeAlias(statement) : undefined;
    }
    if (ts.isEnumDeclaration(statement)) return include ? this.renderEnum(statement) : undefined;
    if (ts.isVariableStatement(statement)) {
      return include ? this.renderVariableStatement(statement) : undefined;
    }
    if (ts.isModuleDeclaration(statement)) return this.renderModule(statement);
    if (ts.isExportDeclaration(statement)) return this.renderExportDeclaration(statement);
    if (ts.isExportAssignment(statement)) return this.renderExportAssignment(statement);
    if (ts.isImportEqualsDeclaration(statement)) return this.renderImportEquals(statement);
    const commonJs = this.commonJsExportOf(statement);
    return commonJs ? this.renderCommonJsExport(commonJs) : undefined;
  }

  // ---------------------------------------------------------------- shared pieces

  private record(kind: OmissionKind): void {
    this.omissions.set(kind, (this.omissions.get(kind) ?? 0) + 1);
  }

  private type(node: ts.TypeNode | undefined): string | undefined {
    return renderTypeNode(node, this.sourceFile, {
      maxTypeChars: this.options.maxTypeChars,
      onUnsafeType: (reason) =>
        this.warnings.add(
          reason,
          reason === 'type_contained_runtime_expression'
            ? 'A type annotation contained a runtime expression and was reported as unknown'
            : 'A type annotation exceeded the length limit and was reported as unknown',
        ),
    });
  }

  private declaredOrInferredType(annotation: ts.TypeNode | undefined, node: ts.Node): string {
    const declared = this.type(annotation);
    if (declared !== undefined) return declared;
    const inferred = this.typeResolver.inferredTypeOf(node);
    if (inferred !== undefined) return inferred;
    this.warnings.add(
      'type_not_resolved',
      'A type was neither annotated nor safely inferable and is reported as unknown',
    );
    return unknownType;
  }

  private returnType(node: ts.SignatureDeclaration): string {
    const declared = this.type(node.type);
    if (declared !== undefined) return declared;
    const inferred = this.typeResolver.inferredReturnTypeOf(node);
    if (inferred !== undefined) return inferred;
    this.warnings.add(
      'return_type_not_resolved',
      'A return type was neither annotated nor safely inferable and is reported as unknown',
    );
    return unknownType;
  }

  /** Modifier keywords, read from the node's own modifier list rather than from source text. */
  private modifiers(node: ts.Node): string[] {
    const modifiers = ts.canHaveModifiers(node)
      ? (ts.getModifiers(node) ?? [])
      : ((node as { modifiers?: ts.NodeArray<ts.ModifierLike> }).modifiers ?? []).filter(
          (modifier): modifier is ts.Modifier => !ts.isDecorator(modifier),
        );
    return modifiers
      .map((modifier) => modifierKeywords.get(modifier.kind))
      .filter((keyword): keyword is string => keyword !== undefined);
  }

  /** Decorators keep their name for orientation; every argument expression is dropped. */
  private decorators(node: ts.Node): string[] {
    const decorators = ts.canHaveDecorators(node) ? (ts.getDecorators(node) ?? []) : [];
    const rendered: string[] = [];
    for (const decorator of decorators) {
      const expression = ts.isCallExpression(decorator.expression)
        ? decorator.expression.expression
        : decorator.expression;
      if (ts.isCallExpression(decorator.expression)) this.record('decorator_arguments');
      const name = this.entityNameOf(expression);
      if (name === undefined) {
        this.record('decorator_arguments');
        continue;
      }
      rendered.push(`@${name}`);
    }
    return rendered;
  }

  /** Returns a dotted name for an identifier or property-access chain of identifiers only. */
  private entityNameOf(node: ts.Node): string | undefined {
    if (ts.isIdentifier(node)) return node.text;
    if (ts.isQualifiedName(node)) {
      const left = this.entityNameOf(node.left);
      return left === undefined ? undefined : `${left}.${node.right.text}`;
    }
    if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.name)) {
      const left = this.entityNameOf(node.expression);
      return left === undefined ? undefined : `${left}.${node.name.text}`;
    }
    return undefined;
  }

  private propertyName(name: ts.PropertyName | undefined): string {
    if (!name) return computedNamePlaceholder;
    if (ts.isIdentifier(name) || ts.isPrivateIdentifier(name)) {
      return name.text === '' ? unnamedPlaceholder : name.text;
    }
    if (ts.isStringLiteral(name)) return quote(name.text);
    if (ts.isNumericLiteral(name)) return name.text;
    if (ts.isComputedPropertyName(name)) {
      const expression = name.expression;
      if (ts.isStringLiteral(expression)) return `[${quote(expression.text)}]`;
      if (ts.isNumericLiteral(expression)) return `[${expression.text}]`;
      this.record('computed_property_name');
      return computedNamePlaceholder;
    }
    return computedNamePlaceholder;
  }

  private bindingName(name: ts.BindingName): string {
    if (ts.isIdentifier(name)) return name.text === '' ? unnamedPlaceholder : name.text;
    if (ts.isObjectBindingPattern(name)) {
      const elements = name.elements.map((element) => {
        if (element.initializer) this.record('destructuring_initializer');
        const property = element.propertyName ? `${this.propertyName(element.propertyName)}: ` : '';
        const dots = element.dotDotDotToken ? '...' : '';
        return `${dots}${property}${this.bindingName(element.name)}`;
      });
      return `{ ${elements.join(', ')} }`;
    }
    const elements = name.elements.map((element) => {
      if (ts.isOmittedExpression(element)) return '';
      if (element.initializer) this.record('destructuring_initializer');
      const dots = element.dotDotDotToken ? '...' : '';
      return `${dots}${this.bindingName(element.name)}`;
    });
    return `[${elements.join(', ')}]`;
  }

  private typeParameters(
    parameters: ts.NodeArray<ts.TypeParameterDeclaration> | undefined,
  ): string {
    if (!parameters || parameters.length === 0) return '';
    const rendered = parameters.map((parameter) => {
      const modifiers = this.modifiers(parameter);
      const prefix = modifiers.length === 0 ? '' : `${modifiers.join(' ')} `;
      const constraint = this.type(parameter.constraint);
      const fallback = this.type(parameter.default);
      return [
        `${prefix}${parameter.name.text}`,
        constraint === undefined ? '' : ` extends ${constraint}`,
        fallback === undefined ? '' : ` = ${fallback}`,
      ].join('');
    });
    return `<${rendered.join(', ')}>`;
  }

  private parameters(parameters: ts.NodeArray<ts.ParameterDeclaration>): string {
    return parameters
      .map((parameter) => {
        const decorators = this.decorators(parameter);
        const modifiers = this.modifiers(parameter);
        const prefix = [...decorators, ...modifiers].join(' ');
        const dots = parameter.dotDotDotToken ? '...' : '';
        const name = this.bindingName(parameter.name);
        if (parameter.initializer) this.record('parameter_initializer');
        const optional =
          parameter.questionToken !== undefined || parameter.initializer !== undefined;
        const type = this.declaredOrInferredType(parameter.type, parameter.name);
        return `${prefix === '' ? '' : `${prefix} `}${dots}${name}${optional ? '?' : ''}: ${type}`;
      })
      .join(', ');
  }

  private signature(node: ts.SignatureDeclaration): string {
    return `${this.typeParameters(node.typeParameters)}(${this.parameters(node.parameters)}): ${this.returnType(node)}`;
  }

  /** Retains the leading documentation comment, bounded and truncated at a line boundary. */
  private jsDoc(node: ts.Node): string[] {
    const blocks = ts
      .getJSDocCommentsAndTags(node)
      .filter((entry): entry is ts.JSDoc => entry.kind === ts.SyntaxKind.JSDoc)
      .filter((entry) => entry.getSourceFile() === this.sourceFile);
    if (blocks.length === 0) return [];
    const text = blocks
      .map((block) => block.getText(this.sourceFile))
      .join('\n')
      .replace(/\r\n/gu, '\n');
    const limit = this.budget.limits.maxJsDocChars;
    if (text.length <= limit) return text.split('\n').map((line) => line.trimEnd());
    this.budget.markReached('maxJsDocChars');
    this.warnings.add('jsdoc_truncated', 'Documentation was truncated by the maxJsDocChars limit');
    const lines: string[] = [];
    let used = 0;
    for (const line of text.split('\n')) {
      if (used + line.length > limit) break;
      used += line.length + 1;
      lines.push(line.trimEnd());
    }
    lines.push(' * ... documentation truncated', ' */');
    return lines;
  }

  private head(node: ts.Node, keyword: string, rest: string): string {
    const parts = [...this.modifiers(node), keyword, rest].filter((part) => part !== '');
    return parts.join(' ');
  }

  // ---------------------------------------------------------------- declarations

  private renderFunction(node: ts.FunctionDeclaration): string[] {
    if (node.body) this.record('function_body');
    const asterisk = node.asteriskToken ? '*' : '';
    const name = node.name?.text ?? (this.modifiers(node).includes('default') ? '' : 'anonymous');
    return [
      ...this.jsDoc(node),
      ...this.decorators(node),
      `${this.head(node, `function${asterisk}`, `${name}${this.signature(node)}`)};`,
    ];
  }

  private renderClass(node: ts.ClassDeclaration): string[] {
    const heritage = this.heritage(node.heritageClauses);
    const header = this.head(
      node,
      'class',
      `${node.name?.text ?? ''}${this.typeParameters(node.typeParameters)}${heritage}`,
    );
    const members = this.classMembers(node.members);
    return [
      ...this.jsDoc(node),
      ...this.decorators(node),
      `${header} {`,
      ...indentLines(members, 1),
      '}',
    ];
  }

  /** Only entity-name heritage survives; `extends mixin(Base)` is dropped and recorded. */
  private heritage(clauses: ts.NodeArray<ts.HeritageClause> | undefined): string {
    if (!clauses || clauses.length === 0) return '';
    const rendered: string[] = [];
    for (const clause of clauses) {
      const keyword = clause.token === ts.SyntaxKind.ExtendsKeyword ? 'extends' : 'implements';
      const names: string[] = [];
      for (const type of clause.types) {
        const name = this.entityNameOf(type.expression);
        if (name === undefined) {
          this.record('heritage_expression');
          this.warnings.add(
            'heritage_expression_omitted',
            'A base type was produced by a runtime expression and was omitted',
          );
          continue;
        }
        const typeArguments = type.typeArguments
          ?.map((argument) => this.type(argument) ?? unknownType)
          .join(', ');
        names.push(typeArguments === undefined ? name : `${name}<${typeArguments}>`);
      }
      if (names.length > 0) rendered.push(`${keyword} ${names.join(', ')}`);
    }
    return rendered.length === 0 ? '' : ` ${rendered.join(' ')}`;
  }

  private isHiddenMember(member: ts.ClassElement): boolean {
    if (this.options.includePrivateMembers) return false;
    if (member.name && ts.isPrivateIdentifier(member.name)) return true;
    const flags = ts.getCombinedModifierFlags(member);
    return (flags & ts.ModifierFlags.Private) !== 0;
  }

  private classMembers(members: ts.NodeArray<ts.ClassElement>): string[] {
    const lines: string[] = [];
    let retained = 0;
    for (const member of members) {
      this.options.cancellation?.throwIfCancelled();
      if (ts.isClassStaticBlockDeclaration(member)) {
        this.record('static_block');
        continue;
      }
      if (ts.isSemicolonClassElement(member)) continue;
      if (this.isHiddenMember(member)) {
        this.record('private_member');
        continue;
      }
      if (!this.budget.allows('maxMembersPerDeclaration', retained)) {
        this.record('member_limit_reached');
        break;
      }
      const rendered = this.classMember(member);
      if (!rendered) continue;
      lines.push(...rendered);
      retained += 1;
    }
    return lines;
  }

  private classMember(member: ts.ClassElement): string[] | undefined {
    const documentation = this.jsDoc(member);
    const decorators = this.decorators(member);
    if (ts.isConstructorDeclaration(member)) {
      if (member.body) this.record('constructor_body');
      return [
        ...documentation,
        ...decorators,
        `${this.head(member, 'constructor', '')}(${this.parameters(member.parameters)});`,
      ];
    }
    if (ts.isMethodDeclaration(member)) {
      if (member.body) this.record('method_body');
      const asterisk = member.asteriskToken ? '*' : '';
      const optional = member.questionToken ? '?' : '';
      const name = `${asterisk}${this.propertyName(member.name)}${optional}`;
      return [
        ...documentation,
        ...decorators,
        `${this.head(member, '', `${name}${this.signature(member)}`)};`,
      ];
    }
    if (ts.isGetAccessorDeclaration(member)) {
      if (member.body) this.record('accessor_body');
      return [
        ...documentation,
        ...decorators,
        `${this.head(member, 'get', `${this.propertyName(member.name)}(): ${this.returnType(member)}`)};`,
      ];
    }
    if (ts.isSetAccessorDeclaration(member)) {
      if (member.body) this.record('accessor_body');
      return [
        ...documentation,
        ...decorators,
        `${this.head(member, 'set', `${this.propertyName(member.name)}(${this.parameters(member.parameters)})`)};`,
      ];
    }
    if (ts.isPropertyDeclaration(member)) {
      if (member.initializer) this.record('property_initializer');
      const optional = member.questionToken ? '?' : '';
      const type = this.declaredOrInferredType(member.type, member.name);
      return [
        ...documentation,
        ...decorators,
        `${this.head(member, '', `${this.propertyName(member.name)}${optional}: ${type}`)};`,
      ];
    }
    if (ts.isIndexSignatureDeclaration(member)) {
      return [
        ...documentation,
        `${this.head(member, '', `[${this.parameters(member.parameters)}]: ${this.returnType(member)}`)};`,
      ];
    }
    return undefined;
  }

  private renderInterface(node: ts.InterfaceDeclaration): string[] {
    const header = this.head(
      node,
      'interface',
      `${node.name.text}${this.typeParameters(node.typeParameters)}${this.heritage(node.heritageClauses)}`,
    );
    return [
      ...this.jsDoc(node),
      `${header} {`,
      ...indentLines(this.typeMembers(node.members), 1),
      '}',
    ];
  }

  private typeMembers(members: ts.NodeArray<ts.TypeElement>): string[] {
    const lines: string[] = [];
    let retained = 0;
    for (const member of members) {
      if (!this.budget.allows('maxMembersPerDeclaration', retained)) {
        this.record('member_limit_reached');
        break;
      }
      const documentation = this.jsDoc(member);
      if (ts.isPropertySignature(member)) {
        const optional = member.questionToken ? '?' : '';
        const type = this.type(member.type) ?? unknownType;
        lines.push(
          ...documentation,
          `${this.head(member, '', `${this.propertyName(member.name)}${optional}: ${type}`)};`,
        );
      } else if (ts.isMethodSignature(member)) {
        const optional = member.questionToken ? '?' : '';
        lines.push(
          ...documentation,
          `${this.propertyName(member.name)}${optional}${this.signature(member)};`,
        );
      } else if (ts.isCallSignatureDeclaration(member)) {
        lines.push(...documentation, `${this.signature(member)};`);
      } else if (ts.isConstructSignatureDeclaration(member)) {
        lines.push(...documentation, `new ${this.signature(member)};`);
      } else if (ts.isIndexSignatureDeclaration(member)) {
        lines.push(
          ...documentation,
          `${this.head(member, '', `[${this.parameters(member.parameters)}]: ${this.returnType(member)}`)};`,
        );
      } else if (ts.isGetAccessorDeclaration(member)) {
        lines.push(
          ...documentation,
          `get ${this.propertyName(member.name)}(): ${this.returnType(member)};`,
        );
      } else if (ts.isSetAccessorDeclaration(member)) {
        lines.push(
          ...documentation,
          `set ${this.propertyName(member.name)}(${this.parameters(member.parameters)});`,
        );
      } else {
        continue;
      }
      retained += 1;
    }
    return lines;
  }

  private renderTypeAlias(node: ts.TypeAliasDeclaration): string[] {
    const alias = this.type(node.type) ?? unknownType;
    return [
      ...this.jsDoc(node),
      `${this.head(node, 'type', `${node.name.text}${this.typeParameters(node.typeParameters)} = ${alias}`)};`,
    ];
  }

  /** Enum member values are initializers and are always omitted, never restated. */
  private renderEnum(node: ts.EnumDeclaration): string[] {
    const members: string[] = [];
    let retained = 0;
    for (const member of node.members) {
      if (!this.budget.allows('maxMembersPerDeclaration', retained)) {
        this.record('member_limit_reached');
        break;
      }
      if (member.initializer) this.record('enum_member_initializer');
      members.push(...this.jsDoc(member), `${this.propertyName(member.name)},`);
      retained += 1;
    }
    return [
      ...this.jsDoc(node),
      `${this.head(node, 'enum', node.name.text)} {`,
      ...indentLines(members, 1),
      '}',
    ];
  }

  private renderVariableStatement(node: ts.VariableStatement): string[] {
    const keyword =
      (node.declarationList.flags & ts.NodeFlags.Const) !== 0
        ? 'const'
        : (node.declarationList.flags & ts.NodeFlags.Let) !== 0
          ? 'let'
          : 'var';
    const lines: string[] = [...this.jsDoc(node)];
    for (const declaration of node.declarationList.declarations) {
      const name = this.bindingName(declaration.name);
      const type = this.variableType(declaration);
      lines.push(`${this.head(node, keyword, `${name}: ${type}`)};`);
    }
    return lines;
  }

  /**
   * Preserves the callable shape of an exported arrow or function expression so a signature is
   * never reduced to a bare name.
   */
  private variableType(declaration: ts.VariableDeclaration): string {
    const declared = this.type(declaration.type);
    const initializer = declaration.initializer;
    if (initializer) this.record('variable_initializer');
    if (declared !== undefined) return declared;
    if (initializer && (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer))) {
      const isAsync = this.modifiers(initializer).includes('async');
      const declaredReturn = this.type(initializer.type);
      const inferredReturn = declaredReturn ?? this.typeResolver.inferredReturnTypeOf(initializer);
      if (inferredReturn === undefined) {
        this.warnings.add(
          'return_type_not_resolved',
          'A return type was neither annotated nor safely inferable and is reported as unknown',
        );
      }
      const returnType = inferredReturn ?? (isAsync ? 'Promise<unknown>' : unknownType);
      return `${this.typeParameters(initializer.typeParameters)}(${this.parameters(initializer.parameters)}) => ${returnType}`;
    }
    if (initializer && ts.isClassExpression(initializer)) {
      this.record('class_expression_initializer');
      this.warnings.add(
        'class_expression_initializer',
        'A class expression initializer was omitted and its type is reported as unknown',
      );
      return unknownType;
    }
    const inferred = this.typeResolver.inferredTypeOf(declaration.name);
    if (inferred !== undefined) return inferred;
    this.warnings.add(
      'type_not_resolved',
      'A type was neither annotated nor safely inferable and is reported as unknown',
    );
    return unknownType;
  }

  private renderModule(node: ts.ModuleDeclaration): string[] {
    const name = ts.isStringLiteral(node.name)
      ? quote(node.name.text)
      : node.name.text === 'global'
        ? 'global'
        : node.name.text;
    const keyword = ts.isStringLiteral(node.name)
      ? 'module'
      : (node.flags & ts.NodeFlags.Namespace) !== 0
        ? 'namespace'
        : 'module';
    const body = node.body;
    const inner: string[] = [];
    if (body && ts.isModuleBlock(body)) {
      let retained = 0;
      for (const statement of body.statements) {
        if (!this.budget.allows('maxMembersPerDeclaration', retained)) {
          this.record('member_limit_reached');
          break;
        }
        const rendered = this.renderStatement(statement, false);
        if (!rendered || rendered.length === 0) continue;
        if (inner.length > 0) inner.push('');
        inner.push(...rendered);
        retained += 1;
      }
    }
    const header = this.head(node, name === 'global' ? '' : keyword, name);
    return [...this.jsDoc(node), `${header} {`, ...indentLines(inner, 1), '}'];
  }

  private renderExportDeclaration(node: ts.ExportDeclaration): string[] {
    const typeOnly = node.isTypeOnly ? 'type ' : '';
    const from =
      node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)
        ? ` from ${quote(node.moduleSpecifier.text)}`
        : '';
    const clause = node.exportClause;
    if (!clause) return [`export ${typeOnly}*${from};`];
    if (ts.isNamespaceExport(clause)) {
      return [`export ${typeOnly}* as ${this.moduleExportName(clause.name)}${from};`];
    }
    const specifiers = clause.elements.map((element) => {
      const prefix = element.isTypeOnly ? 'type ' : '';
      const original = element.propertyName
        ? `${this.moduleExportName(element.propertyName)} as `
        : '';
      return `${prefix}${original}${this.moduleExportName(element.name)}`;
    });
    return [`export ${typeOnly}{ ${specifiers.join(', ')} }${from};`];
  }

  private moduleExportName(name: ts.ModuleExportName): string {
    return ts.isStringLiteral(name) ? quote(name.text) : name.text;
  }

  /** `export default <expr>` keeps only a bare reference; anything else becomes `unknown`. */
  private renderExportAssignment(node: ts.ExportAssignment): string[] {
    const keyword = node.isExportEquals ? 'export =' : 'export default';
    const reference = this.entityNameOf(node.expression);
    if (reference !== undefined) return [...this.jsDoc(node), `${keyword} ${reference};`];
    this.record('export_assignment_expression');
    this.warnings.add(
      'export_assignment_expression_omitted',
      'An export assignment expression was omitted and its type is reported as unknown',
    );
    return [...this.jsDoc(node), `${keyword} ${unknownType};`];
  }

  private renderImportEquals(node: ts.ImportEqualsDeclaration): string[] {
    const reference = ts.isExternalModuleReference(node.moduleReference)
      ? ts.isStringLiteral(node.moduleReference.expression)
        ? `require(${quote(node.moduleReference.expression.text)})`
        : unknownType
      : (this.entityNameOf(node.moduleReference) ?? unknownType);
    const prefix = this.modifiers(node).includes('export') ? 'export ' : '';
    return [`${prefix}import ${node.name.text} = ${reference};`];
  }

  // ---------------------------------------------------------------- CommonJS

  private commonJsExportOf(
    statement: ts.Statement,
  ): { target: string; value: ts.Expression } | undefined {
    if (!ts.isExpressionStatement(statement)) return undefined;
    const expression = statement.expression;
    if (
      !ts.isBinaryExpression(expression) ||
      expression.operatorToken.kind !== ts.SyntaxKind.EqualsToken ||
      !ts.isPropertyAccessExpression(expression.left)
    ) {
      return undefined;
    }
    const target = this.entityNameOf(expression.left);
    if (target === undefined) return undefined;
    if (target === 'module.exports') return { target, value: expression.right };
    if (target.startsWith('exports.') && target.split('.').length === 2) {
      return { target, value: expression.right };
    }
    return undefined;
  }

  /**
   * Supports the common `module.exports = {...}`, `module.exports = fn`, and `exports.name = ...`
   * shapes by describing their shape only. Anything else is reported as unsupported.
   */
  private renderCommonJsExport(assignment: { target: string; value: ts.Expression }): string[] {
    const { target, value } = assignment;
    if (ts.isObjectLiteralExpression(value) && target === 'module.exports') {
      const lines: string[] = [];
      let retained = 0;
      for (const property of value.properties) {
        if (!this.budget.allows('maxMembersPerDeclaration', retained)) {
          this.record('member_limit_reached');
          break;
        }
        if (property.name === undefined) {
          this.record('commonjs_export_unsupported');
          continue;
        }
        const name = this.propertyName(property.name);
        const initializer = ts.isPropertyAssignment(property)
          ? property.initializer
          : ts.isShorthandPropertyAssignment(property)
            ? property.name
            : undefined;
        lines.push(`${name}: ${this.commonJsValueShape(initializer, property)};`);
        retained += 1;
      }
      return ['module.exports: {', ...indentLines(lines, 1), '};'];
    }
    return [`${target}: ${this.commonJsValueShape(value, value)};`];
  }

  private commonJsValueShape(value: ts.Expression | undefined, node: ts.Node): string {
    if (value && (ts.isArrowFunction(value) || ts.isFunctionExpression(value))) {
      const isAsync = this.modifiers(value).includes('async');
      const returnType =
        this.type(value.type) ??
        this.typeResolver.inferredReturnTypeOf(value) ??
        (isAsync ? 'Promise<unknown>' : unknownType);
      return `${this.typeParameters(value.typeParameters)}(${this.parameters(value.parameters)}) => ${returnType}`;
    }
    if (value && ts.isIdentifier(value)) {
      const inferred = this.typeResolver.inferredTypeOf(value);
      return inferred ?? `typeof ${value.text}`;
    }
    if (value && ts.isClassExpression(value)) {
      this.record('class_expression_initializer');
      return unknownType;
    }
    this.record('commonjs_export_unsupported');
    this.warnings.add(
      'commonjs_export_unsupported',
      'A CommonJS export value could not be described without evaluating it',
    );
    const inferred = this.typeResolver.inferredTypeOf(node);
    return inferred ?? unknownType;
  }

  // ---------------------------------------------------------------- provenance

  /** Emits the import statements whose local names are actually referenced by the projection. */
  private provenanceImports(blocks: readonly string[][]): string[] {
    const referenced = new Set<string>();
    for (const block of blocks) {
      for (const line of block) {
        for (const match of line.matchAll(/[A-Za-z_$][\w$]*/gu)) referenced.add(match[0]);
      }
    }
    const lines: string[] = [];
    for (const statement of this.sourceFile.statements) {
      if (!ts.isImportDeclaration(statement)) continue;
      if (!ts.isStringLiteral(statement.moduleSpecifier)) continue;
      const clause = statement.importClause;
      if (!clause) continue;
      const typeOnly = clause.isTypeOnly ? 'type ' : '';
      const parts: string[] = [];
      if (clause.name && referenced.has(clause.name.text)) parts.push(clause.name.text);
      const bindings = clause.namedBindings;
      if (bindings && ts.isNamespaceImport(bindings) && referenced.has(bindings.name.text)) {
        parts.push(`* as ${bindings.name.text}`);
      }
      if (bindings && ts.isNamedImports(bindings)) {
        const named = bindings.elements
          .filter((element) => referenced.has(element.name.text))
          .map((element) => {
            const prefix = element.isTypeOnly ? 'type ' : '';
            const original = element.propertyName
              ? `${this.moduleExportName(element.propertyName)} as `
              : '';
            return `${prefix}${original}${element.name.text}`;
          });
        if (named.length > 0) parts.push(`{ ${named.join(', ')} }`);
      }
      if (parts.length === 0) continue;
      lines.push(
        `import ${typeOnly}${parts.join(', ')} from ${quote(statement.moduleSpecifier.text)};`,
      );
    }
    return lines;
  }
}
