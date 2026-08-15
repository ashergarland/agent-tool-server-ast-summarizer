import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, describe, expect, it } from 'vitest';
import { createMcpServer } from '../../src/mcp/server.js';
import { createServices } from '../../src/services/index.js';
import { serverInstructions } from '../../src/tools/guidance.js';
import { createToolRegistry } from '../../src/tools/registry.js';
import { testConfig } from '../helpers/config.js';
import { createWorkspace } from '../helpers/workspace.js';

const closeables: { close(): Promise<void> }[] = [];

afterEach(async () => Promise.all(closeables.splice(0).map((value) => value.close())));

const connect = async (root: string): Promise<Client> => {
  const config = testConfig();
  const server = createMcpServer(
    config,
    createToolRegistry(),
    createServices(config, { workspaceRoot: root }),
    { requestId: 'mcp-test', principal: 'test-client' },
  );
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  closeables.push(client, server);
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
};

describe('MCP adapter', () => {
  it('publishes routing instructions and read-only annotations', async () => {
    const client = await connect(
      await createWorkspace({ 'a.ts': 'export const a: number = 1;\n' }),
    );
    expect(client.getInstructions()).toBe(serverInstructions);
    const tools = await client.listTools();
    expect(tools.tools.map((tool) => tool.name).sort()).toEqual([
      'get_dependency_graph',
      'get_file_skeleton',
    ]);
    for (const tool of tools.tools) {
      expect(tool.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
      expect(tool.description?.length).toBeGreaterThan(200);
    }
  });

  it('returns structured content for both tools and maps failures to the error contract', async () => {
    const root = await createWorkspace({
      'src/a.ts': "import './b.js';\nexport const a: number = 1;\n",
      'src/b.ts': 'export const b: number = 2;\n',
    });
    const client = await connect(root);

    const skeleton = await client.callTool({
      name: 'get_file_skeleton',
      arguments: { path: 'src/a.ts' },
    });
    expect(skeleton.isError).not.toBe(true);
    expect(skeleton.structuredContent).toMatchObject({ path: 'src/a.ts', complete: true });

    const graph = await client.callTool({
      name: 'get_dependency_graph',
      arguments: { path: 'src/a.ts', maxDepth: 1 },
    });
    expect(graph.structuredContent).toMatchObject({ entry: 'src/a.ts' });

    const invalid = await client.callTool({ name: 'get_file_skeleton', arguments: {} });
    expect(invalid.isError).toBe(true);

    const escaping = await client.callTool({
      name: 'get_file_skeleton',
      arguments: { path: '../outside.ts' },
    });
    expect(escaping.isError).toBe(true);
    const [content] = escaping.content as { text: string }[];
    const payload = JSON.parse(content?.text ?? '{}') as { code: string; message: string };
    expect(payload.code).toBe('not_found');
    expect(payload.message).not.toContain(root);
  });
});
