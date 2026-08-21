import { describe, expect, it } from 'vitest';
import { RecordingTelemetrySink } from '@agent-tool-platform/runtime/telemetry';
import { createAgentToolApplication } from '@agent-tool-platform/runtime/capability';
import { createSilentLogger } from '@agent-tool-platform/runtime/logging';
import { astSummarizerCapability, estimateAstInvocation } from '../../src/capability.js';
import type { AstConfig } from '../../src/config/index.js';
import type { AstServices } from '../../src/services/index.js';
import { testApiKey, testEnv } from '../helpers/config.js';
import { createWorkspace } from '../helpers/workspace.js';

/**
 * Telemetry is the seam that answers "how much model context did routing through this tool avoid?".
 * What matters here is that the numbers are real, that they are derived only from aggregates, and
 * that nothing identifying can reach a sink.
 */

describe('AST telemetry estimator', () => {
  it('ignores anything that is not a measurable AST result', () => {
    expect(estimateAstInvocation(undefined)).toBeUndefined();
    expect(estimateAstInvocation('a string')).toBeUndefined();
    expect(estimateAstInvocation({})).toBeUndefined();
    expect(estimateAstInvocation({ metrics: { sourceBytes: -1 } })).toBeUndefined();
  });

  it('derives byte, truncation, and fallback measurements from the result envelope', () => {
    const measurement = estimateAstInvocation({
      metrics: { sourceBytes: 4_000 },
      truncated: true,
      diagnostics: [{ code: 1005 }],
    });
    expect(measurement).toMatchObject({ sourceBytes: 4_000, truncated: true, fallback: true });
    expect(measurement?.outputBytes).toBeGreaterThan(0);
    expect(measurement?.rawEquivalentTokens).toBe(1_000);
    expect(measurement?.estimatedTokensAvoided).toBe(
      Math.max(0, (measurement?.rawEquivalentTokens ?? 0) - (measurement?.resultTokens ?? 0)),
    );
  });

  it('never reports negative savings when the projection is larger than the source', () => {
    const measurement = estimateAstInvocation({ metrics: { sourceBytes: 1 }, truncated: false });
    expect(measurement?.estimatedTokensAvoided).toBe(0);
    expect(measurement?.fallback).toBe(false);
  });

  it('records a real invocation without emitting paths, arguments, or results', async () => {
    const telemetry = new RecordingTelemetrySink();
    const root = await createWorkspace({
      'src/big.ts': `${'/** Documented. */\nexport function widget(value: string): string { return value.repeat(4); }\n'.repeat(40)}`,
    });
    const application = await createAgentToolApplication<AstServices, AstConfig>(
      astSummarizerCapability,
      {
        logger: createSilentLogger(),
        env: testEnv({ AST_WORKSPACE_ROOT: root }),
        telemetry,
      },
    );
    await application.start();
    try {
      const response = await application.http.inject({
        method: 'POST',
        url: '/tools/get_file_skeleton',
        headers: { 'x-api-key': testApiKey },
        payload: { path: 'src/big.ts' },
      });
      expect(response.statusCode).toBe(200);
    } finally {
      await application.shutdown();
    }

    expect(telemetry.events).toHaveLength(1);
    const [event] = telemetry.events;
    expect(event).toMatchObject({
      capability: 'agent-tool-server-ast-summarizer',
      tool: 'get_file_skeleton',
      transport: 'http',
      outcome: 'ok',
    });
    expect(event?.measurement?.sourceBytes).toBeGreaterThan(0);
    expect(event?.measurement?.estimatedTokensAvoided).toBeGreaterThan(0);

    const serialized = JSON.stringify(telemetry.events);
    expect(serialized).not.toContain(root);
    expect(serialized).not.toContain('src/big.ts');
    expect(serialized).not.toContain('widget');
  });
});
