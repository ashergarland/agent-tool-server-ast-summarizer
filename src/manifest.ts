import type { CapabilityManifest } from '@agent-tool-platform/runtime/capability';

/**
 * Capability identity.
 *
 * Kept in its own module so the configuration loader can use it for `SERVICE_NAME` and
 * `SERVICE_VERSION` defaults without importing the capability definition, which itself needs the
 * configuration type.
 */
export const astManifest: CapabilityManifest = {
  name: 'agent-tool-server-ast-summarizer',
  version: '0.0.0-development',
  title: 'AST Summarizer',
  description:
    'Read-only TypeScript and JavaScript structure analysis for one local workspace: declaration-only file skeletons and local dependency graphs.',
  documentationUrl: 'https://github.com/ashergarland/agent-tool-server-ast-summarizer#readme',
};
