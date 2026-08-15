import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadConfig } from '../config/index.js';
import { createServices } from '../services/index.js';
import { createToolRegistry } from '../tools/registry.js';
import { createMcpServer } from './server.js';

/**
 * Local stdio entry point for VS Code and other MCP clients.
 *
 * stdio is a local, non-networked transport owned by the process that launched it, so credentials
 * add nothing and authentication is disabled explicitly. The workspace defaults to the launch
 * directory; set AST_WORKSPACE_ROOT to scope one instance to a specific folder. Nothing is written
 * to stdout except protocol traffic.
 */

const config = loadConfig({
  ...process.env,
  AUTH_MODE: 'disabled',
  NODE_ENV: process.env.NODE_ENV === 'test' ? 'test' : 'development',
});

const services = createServices(config, {
  workspaceRoot: config.workspace.root ?? process.cwd(),
});

const server = createMcpServer(config, createToolRegistry(), services, {
  requestId: `stdio-${process.pid}`,
  principal: 'stdio-client',
});

const shutdown = (): void => {
  void (async (): Promise<void> => {
    await services.shutdown();
    await server.close();
    process.exit(0);
  })();
};

process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);

await server.connect(new StdioServerTransport());
