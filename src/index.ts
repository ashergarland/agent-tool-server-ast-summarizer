import { startAgentToolApplication } from '@agent-tool-platform/runtime';
import { astSummarizerCapability } from './capability.js';

/**
 * Hosted HTTP entry point.
 *
 * Configuration loading, logging, the tool registry, authentication, rate limiting, OpenAPI, MCP
 * over Streamable HTTP, readiness, signal handling, request draining, and listener shutdown all
 * belong to the platform. This file exists only to name the capability being served.
 */
await startAgentToolApplication(astSummarizerCapability);
