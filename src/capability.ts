import {
  defineAgentToolCapability,
  type CapabilityContext,
} from '@agent-tool-platform/runtime/capability';
import { readinessNotReady, readinessReady } from '@agent-tool-platform/runtime/lifecycle';
import { approximateTokens, jsonByteLength } from '@agent-tool-platform/runtime/telemetry';
import type { InvocationMeasurement } from '@agent-tool-platform/runtime/telemetry';
import { astConfigSpec, type AstConfig, type astEnvSchema } from './config/index.js';
import { astManifest } from './manifest.js';
import { createAstServices, type AstServices } from './services/index.js';
import { astTools } from './tools/definitions.js';
import { serverInstructions } from './tools/guidance.js';

/**
 * The AST Summarizer capability.
 *
 * Everything here is AST-specific: which tools exist, what one analysis may cost, what "ready"
 * means for a source workspace, and how much model context a projection avoided. Transports,
 * authentication, rate limiting, the registry, OpenAPI, MCP, and the lifecycle state machine are
 * supplied by `@agent-tool-platform/runtime` and are deliberately absent.
 */

/** The shape both tools publish under `metrics`, read defensively because the estimator sees `unknown`. */
interface MeasurableResult {
  readonly metrics?: { readonly sourceBytes?: unknown };
  readonly truncated?: unknown;
  readonly diagnostics?: unknown;
}

const nonNegativeInteger = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : undefined;

/**
 * Maps an AST result onto the shared context-savings contract.
 *
 * Byte counts and truncation are measured, not guessed. Token counts are the platform's documented
 * four-bytes-per-token approximation applied to those same byte counts, so they are reproducible
 * and comparable across capabilities rather than a private heuristic. Nothing derived from source
 * text, paths, arguments, or results leaves this function.
 */
export const estimateAstInvocation = (output: unknown): InvocationMeasurement | undefined => {
  if (typeof output !== 'object' || output === null) return undefined;
  const result = output as MeasurableResult;
  const sourceBytes = nonNegativeInteger(result.metrics?.sourceBytes);
  if (sourceBytes === undefined) return undefined;
  const outputBytes = jsonByteLength(output);
  const rawEquivalentTokens = approximateTokens(sourceBytes);
  const resultTokens = approximateTokens(outputBytes);
  return {
    sourceBytes,
    outputBytes,
    rawEquivalentTokens,
    resultTokens,
    estimatedTokensAvoided: Math.max(0, rawEquivalentTokens - resultTokens),
    truncated: result.truncated === true,
    // A syntax diagnostic means the answer came from a recovered parse tree rather than a clean one.
    fallback: Array.isArray(result.diagnostics) && result.diagnostics.length > 0,
  };
};

export const astSummarizerCapability = defineAgentToolCapability<
  AstServices,
  AstConfig,
  typeof astEnvSchema
>({
  manifest: astManifest,
  instructions: serverInstructions,
  config: astConfigSpec,
  tools: astTools,

  createServices(context: CapabilityContext<AstConfig>): AstServices {
    return createAstServices(context.config);
  },

  readiness: [
    /** Proves the boundary exists and is usable. It never reads or lists source. */
    async ({ services }) => {
      const status = await services.workspace.status();
      return status.usable
        ? readinessReady('workspace')
        : readinessNotReady('workspace', status.reason ?? 'workspace_root_unusable');
    },
    /** A saturated analysis queue means new work cannot be admitted, so the replica is not ready. */
    ({ services }) =>
      services.semaphore.accepting
        ? readinessReady('analysis_capacity')
        : readinessNotReady('analysis_capacity', 'analysis_queue_saturated'),
  ],

  lifecycle: {
    /** Refuses new analysis and waits for in-flight jobs so shutdown never truncates a response. */
    async stop({ services }) {
      await services.semaphore.drain();
    },
  },

  telemetry: {
    estimateInvocation: ({ output }) => estimateAstInvocation(output),
  },
});
