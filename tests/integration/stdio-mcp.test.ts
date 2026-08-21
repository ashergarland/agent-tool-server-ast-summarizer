import { afterEach, describe, expect, it } from 'vitest';
import { StdioMcpClient } from '../helpers/stdio-client.js';
import { createWorkspace } from '../helpers/workspace.js';

/**
 * Local stdio MCP, exercised as VS Code exercises it: a real child process, real protocol traffic,
 * and no explicit workspace configuration so the documented `process.cwd()` default is under test.
 */

const clients: StdioMcpClient[] = [];

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
});

const connect = async (root: string): Promise<StdioMcpClient> => {
  const client = new StdioMcpClient(root);
  clients.push(client);
  await client.initialize();
  return client;
};

describe('stdio MCP entry point', () => {
  it('serves both tools from the launch directory and writes nothing but protocol to stdout', async () => {
    const root = await createWorkspace({
      'src/types.ts': 'export interface User { id: string }\n',
      'src/main.ts':
        "import type { User } from './types.js';\nexport function createUser(id: string): User { return { id }; }\n",
    });
    const client = await connect(root);

    const listed = await client.request('tools/list');
    const tools = (listed.result?.['tools'] ?? []) as { name: string; description?: string }[];
    expect(tools.map((tool) => tool.name).sort()).toEqual([
      'get_dependency_graph',
      'get_file_skeleton',
    ]);

    const skeleton = await client.request('tools/call', {
      name: 'get_file_skeleton',
      arguments: { path: 'src/main.ts' },
    });
    const structured = skeleton.result?.['structuredContent'] as {
      path: string;
      skeleton: string;
      complete: boolean;
    };
    expect(structured.path).toBe('src/main.ts');
    expect(structured.complete).toBe(true);
    expect(structured.skeleton).toContain('export function createUser(id: string): User;');
    expect(structured.skeleton).not.toContain('return { id }');

    const graph = await client.request('tools/call', {
      name: 'get_dependency_graph',
      arguments: { path: 'src/main.ts', maxDepth: 2 },
    });
    const graphResult = graph.result?.['structuredContent'] as { entry: string; files: string[] };
    expect(graphResult.entry).toBe('src/main.ts');
    expect(graphResult.files).toContain('src/types.ts');

    expect(client.nonProtocolOutput).toEqual([]);
  }, 120_000);

  it('refuses absolute paths and paths that leave the launch directory', async () => {
    const root = await createWorkspace({ 'a.ts': 'export const a: number = 1;\n' });
    const client = await connect(root);

    const absolute = await client.request('tools/call', {
      name: 'get_file_skeleton',
      arguments: { path: '/etc/passwd' },
    });
    expect(absolute.result?.['isError']).toBe(true);

    const escaping = await client.request('tools/call', {
      name: 'get_file_skeleton',
      arguments: { path: '../../../../etc/passwd' },
    });
    expect(escaping.result?.['isError']).toBe(true);
    const [content] = (escaping.result?.['content'] ?? []) as { text: string }[];
    const payload = JSON.parse(content?.text ?? '{}') as { code: string; message: string };
    expect(['forbidden', 'not_found', 'bad_request']).toContain(payload.code);
    expect(payload.message).not.toContain(root);

    expect(client.nonProtocolOutput).toEqual([]);
  }, 120_000);
});
