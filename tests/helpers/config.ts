import { buildConfig, envSchema, type AppConfig } from '../../src/config/index.js';

export const testApiKey = 'test-api-key-that-is-at-least-32-characters';

export const testConfig = (overrides: Record<string, unknown> = {}): AppConfig =>
  buildConfig(
    envSchema.parse({
      NODE_ENV: 'test',
      AUTH_MODE: 'api-key',
      API_KEYS: testApiKey,
      RATE_LIMIT_MAX: 120,
      ...overrides,
    }),
  );
