import { readFile } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { createToolRegistry } from '@agent-tool-platform/runtime/tools';
import {
  connectInMemoryMcpClient,
  runAuthConformance,
  runConfigConformance,
  runHttpConformance,
  runLifecycleConformance,
  runMcpConformance,
  runMetadataConformance,
  runOpenApiConformance,
  runRegistryConformance,
  runRootBoundaryConformance,
  runRoutingConformance,
  runTransportParity,
} from '@agent-tool-platform/testkit';
import { astSummarizerCapability } from '../../src/capability.js';
import { astConfigSpec } from '../../src/config/index.js';
import { astManifest } from '../../src/manifest.js';
import { createAstServices } from '../../src/services/index.js';
import { astTools } from '../../src/tools/definitions.js';
import { serverInstructions } from '../../src/tools/guidance.js';
import { createTestApplication, type TestApplication } from '../helpers/application.js';
import { testApiKey, testConfig } from '../helpers/config.js';
import { createWorkspace } from '../helpers/workspace.js';

/**
 * Platform conformance.
 *
 * These suites assert platform contracts, not AST behaviour: that the registry, routing grammar,
 * authentication, configuration composition, HTTP surface, MCP surface, OpenAPI derivation, root
 * boundary, transport parity, lifecycle, and repository metadata all behave the way every
 * capability is required to. AST domain behaviour is proven by the tests under `tests/unit/ast`.
 */

const applications: TestApplication[] = [];

const application = async (): Promise<TestApplication> => {
  const created = await createTestApplication();
  applications.push(created);
  return created;
};

afterEach(async () => {
  await Promise.all(applications.splice(0).map((created) => created.shutdown()));
});

const readSample = { name: 'get_file_skeleton', input: { path: 'example.ts' } } as const;

describe('platform conformance', () => {
  it('satisfies the registry contract', async () => {
    const root = await createWorkspace({ 'a.ts': 'export const a: number = 1;\n' });
    const services = createAstServices(testConfig({ AST_WORKSPACE_ROOT: root }));
    const result = await runRegistryConformance({
      registry: createToolRegistry(astTools),
      services,
      invalidInputSample: { name: 'get_file_skeleton', input: { path: 42 } },
    });
    expect(result.failures).toEqual([]);
    expect(result.checks.length).toBeGreaterThan(0);
  });

  it('satisfies the routing contract', () => {
    const result = runRoutingConformance({
      registry: createToolRegistry(astTools),
      instructions: serverInstructions,
      minimumUseWhen: 3,
    });
    expect(result.failures).toEqual([]);
  });

  it('satisfies the authentication contract', async () => {
    const result = await runAuthConformance();
    expect(result.failures).toEqual([]);
  });

  it('composes its configuration with the platform configuration', async () => {
    const result = await runConfigConformance({
      spec: astConfigSpec,
      serviceName: astManifest.name,
      serviceVersion: astManifest.version,
      baseEnv: { NODE_ENV: 'test', AUTH_MODE: 'api-key', API_KEYS: testApiKey },
      invalidEnvironments: [
        {
          reason: 'AST_MAX_TOTAL_BYTES below AST_MAX_FILE_BYTES',
          env: {
            NODE_ENV: 'test',
            AUTH_MODE: 'disabled',
            AST_MAX_FILE_BYTES: '2000',
            AST_MAX_TOTAL_BYTES: '1000',
          },
        },
        {
          reason: 'an unknown type inference mode',
          env: { NODE_ENV: 'test', AUTH_MODE: 'disabled', AST_TYPE_INFERENCE: 'whole-project' },
        },
      ],
      expect: (config) =>
        config.analysis.limits.maxDepth > 0 && config.analysis.maxConcurrentJobs > 0,
    });
    expect(result.failures).toEqual([]);
  });

  it('satisfies the HTTP contract', async () => {
    const app = await application();
    const result = await runHttpConformance({
      app: app.http,
      registry: app.registry,
      apiKey: testApiKey,
      readSample: { name: readSample.name, body: readSample.input },
    });
    expect(result.failures).toEqual([]);
  });

  it('satisfies the MCP contract', async () => {
    const app = await application();
    const result = await runMcpConformance({
      createServer: () => app.createStdioServer(),
      registry: app.registry,
      instructions: serverInstructions,
      readSample,
    });
    expect(result.failures).toEqual([]);
  });

  it('derives OpenAPI from the registry', async () => {
    const app = await application();
    const result = runOpenApiConformance({
      document: app.openApiDocument(),
      registry: app.registry,
      publicPaths: ['/health', '/ready', '/version', '/openapi.json'],
    });
    expect(result.failures).toEqual([]);
  });

  it('satisfies the root boundary contract', async () => {
    const result = await runRootBoundaryConformance();
    expect(result.failures).toEqual([]);
  });

  it('returns identical results over HTTP and MCP', async () => {
    const app = await application();
    const result = await runTransportParity({
      app: app.http,
      createMcpServer: () => app.createStdioServer(),
      apiKey: testApiKey,
      samples: [
        readSample,
        { name: 'get_dependency_graph', input: { path: 'example.ts', maxDepth: 1 } },
      ],
    });
    expect(result.failures).toEqual([]);
  });

  it('satisfies the lifecycle contract and runs the AST stop hook', async () => {
    const result = await runLifecycleConformance({
      createApplication: () => createTestApplication({ start: false }),
      stoppedProbe: (services) => services.semaphore.stats.draining,
      apiKey: testApiKey,
    });
    expect(result.failures).toEqual([]);
  });

  it('publishes truthful repository metadata', async () => {
    const load = async (path: string): Promise<unknown> =>
      JSON.parse(await readFile(new URL(path, import.meta.url), 'utf8'));
    const result = runMetadataConformance({
      server: await load('../../server.json'),
      packageManifest: await load('../../package.json'),
      registryEntry: await load('../../examples/central-registry-entry.json'),
    });
    expect(result.failures).toEqual([]);
  });

  it('publishes closed-world read-only annotations over MCP', async () => {
    const app = await application();
    const connected = await connectInMemoryMcpClient(app.createStdioServer());
    try {
      const listed = await connected.client.listTools();
      expect(listed.tools).toHaveLength(2);
      for (const tool of listed.tools) {
        expect(tool.annotations).toMatchObject({
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        });
      }
    } finally {
      await connected.close();
    }
  });

  it('exposes exactly the two AST tools through the platform capability', () => {
    expect(astSummarizerCapability.tools.map((tool) => tool.name).sort()).toEqual([
      'get_dependency_graph',
      'get_file_skeleton',
    ]);
  });
});
