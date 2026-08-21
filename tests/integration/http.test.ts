import { afterEach, describe, expect, it } from 'vitest';
import {
  createTestApplication,
  fixtureFiles,
  type TestApplication,
} from '../helpers/application.js';
import { testApiKey } from '../helpers/config.js';
import { createWorkspace } from '../helpers/workspace.js';

/**
 * End-to-end HTTP behaviour of the real AST capability served by the platform runtime. Fastify's
 * `inject` runs the whole hook chain — request identity, authentication, rate limiting, error
 * normalization — without binding a port.
 */

const applications: TestApplication[] = [];

const server = async (
  options: Parameters<typeof createTestApplication>[0] = {},
): Promise<TestApplication> => {
  const application = await createTestApplication(options);
  applications.push(application);
  return application;
};

afterEach(async () => {
  await Promise.all(applications.splice(0).map((application) => application.shutdown()));
});

const authorized = { 'x-api-key': testApiKey };

describe('HTTP API', () => {
  it('serves public metadata and echoes request IDs', async () => {
    const response = await (
      await server()
    ).http.inject({ method: 'GET', url: '/version', headers: { 'x-request-id': 'caller-id' } });
    expect(response.statusCode).toBe(200);
    expect(response.headers['x-request-id']).toBe('caller-id');
    expect(response.json().capabilities).toMatchObject({
      capability: 'agent-tool-server-ast-summarizer',
      toolCount: 2,
      mutationsEnabled: false,
    });
    expect(response.json().capabilities.transports).toContain('mcp-http');
  });

  it('separates liveness from readiness', async () => {
    const ready = await server();
    expect((await ready.http.inject({ method: 'GET', url: '/health' })).statusCode).toBe(200);
    const readyResponse = await ready.http.inject({ method: 'GET', url: '/ready' });
    expect(readyResponse.statusCode).toBe(200);
    expect(readyResponse.json()).toMatchObject({ state: 'ready', ready: true });
    expect(readyResponse.json().checks).toContainEqual({ name: 'workspace', state: 'ready' });

    const hosted = await server({ workspace: false });
    expect((await hosted.http.inject({ method: 'GET', url: '/health' })).statusCode).toBe(200);
    const notReady = await hosted.http.inject({ method: 'GET', url: '/ready' });
    expect(notReady.statusCode).toBe(503);
    expect(notReady.json().checks).toContainEqual({
      name: 'workspace',
      state: 'not_ready',
      detail: 'workspace_root_not_configured',
    });
  });

  it('authenticates protected routes', async () => {
    const app = (await server()).http;
    expect((await app.inject({ method: 'GET', url: '/tools' })).statusCode).toBe(401);
    expect(
      (
        await app.inject({
          method: 'GET',
          url: '/tools',
          headers: { 'x-api-key': 'not-the-configured-key-but-long-enough' },
        })
      ).statusCode,
    ).toBe(401);
    const response = await app.inject({
      method: 'GET',
      url: '/tools',
      headers: { authorization: `Bearer ${testApiKey}` },
    });
    expect(response.statusCode).toBe(200);
    const catalogue = response.json<{ tools: { kind: string }[] }>();
    expect(catalogue.tools).toHaveLength(2);
    expect(catalogue.tools.every((tool) => tool.kind === 'read')).toBe(true);
  });

  it('rate limits authenticated principals', async () => {
    const app = (await server({ env: { RATE_LIMIT_MAX: '1' } })).http;
    expect(
      (await app.inject({ method: 'GET', url: '/tools', headers: authorized })).statusCode,
    ).toBe(200);
    expect(
      (await app.inject({ method: 'GET', url: '/tools', headers: authorized })).statusCode,
    ).toBe(429);
  });

  it('supports non-production disabled authentication only', async () => {
    const response = await (
      await server({ env: { AUTH_MODE: 'disabled', API_KEYS: '' } })
    ).http.inject({ method: 'GET', url: '/tools' });
    expect(response.statusCode).toBe(200);
  });

  it('invokes both tools and maps failures to the bounded error contract', async () => {
    const app = (await server()).http;

    const skeleton = await app.inject({
      method: 'POST',
      url: '/tools/get_file_skeleton',
      headers: authorized,
      payload: { path: 'example.ts' },
    });
    expect(skeleton.statusCode).toBe(200);
    expect(skeleton.json().result.skeleton).toContain('export function example(): number;');
    expect(skeleton.json().result.skeleton).not.toContain('return 1');

    const graph = await app.inject({
      method: 'POST',
      url: '/tools/get_dependency_graph',
      headers: authorized,
      payload: { path: 'example.ts' },
    });
    expect(graph.statusCode).toBe(200);
    expect(graph.json().result.files).toEqual(['example.ts', 'helper.ts']);

    const invalid = await app.inject({
      method: 'POST',
      url: '/tools/get_file_skeleton',
      headers: authorized,
      payload: {},
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json().error).toMatchObject({ code: 'bad_request', retryable: false });

    const absolute = await app.inject({
      method: 'POST',
      url: '/tools/get_file_skeleton',
      headers: authorized,
      payload: { path: '/etc/passwd' },
    });
    expect(absolute.statusCode).toBe(400);
    expect(JSON.stringify(absolute.json())).not.toContain('etc');

    const missing = await app.inject({
      method: 'POST',
      url: '/tools/get_file_skeleton',
      headers: authorized,
      payload: { path: 'missing.ts' },
    });
    expect(missing.statusCode).toBe(404);
  });

  it('refuses a path that escapes the workspace root', async () => {
    const outside = await createWorkspace({ 'secret.ts': 'export const secret = true;\n' });
    const app = (
      await server({ files: { ...fixtureFiles, 'nested/inner.ts': 'export const x = 1;\n' } })
    ).http;
    const traversal = await app.inject({
      method: 'POST',
      url: '/tools/get_file_skeleton',
      headers: authorized,
      payload: { path: '../../etc/passwd' },
    });
    expect([400, 403, 404]).toContain(traversal.statusCode);
    expect(JSON.stringify(traversal.json())).not.toContain(outside);
  });

  it('keeps installed package directories out of scope', async () => {
    const app = (
      await server({
        files: { ...fixtureFiles, 'node_modules/left-pad/index.js': 'module.exports = 1;\n' },
      })
    ).http;
    const response = await app.inject({
      method: 'POST',
      url: '/tools/get_file_skeleton',
      headers: authorized,
      payload: { path: 'node_modules/left-pad/index.js' },
    });
    expect(response.statusCode).toBe(403);
  });

  it('returns not_ready for tool calls without a workspace', async () => {
    const response = await (
      await server({ workspace: false })
    ).http.inject({
      method: 'POST',
      url: '/tools/get_file_skeleton',
      headers: authorized,
      payload: { path: 'example.ts' },
    });
    expect(response.statusCode).toBe(503);
    expect(response.json().error).toMatchObject({ code: 'not_ready', retryable: true });
  });

  it('publishes the generated OpenAPI document', async () => {
    const response = await (await server()).http.inject({ method: 'GET', url: '/openapi.json' });
    expect(response.statusCode).toBe(200);
    const document = response.json<{ paths: Record<string, unknown> }>();
    expect(document.paths['/tools/get_file_skeleton']).toBeDefined();
    expect(document.paths['/tools/get_dependency_graph']).toBeDefined();
    expect(document.paths['/ready']).toBeDefined();
  });

  it('drains in-flight analysis on shutdown', async () => {
    const application = await createTestApplication();
    expect(application.registry.size).toBe(2);
    expect((await application.readiness()).ready).toBe(true);
    await application.shutdown();
    expect(application.services.semaphore.stats.draining).toBe(true);
    expect(application.lifecycle.state).toBe('stopped');
  });
});
