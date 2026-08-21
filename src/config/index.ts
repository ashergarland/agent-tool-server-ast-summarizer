import { z } from 'zod';
import {
  ConfigurationError,
  defineCapabilityConfig,
  loadCapabilityConfig,
  positiveInteger,
  strictBoolean,
  type PlatformConfig,
} from '@agent-tool-platform/runtime/config';
import { defaultLimits, type AnalysisLimits } from '../ast/limits.js';
import { astManifest } from '../manifest.js';

/**
 * AST capability configuration.
 *
 * Service identity, HTTP transport, logging, authentication, rate limiting, shutdown, and the
 * shared request deadline are platform concerns and are parsed by the platform schema. Everything
 * declared here is genuinely about analysing source: where the workspace is, and what one analysis
 * is allowed to cost.
 */

export type TypeInferenceMode = 'off' | 'single-file';

export const astEnvSchema = z.object({
  /** The single readable workspace. Required for any hosted HTTP deployment. */
  AST_WORKSPACE_ROOT: z.string().min(1).optional(),
  AST_MAX_FILE_BYTES: positiveInteger(defaultLimits.maxFileBytes),
  AST_MAX_TOTAL_BYTES: positiveInteger(defaultLimits.maxTotalBytes),
  AST_MAX_DEPTH: z.coerce.number().int().min(0).max(100).default(defaultLimits.maxDepth),
  AST_MAX_FILES: positiveInteger(defaultLimits.maxFiles),
  AST_MAX_EDGES: positiveInteger(defaultLimits.maxEdges),
  AST_MAX_DECLARATIONS: positiveInteger(defaultLimits.maxDeclarations),
  AST_MAX_MEMBERS: positiveInteger(defaultLimits.maxMembersPerDeclaration),
  AST_MAX_JSDOC_CHARS: positiveInteger(defaultLimits.maxJsDocChars),
  AST_MAX_RESULT_CHARS: positiveInteger(defaultLimits.maxResultChars),
  AST_REQUEST_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(100)
    .max(120_000)
    .default(defaultLimits.requestTimeoutMs),
  AST_MAX_CONCURRENT_JOBS: z.coerce.number().int().min(1).max(64).default(2),
  AST_MAX_QUEUED_JOBS: z.coerce.number().int().min(0).max(1024).default(8),
  AST_INCLUDE_PRIVATE_MEMBERS: strictBoolean.default(false),
  AST_TYPE_INFERENCE: z.enum(['off', 'single-file']).default('single-file'),
});

export type AstEnv = z.infer<typeof astEnvSchema>;

export interface AstConfig extends PlatformConfig {
  readonly workspace: {
    /** Undefined means no workspace was configured; the service starts but never reports ready. */
    readonly root: string | undefined;
  };
  readonly analysis: {
    readonly limits: AnalysisLimits;
    readonly maxConcurrentJobs: number;
    readonly maxQueuedJobs: number;
    readonly includePrivateMembers: boolean;
    readonly typeInference: TypeInferenceMode;
  };
}

export const astConfigSpec = defineCapabilityConfig<typeof astEnvSchema, AstConfig>({
  schema: astEnvSchema,
  build: ({ base, env }) => ({
    ...base,
    workspace: { root: env.AST_WORKSPACE_ROOT },
    analysis: {
      limits: {
        maxFileBytes: env.AST_MAX_FILE_BYTES,
        maxTotalBytes: env.AST_MAX_TOTAL_BYTES,
        maxDepth: env.AST_MAX_DEPTH,
        maxFiles: env.AST_MAX_FILES,
        maxEdges: env.AST_MAX_EDGES,
        maxDeclarations: env.AST_MAX_DECLARATIONS,
        maxMembersPerDeclaration: env.AST_MAX_MEMBERS,
        maxJsDocChars: env.AST_MAX_JSDOC_CHARS,
        maxResultChars: env.AST_MAX_RESULT_CHARS,
        requestTimeoutMs: env.AST_REQUEST_TIMEOUT_MS,
      },
      maxConcurrentJobs: env.AST_MAX_CONCURRENT_JOBS,
      maxQueuedJobs: env.AST_MAX_QUEUED_JOBS,
      includePrivateMembers: env.AST_INCLUDE_PRIVATE_MEMBERS,
      typeInference: env.AST_TYPE_INFERENCE,
    },
  }),
  /** A per-file ceiling above the cumulative ceiling can never be honoured, so refuse it early. */
  validate: (config) => {
    if (config.analysis.limits.maxTotalBytes < config.analysis.limits.maxFileBytes) {
      throw new ConfigurationError('AST_MAX_TOTAL_BYTES must be at least AST_MAX_FILE_BYTES');
    }
  },
});

export const astConfigDefaults = {
  serviceName: astManifest.name,
  serviceVersion: astManifest.version,
};

export const loadAstConfig = (source: NodeJS.ProcessEnv = process.env): AstConfig =>
  loadCapabilityConfig({ defaults: astConfigDefaults, spec: astConfigSpec, source });
