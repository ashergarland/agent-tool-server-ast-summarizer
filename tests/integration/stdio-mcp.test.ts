import { afterEach, describe, expect, it } from 'vitest';
import { StdioMcpClient } from '../helpers/stdio-client.js';
import { createWorkspace } from '../helpers/workspace.js';

/**
 * Local stdio MCP, exercised as VS Code exercises it: a real child process and real protocol
 * traffic. The workspace policy this entry point still owns is covered in all three of its states —
 * unset, blank, and explicitly configured — because the platform helper owns everything else.
 */

const clients: StdioMcpClient[] = [];

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
});

const connect = async (root: string, env: NodeJS.ProcessEnv = {}): Promise<StdioMcpClient> => {
  const client = new StdioMcpClient(root, env);
  clients.push(client);
  await client.initialize();
  return client;
};

/** Names the file a tool call actually reached, which is what proves which workspace was used. */
const skeletonOf = async (
  client: StdioMcpClient,
  path: string,
): Promise<{ isError: boolean; skeleton: string }> => {
  const response = await client.request('tools/call', {
    name: 'get_file_skeleton',
    arguments: { path },
  });
  const structured = response.result?.['structuredContent'] as { skeleton?: string } | undefined;
  return {
    isError: response.result?.['isError'] === true,
    skeleton: structured?.skeleton ?? '',
  };
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

  it('treats a blank AST_WORKSPACE_ROOT as unset and still uses the launch directory', async () => {
    const root = await createWorkspace({ 'blank.ts': 'export const blank: number = 1;\n' });
    const client = await connect(root, { AST_WORKSPACE_ROOT: '   ' });

    const result = await skeletonOf(client, 'blank.ts');
    expect(result.isError).toBe(false);
    expect(result.skeleton).toContain('blank');
    expect(client.nonProtocolOutput).toEqual([]);
  }, 120_000);

  it('lets an explicit AST_WORKSPACE_ROOT override the launch directory', async () => {
    const launched = await createWorkspace({
      'launched.ts': 'export const launched: number = 1;\n',
    });
    const configured = await createWorkspace({
      'configured.ts': 'export const configured: number = 2;\n',
    });
    const client = await connect(launched, { AST_WORKSPACE_ROOT: configured });

    const inConfigured = await skeletonOf(client, 'configured.ts');
    expect(inConfigured.isError).toBe(false);
    expect(inConfigured.skeleton).toContain('configured');

    // The launch directory is no longer the workspace, so its files are outside the boundary.
    const inLaunched = await skeletonOf(client, 'launched.ts');
    expect(inLaunched.isError).toBe(true);

    expect(client.nonProtocolOutput).toEqual([]);
  }, 120_000);

  it('shuts down cleanly when the client closes the pipe', async () => {
    const root = await createWorkspace({ 'a.ts': 'export const a: number = 1;\n' });
    const client = await connect(root);
    await skeletonOf(client, 'a.ts');

    const exit = await client.shutdown();
    expect(exit.code).toBe(0);
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
