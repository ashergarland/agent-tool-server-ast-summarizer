#!/usr/bin/env node

import { startStdioAgentToolApplication } from '@agent-tool-platform/runtime/capability';
import { astSummarizerCapability } from '../capability.js';

/**
 * Local stdio entry point for VS Code and other MCP clients.
 *
 * Silent logging, local execution semantics, the application, the MCP server, the transport, signal
 * handling, and ordered shutdown are stdio mechanics rather than AST behaviour, so the platform
 * helper owns all of them. What remains is the one decision that is genuinely about analysing
 * source: which workspace a local run reads.
 *
 * That workspace defaults to the launch directory, so a client that simply spawns the server inside
 * a project analyses that project without being configured. A blank `AST_WORKSPACE_ROOT` is treated
 * as unset rather than as an invalid root, because an empty value left in a client configuration
 * would otherwise start a server that can never become ready.
 */
await startStdioAgentToolApplication(astSummarizerCapability, {
  env: {
    ...process.env,
    AST_WORKSPACE_ROOT: process.env['AST_WORKSPACE_ROOT']?.trim() || process.cwd(),
  },
});
