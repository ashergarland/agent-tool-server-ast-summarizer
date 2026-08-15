import pino from 'pino';
import { afterEach, describe, expect, it } from 'vitest';
import { createApplication } from '../../src/app.js';
import { createHttpServer } from '../../src/server/http.js';
import { createServices } from '../../src/services/index.js';
import { createToolRegistry } from '../../src/tools/registry.js';
import { testApiKey, testConfig } from '../helpers/config.js';
import { createWorkspace } from '../helpers/workspace.js';

const servers: ReturnType<typeof createHttpServer>[] = [];

const fixtureFiles = {
  'example.ts': "import './helper.js';\nexport function example(): number { return 1; }\n",
  'helper.ts': 'export const helper: number = 2;\n',
};

const server = async (
  overrides: Record<string, unknown> = {},
  options: { workspace?: boolean } = {},
) => {
  const config = testConfig(overrides);
  const root = options.workspace === false ? undefined : await createWorkspace(fixtureFiles);
  const app = createHttpServer({
    config,
    logger: pino({ level: 'silent' }),
    services: createServices(config, root === undefined ? {} : { workspaceRoot: root }),
    registry: createToolRegistry(),
  });
  servers.push(app);
  return app;
};

afterEach(async () => Promise.all(servers.splice(0).map((app) => app.close())));

describe('HTTP API', () => {
  it('serves public metadata and echoes request IDs', async () => {
    const response = await (
      await server()
    ).inject({ method: 'GET', url: '/version', headers: { 'x-request-id': 'caller-id' } });
    expect(response.statusCode).toBe(200);
    expect(response.headers['x-request-id']).toBe('caller-id');
    expect(response.json().capabilities).toMatchObject({
      readOnly: true,
      workspaceConfigured: true,
    });
    expect(response.json().capabilities.transports).toContain('streamable-http');
  });

  it('separates liveness from readiness', async () => {
    const ready = await server();
    expect((await ready.inject({ method: 'GET', url: '/health' })).statusCode).toBe(200);
    const readyResponse = await ready.inject({ method: 'GET', url: '/ready' });
    expect(readyResponse.statusCode).toBe(200);
    expect(readyResponse.json()).toMatchObject({ status: 'ready', ready: true });

    const hosted = await server({}, { workspace: false });
    expect((await hosted.inject({ method: 'GET', url: '/health' })).statusCode).toBe(200);
    const notReady = await hosted.inject({ method: 'GET', url: '/ready' });
    expect(notReady.statusCode).toBe(503);
    expect(notReady.json().checks).toContainEqual({
      name: 'workspace',
      ok: false,
      detail: 'workspace_root_not_configured',
    });
  });

  it('authenticates protected routes with HMAC comparison', async () => {
    const app = await server();
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
    expect(
      (
        await app.inject({
          method: 'GET',
          url: '/tools',
          headers: { 'x-api-key': `${testApiKey}extra` },
        })
      ).statusCode,
    ).toBe(401);
    const response = await app.inject({
      method: 'GET',
      url: '/tools',
      headers: { authorization: `Bearer ${testApiKey}` },
    });
    expect(response.statusCode).toBe(200);
    const catalogue = response.json<{ tools: { readOnly: boolean }[] }>();
    expect(catalogue.tools).toHaveLength(2);
    expect(catalogue.tools.every((tool) => tool.readOnly)).toBe(true);
  });

  it('rate limits unauthenticated attempts and authenticated principals', async () => {
    const anonymous = await server({ RATE_LIMIT_MAX: 1 });
    for (const address of ['192.0.2.1', '192.0.2.2']) {
      expect(
        (
          await anonymous.inject({
            method: 'GET',
            url: '/tools',
            headers: { 'x-forwarded-for': address },
          })
        ).statusCode,
      ).toBe(401);
    }
    expect(
      (
        await anonymous.inject({
          method: 'GET',
          url: '/tools',
          headers: { 'x-forwarded-for': '192.0.2.3' },
        })
      ).statusCode,
    ).toBe(429);

    const authenticated = await server({ RATE_LIMIT_MAX: 1 });
    const headers = { 'x-api-key': testApiKey };
    expect((await authenticated.inject({ method: 'GET', url: '/tools', headers })).statusCode).toBe(
      200,
    );
    expect((await authenticated.inject({ method: 'GET', url: '/tools', headers })).statusCode).toBe(
      429,
    );
  });

  it('supports non-production disabled authentication only', async () => {
    const response = await (
      await server({ AUTH_MODE: 'disabled' })
    ).inject({ method: 'GET', url: '/tools' });
    expect(response.statusCode).toBe(200);
  });

  it('invokes both tools and maps failures to the bounded error contract', async () => {
    const app = await server();
    const headers = { 'x-api-key': testApiKey };

    const skeleton = await app.inject({
      method: 'POST',
      url: '/tools/get_file_skeleton',
      headers,
      payload: { path: 'example.ts' },
    });
    expect(skeleton.statusCode).toBe(200);
    expect(skeleton.json().result.skeleton).toContain('export function example(): number;');
    expect(skeleton.json().result.skeleton).not.toContain('return 1');

    const graph = await app.inject({
      method: 'POST',
      url: '/tools/get_dependency_graph',
      headers,
      payload: { path: 'example.ts' },
    });
    expect(graph.statusCode).toBe(200);
    expect(graph.json().result.files).toEqual(['example.ts', 'helper.ts']);

    const invalid = await app.inject({
      method: 'POST',
      url: '/tools/get_file_skeleton',
      headers,
      payload: {},
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json().error).toMatchObject({ code: 'bad_request', retryable: false });
    expect(invalid.json().error.details.issues).toHaveLength(1);

    const escaping = await app.inject({
      method: 'POST',
      url: '/tools/get_file_skeleton',
      headers,
      payload: { path: '/etc/passwd' },
    });
    expect(escaping.statusCode).toBe(400);
    expect(JSON.stringify(escaping.json())).not.toContain('etc');

    const unsupported = await app.inject({
      method: 'POST',
      url: '/tools/get_file_skeleton',
      headers,
      payload: { path: 'missing.ts' },
    });
    expect(unsupported.statusCode).toBe(404);
  });

  it('returns not_ready for tool calls without a workspace', async () => {
    const response = await (
      await server({}, { workspace: false })
    ).inject({
      method: 'POST',
      url: '/tools/get_file_skeleton',
      headers: { 'x-api-key': testApiKey },
      payload: { path: 'example.ts' },
    });
    expect(response.statusCode).toBe(503);
    expect(response.json().error).toMatchObject({ code: 'not_ready', retryable: true });
  });

  it('publishes the generated OpenAPI document', async () => {
    const response = await (await server()).inject({ method: 'GET', url: '/openapi.json' });
    expect(response.statusCode).toBe(200);
    const document = response.json<{ paths: Record<string, unknown> }>();
    expect(document.paths['/tools/get_file_skeleton']).toBeDefined();
    expect(document.paths['/ready']).toBeDefined();
    expect(JSON.stringify(document)).not.toContain('mutation');
  });

  it('produces the same result through HTTP and the shared registry', async () => {
    const root = await createWorkspace(fixtureFiles);
    const config = testConfig();
    const services = createServices(config, { workspaceRoot: root });
    const registry = createToolRegistry();
    const app = createHttpServer({
      config,
      logger: pino({ level: 'silent' }),
      services,
      registry,
    });
    servers.push(app);
    const direct = await registry.invoke('get_file_skeleton', { path: 'example.ts' }, services, {
      requestId: 'direct',
      principal: 'test',
    });
    const overHttp = await app.inject({
      method: 'POST',
      url: '/tools/get_file_skeleton',
      headers: { 'x-api-key': testApiKey },
      payload: { path: 'example.ts' },
    });
    expect(overHttp.json().result).toEqual(direct);
  });

  it('wires an injectable application that drains on shutdown', async () => {
    const application = createApplication({
      config: testConfig(),
      logger: pino({ level: 'silent' }),
      workspaceRoot: await createWorkspace(fixtureFiles),
    });
    expect(application.registry.list()).toHaveLength(2);
    expect((await application.services.readiness()).ready).toBe(true);
    await application.shutdown();
  });
});
