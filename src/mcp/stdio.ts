import { createAgentToolApplication } from '@agent-tool-platform/runtime/capability';
import { createSilentLogger } from '@agent-tool-platform/runtime/logging';
import { connectStdio } from '@agent-tool-platform/runtime/mcp';
import { astSummarizerCapability } from '../capability.js';

/**
 * Local stdio entry point for VS Code and other MCP clients.
 *
 * stdio is a local, non-networked transport owned by the process that launched it, so credentials
 * add nothing and authentication is disabled explicitly. The workspace defaults to the launch
 * directory; set AST_WORKSPACE_ROOT to scope one instance to a specific folder.
 *
 * The application is created but never bound to a port, and the logger is silent, so nothing but
 * protocol traffic reaches stdout.
 */

/**
 * Blank is treated as unset, matching the platform's environment parsing, so an empty
 * `AST_WORKSPACE_ROOT` falls back to the launch directory rather than leaving the server unusable.
 */
const stdioEnvironment = (source: NodeJS.ProcessEnv, cwd: string): NodeJS.ProcessEnv => {
  const configured = source['AST_WORKSPACE_ROOT']?.trim();
  return {
    ...source,
    AUTH_MODE: 'disabled',
    NODE_ENV: source['NODE_ENV'] === 'test' ? 'test' : 'development',
    AST_WORKSPACE_ROOT: configured === undefined || configured === '' ? cwd : configured,
  };
};

const application = await createAgentToolApplication(astSummarizerCapability, {
  logger: createSilentLogger(),
  env: stdioEnvironment(process.env, process.cwd()),
});

await application.start();
const server = application.createStdioServer();

const shutdown = (): void => {
  void (async (): Promise<void> => {
    await server.close();
    await application.shutdown();
    process.exit(0);
  })();
};

process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);

await connectStdio(server);
