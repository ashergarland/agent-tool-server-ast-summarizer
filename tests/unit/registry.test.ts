import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { AppError } from '../../src/errors.js';
import { createServices } from '../../src/services/index.js';
import { defineTool } from '../../src/tools/definitions.js';
import { createToolRegistry, ToolRegistry } from '../../src/tools/registry.js';
import { createWorkspace } from '../helpers/workspace.js';
import { testConfig } from '../helpers/config.js';

const context = { requestId: 'test', principal: 'tester' };

describe('tool registry', () => {
  it('exposes unique read-only definitions and schemas', () => {
    const registry = createToolRegistry();
    expect(registry.list().map((tool) => tool.name)).toEqual([
      'get_file_skeleton',
      'get_dependency_graph',
    ]);
    expect(registry.list().every((tool) => tool.kind === 'read')).toBe(true);
    expect(registry.list().every((tool) => tool.inputJsonSchema['type'] === 'object')).toBe(true);
    expect(registry.list().every((tool) => tool.outputJsonSchema['type'] === 'object')).toBe(true);
  });

  it('validates input at the boundary and rejects unknown fields', async () => {
    const services = createServices(testConfig());
    await expect(
      createToolRegistry().invoke('get_file_skeleton', {}, services, context),
    ).rejects.toMatchObject({ code: 'bad_request' });
    await expect(
      createToolRegistry().invoke('get_file_skeleton', { path: 42 }, services, context),
    ).rejects.toMatchObject({ code: 'bad_request' });
    await expect(
      createToolRegistry().invoke(
        'get_dependency_graph',
        { path: 'a.ts', max_depth: 2 },
        services,
        context,
      ),
    ).rejects.toMatchObject({ code: 'bad_request' });
  });

  it('validates output at the boundary', async () => {
    const services = createServices(testConfig());
    const invalid = defineTool({
      name: 'invalid_output',
      title: 'Invalid',
      summary: 'Invalid',
      description: 'Invalid',
      kind: 'read',
      inputSchema: z.object({}),
      outputSchema: z.object({ ok: z.boolean() }),
      handler: async () => ({ ok: 'not-a-boolean' }) as never,
    });
    await expect(
      new ToolRegistry([invalid]).invoke('invalid_output', {}, services, context),
    ).rejects.toMatchObject({ code: 'internal_error' });
  });

  it('produces schema-valid results for both tools', async () => {
    const root = await createWorkspace({
      'src/a.ts': "import './b.js';\nexport const a: number = 1;\n",
      'src/b.ts': 'export const b: number = 2;\n',
    });
    const services = createServices(testConfig(), { workspaceRoot: root });
    const registry = createToolRegistry();
    for (const tool of registry.list()) {
      const result = await tool.invoke({ path: 'src/a.ts' }, services, context);
      expect(tool.outputSchema.safeParse(result).success).toBe(true);
    }
  });

  it('rejects duplicate and unknown tools', () => {
    const definition = createToolRegistry().list()[0]!;
    expect(() => new ToolRegistry([definition as never, definition as never])).toThrow('Duplicate');
    expect(() => createToolRegistry().get('missing')).toThrow(AppError);
  });

  it('reports a missing workspace as not ready rather than failing obscurely', async () => {
    const services = createServices(testConfig());
    await expect(
      createToolRegistry().invoke('get_file_skeleton', { path: 'a.ts' }, services, context),
    ).rejects.toMatchObject({ code: 'not_ready', retryable: true });
    expect(await services.readiness()).toMatchObject({ ready: false });
  });

  it('reports readiness once a usable workspace exists', async () => {
    const root = await createWorkspace({ 'a.ts': 'export const a: number = 1;\n' });
    const services = createServices(testConfig(), { workspaceRoot: root });
    const report = await services.readiness();
    expect(report.ready).toBe(true);
    expect(report.checks.map((check) => check.name)).toEqual([
      'configuration',
      'workspace',
      'analysis_capacity',
    ]);
    await services.shutdown();
  });
});
