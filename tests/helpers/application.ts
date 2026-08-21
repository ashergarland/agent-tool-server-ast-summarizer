import {
  createAgentToolApplication,
  type AgentToolApplication,
} from '@agent-tool-platform/runtime/capability';
import { createSilentLogger } from '@agent-tool-platform/runtime/logging';
import { astSummarizerCapability } from '../../src/capability.js';
import type { AstConfig } from '../../src/config/index.js';
import type { AstServices } from '../../src/services/index.js';
import { testEnv } from './config.js';
import { createWorkspace } from './workspace.js';

export type TestApplication = AgentToolApplication<AstConfig, AstServices>;

export const fixtureFiles = {
  'example.ts': "import './helper.js';\nexport function example(): number { return 1; }\n",
  'helper.ts': 'export const helper: number = 2;\n',
};

export interface TestApplicationOptions {
  readonly env?: NodeJS.ProcessEnv;
  /** Set false to exercise the hosted "no workspace configured" path. */
  readonly workspace?: boolean;
  readonly files?: Record<string, string>;
  /** Set false to hand back an unstarted application, which lifecycle conformance requires. */
  readonly start?: boolean;
}

/**
 * Builds the real capability application without binding a listener. Readiness caching is disabled
 * so a test observes the state it just created rather than a cached report.
 */
export const createTestApplication = async (
  options: TestApplicationOptions = {},
): Promise<TestApplication> => {
  const root =
    options.workspace === false ? undefined : await createWorkspace(options.files ?? fixtureFiles);
  const application = await createAgentToolApplication<AstServices, AstConfig>(
    astSummarizerCapability,
    {
      logger: createSilentLogger(),
      env: testEnv({
        ...(root === undefined ? {} : { AST_WORKSPACE_ROOT: root }),
        ...options.env,
      }),
      readinessCacheMs: 0,
      drainTimeoutMs: 1_000,
    },
  );
  if (options.start !== false) await application.start();
  return application;
};
