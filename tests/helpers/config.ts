import { generateTestApiKey } from '@agent-tool-platform/testkit';
import { loadAstConfig, type AstConfig } from '../../src/config/index.js';

/**
 * A credential strong enough for the platform to accept, generated once per test process so no
 * literal secret is ever committed.
 */
export const testApiKey = generateTestApiKey();

export const testEnv = (overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
  NODE_ENV: 'test',
  AUTH_MODE: 'api-key',
  API_KEYS: testApiKey,
  ...overrides,
});

export const testConfig = (overrides: NodeJS.ProcessEnv = {}): AstConfig =>
  loadAstConfig(testEnv(overrides));
