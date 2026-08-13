import { z } from 'zod';
import type { Services } from '../services/index.js';

export interface ToolInvocationContext {
  readonly requestId: string;
  readonly principal: string;
}

export type ToolKind = 'read' | 'write';

export interface ToolDefinition<
  InputSchema extends z.ZodType = z.ZodType,
  OutputSchema extends z.ZodType = z.ZodType,
> {
  readonly name: string;
  readonly title: string;
  readonly summary: string;
  readonly description: string;
  readonly kind: ToolKind;
  readonly inputSchema: InputSchema;
  readonly outputSchema: OutputSchema;
  readonly handler: (
    input: z.output<InputSchema>,
    services: Services,
    context: ToolInvocationContext,
  ) => Promise<z.output<OutputSchema>>;
}

export const defineTool = <InputSchema extends z.ZodType, OutputSchema extends z.ZodType>(
  definition: ToolDefinition<InputSchema, OutputSchema>,
): ToolDefinition<InputSchema, OutputSchema> => definition;

const filePathSchema = z.string().min(1).max(1_000);

export const getFileSkeletonTool = defineTool({
  name: 'get_file_skeleton',
  title: 'Get file skeleton',
  summary: 'Reduce a source file to its structural declarations.',
  description:
    'Returns class signatures, exported functions and variables, doc comments, interfaces, types, and enums while omitting implementation bodies.',
  kind: 'read',
  inputSchema: z.object({ path: filePathSchema }),
  outputSchema: z.object({
    path: z.string(),
    language: z.enum(['typescript', 'javascript']),
    skeleton: z.string(),
    originalLines: z.number().int().nonnegative(),
    skeletonLines: z.number().int().nonnegative(),
  }),
  handler: (input, services) => services.ast.getFileSkeleton(input.path),
});

const dependencySchema = z.object({
  from: z.string(),
  to: z.string(),
  specifier: z.string(),
});

export const getDependencyGraphTool = defineTool({
  name: 'get_dependency_graph',
  title: 'Get dependency graph',
  summary: 'Map local source-file imports from an entry point.',
  description:
    'Recursively resolves relative static imports, re-exports, require calls, and dynamic imports without returning file implementations.',
  kind: 'read',
  inputSchema: z.object({
    path: filePathSchema,
    maxDepth: z.number().int().min(0).max(100).default(20),
  }),
  outputSchema: z.object({
    entry: z.string(),
    files: z.array(z.string()),
    dependencies: z.array(dependencySchema),
    unresolved: z.array(z.object({ from: z.string(), specifier: z.string() })),
  }),
  handler: (input, services) => services.ast.getDependencyGraph(input.path, input.maxDepth),
});

export const toolDefinitions = [getFileSkeletonTool, getDependencyGraphTool] as const satisfies readonly ToolDefinition[];
