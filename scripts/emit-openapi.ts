import { writeFile } from 'node:fs/promises';
import { createAgentToolApplication } from '@agent-tool-platform/runtime/capability';
import { createSilentLogger } from '@agent-tool-platform/runtime/logging';
import { astSummarizerCapability } from '../src/capability.js';

/**
 * Emits the OpenAPI document the running server publishes at `/openapi.json`.
 *
 * The document is derived from the platform tool registry, so this script builds the real
 * application rather than a parallel description of it. No listener is bound.
 */
const application = await createAgentToolApplication(astSummarizerCapability, {
  logger: createSilentLogger(),
  env: {
    NODE_ENV: 'development',
    AUTH_MODE: 'disabled',
    SERVICE_VERSION: process.env['SERVICE_VERSION'] ?? '0.1.0',
    PUBLIC_BASE_URL: process.env['PUBLIC_BASE_URL'] ?? 'http://localhost:8080',
  },
});

const document = `${JSON.stringify(application.openApiDocument(), null, 2)}\n`;
const output = process.argv[2];

if (output) await writeFile(output, document, 'utf8');
else process.stdout.write(document);

await application.shutdown();
