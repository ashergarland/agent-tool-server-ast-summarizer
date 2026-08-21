import { z } from 'zod';
import { defineTool } from '@agent-tool-platform/runtime/tools';
import { omissionKinds } from '../ast/projector.js';
import type { AstServices } from '../services/index.js';
import { graphDescription, skeletonDescription } from './guidance.js';

const filePathSchema = z
  .string()
  .min(1)
  .max(1_000)
  .describe(
    'Source file path relative to the server workspace root, for example "src/index.ts". Absolute paths and paths that leave the root are refused.',
  );

const limitOverride = (description: string): z.ZodOptional<z.ZodNumber> =>
  z.number().int().min(0).max(10_000_000).optional().describe(description);

const warningSchema = z
  .object({
    code: z.string().describe('Stable warning identifier.'),
    message: z.string().describe('Short human-readable explanation.'),
    count: z.number().int().nonnegative().describe('How many times the warning was raised.'),
  })
  .describe('A bounded, aggregated analysis warning.');

const diagnosticSchema = z.object({
  code: z.number().int().describe('TypeScript syntax diagnostic code.'),
  category: z.enum(['error', 'warning', 'suggestion', 'message']),
  line: z.number().int().positive().describe('One-based line number.'),
  column: z.number().int().positive().describe('One-based column number.'),
  message: z.string().describe('Truncated compiler message.'),
});

const envelope = {
  complete: z
    .boolean()
    .describe('False when diagnostics or limits prevented a full, trustworthy analysis.'),
  truncated: z.boolean().describe('True when at least one limit stopped the analysis early.'),
  limitsReached: z
    .array(z.string())
    .describe('Names of the limits that were reached, for example "maxDepth".'),
  warnings: z
    .array(warningSchema)
    .describe('Bounded warnings; inspect before trusting the result.'),
};

const skeletonInput = z.strictObject({
  path: filePathSchema,
  includePrivateMembers: z
    .boolean()
    .optional()
    .describe(
      'Include private and #private class members. Defaults to the deployment setting, normally false.',
    ),
  limits: z
    .strictObject({
      maxDeclarations: limitOverride('Lower the number of top-level declarations returned.'),
      maxMembersPerDeclaration: limitOverride('Lower the number of members kept per declaration.'),
      maxJsDocChars: limitOverride('Lower the documentation characters kept per declaration.'),
      maxResultChars: limitOverride('Lower the rendered result size in characters.'),
      requestTimeoutMs: limitOverride('Lower the analysis deadline in milliseconds.'),
    })
    .optional()
    .describe('Per-call limits. A value above the deployment ceiling is clamped, never raised.'),
});

const skeletonOutput = z.object({
  path: z.string().describe('Workspace-relative path of the analysed file.'),
  language: z.enum(['typescript', 'javascript']),
  skeleton: z
    .string()
    .describe(
      'Rendered declaration view. It is a projection, not compilable source: bodies, initializers, and runtime expressions are absent.',
    ),
  originalLines: z.number().int().nonnegative(),
  skeletonLines: z.number().int().nonnegative(),
  ...envelope,
  omissions: z
    .array(
      z.object({
        kind: z.enum(omissionKinds).describe('What category of runtime construct was removed.'),
        count: z.number().int().positive(),
      }),
    )
    .describe('Compact record of removed constructs. Values are never restated.'),
  diagnostics: z
    .array(diagnosticSchema)
    .describe(
      'Bounded syntax diagnostics. A non-empty list means the projection is a recovery view.',
    ),
  metrics: z.object({
    sourceBytes: z.number().int().nonnegative(),
    sourceLines: z.number().int().nonnegative(),
    skeletonChars: z.number().int().nonnegative(),
    declarationsDiscovered: z.number().int().nonnegative(),
    declarationsReturned: z.number().int().nonnegative(),
    declarationsOmitted: z.number().int().nonnegative(),
  }),
});

export const getFileSkeletonTool = defineTool<
  AstServices,
  typeof skeletonInput,
  typeof skeletonOutput
>({
  name: 'get_file_skeleton',
  title: 'Get file skeleton',
  summary: 'Reduce one source file to its declarations without any implementation.',
  description: skeletonDescription,
  kind: 'read',
  routing: {
    useWhen: [
      "understanding one source file's declarations and API shape",
      'inspecting signatures, types, and documentation without implementation bodies',
      'reducing a large source file before an agent reasons about it',
    ],
    doNotUseWhen: [
      'implementation details, algorithms, literal values, or exact runtime behaviour are required',
      'dependency traversal is the primary goal, in which case use get_dependency_graph',
    ],
    nextSteps: ['get_dependency_graph'],
    scope: 'one file, addressed by a path relative to the server workspace root',
    changesState: false,
  },
  // Closed world: one canonical local root, `node_modules` excluded, packages never traversed.
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  inputSchema: skeletonInput,
  outputSchema: skeletonOutput,
  handler: (input, services, context) =>
    services.ast.getFileSkeleton({
      path: input.path,
      ...(input.includePrivateMembers === undefined
        ? {}
        : { includePrivateMembers: input.includePrivateMembers }),
      ...(input.limits === undefined ? {} : { limits: input.limits }),
      signal: context.signal,
    }),
});

const dependencyKind = z
  .enum(['import', 'export', 'require', 'dynamic-import', 'import-equals'])
  .describe('How the reference was written in source.');

const graphInput = z.strictObject({
  path: filePathSchema,
  maxDepth: z
    .number()
    .int()
    .min(0)
    .max(100)
    .optional()
    .describe(
      'Edges to follow from the entry file. 0 analyses the entry only. Clamped to the deployment ceiling.',
    ),
  limits: z
    .strictObject({
      maxFiles: limitOverride('Lower the number of files visited.'),
      maxEdges: limitOverride('Lower the number of recorded references.'),
      maxTotalBytes: limitOverride('Lower the cumulative source bytes read.'),
      requestTimeoutMs: limitOverride('Lower the analysis deadline in milliseconds.'),
    })
    .optional()
    .describe('Per-call limits. A value above the deployment ceiling is clamped, never raised.'),
});

const graphOutput = z.object({
  entry: z.string().describe('Workspace-relative entry path.'),
  files: z
    .array(z.string())
    .describe('Files analysed, in breadth-first order starting at the entry.'),
  dependencies: z
    .array(
      z.object({
        from: z.string(),
        to: z.string().describe('Workspace-relative path of the resolved local file.'),
        specifier: z.string().describe('The specifier exactly as written in source.'),
        kind: dependencyKind,
        traversed: z
          .boolean()
          .describe('False when a limit stopped the traversal before this target was analysed.'),
      }),
    )
    .describe('References resolved to a local file inside the workspace root.'),
  external: z
    .array(z.object({ from: z.string(), specifier: z.string(), kind: dependencyKind }))
    .describe('Package references. They are reported but never traversed or read.'),
  unresolved: z
    .array(
      z.object({
        from: z.string(),
        specifier: z.string(),
        kind: dependencyKind,
        reason: z
          .enum(['missing', 'unsupported', 'out_of_root', 'limit_stopped'])
          .describe('Why the reference produced no local file.'),
      }),
    )
    .describe('References that could not be resolved to an analysable local file.'),
  configPath: z
    .string()
    .optional()
    .describe('Workspace-relative tsconfig or jsconfig used for resolution, when one was found.'),
  ...envelope,
  diagnostics: z
    .array(diagnosticSchema.extend({ file: z.string() }))
    .describe('Bounded syntax diagnostics per file.'),
  metrics: z.object({
    sourceBytes: z.number().int().nonnegative(),
    filesDiscovered: z.number().int().nonnegative(),
    filesReturned: z.number().int().nonnegative(),
    resolvedEdges: z.number().int().nonnegative(),
    externalEdges: z.number().int().nonnegative(),
    unresolvedEdges: z.number().int().nonnegative(),
    maxDepth: z.number().int().nonnegative().describe('Effective depth ceiling after clamping.'),
  }),
});

export const getDependencyGraphTool = defineTool<
  AstServices,
  typeof graphInput,
  typeof graphOutput
>({
  name: 'get_dependency_graph',
  title: 'Get dependency graph',
  summary: 'Map local source relationships from one entry file.',
  description: graphDescription,
  kind: 'read',
  routing: {
    useWhen: [
      'tracing local imports, re-exports, and requires from one entry file',
      'discovering which local source files relate to each other',
      'deciding which source files should be inspected next',
    ],
    doNotUseWhen: [
      "only one file's declaration shape is required, in which case use get_file_skeleton",
      'the internals of an external package are the target; packages are reported but never traversed',
    ],
    nextSteps: ['get_file_skeleton'],
    scope: 'one entry file and the local files it reaches, inside the server workspace root',
    changesState: false,
  },
  // Closed world: packages are reported as external but never traversed or read.
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  inputSchema: graphInput,
  outputSchema: graphOutput,
  handler: (input, services, context) =>
    services.ast.getDependencyGraph({
      path: input.path,
      ...(input.maxDepth === undefined ? {} : { maxDepth: input.maxDepth }),
      ...(input.limits === undefined ? {} : { limits: input.limits }),
      signal: context.signal,
    }),
});

export const astTools = [getFileSkeletonTool, getDependencyGraphTool];
