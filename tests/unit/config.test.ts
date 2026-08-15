import { describe, expect, it } from 'vitest';
import {
  buildConfig,
  ConfigurationError,
  envSchema,
  loadConfig,
  withoutBlankValues,
} from '../../src/config/index.js';
import { defaultLimits } from '../../src/platform/limits.js';

describe('configuration', () => {
  it('applies conservative analysis defaults and ignores blank optional values', () => {
    const config = loadConfig({
      NODE_ENV: 'test',
      AUTH_MODE: 'api-key',
      API_KEYS: '12345678901234567890123456789012',
      PUBLIC_BASE_URL: '',
    });
    expect(config.analysis.limits).toEqual(defaultLimits);
    expect(config.analysis.maxConcurrentJobs).toBe(2);
    expect(config.analysis.includePrivateMembers).toBe(false);
    expect(config.workspace.root).toBeUndefined();
    expect(config.service.publicBaseUrl).toBeUndefined();
    expect(withoutBlankValues({ A: '', B: 'x' })).toEqual({ B: 'x' });
  });

  it('reads workspace and limit overrides from the environment', () => {
    const config = loadConfig({
      NODE_ENV: 'test',
      AUTH_MODE: 'disabled',
      AST_WORKSPACE_ROOT: '/srv/workspace',
      AST_MAX_DEPTH: '3',
      AST_MAX_QUEUED_JOBS: '0',
      AST_INCLUDE_PRIVATE_MEMBERS: 'True',
      AST_TYPE_INFERENCE: 'off',
    });
    expect(config.workspace.root).toBe('/srv/workspace');
    expect(config.analysis.limits.maxDepth).toBe(3);
    expect(config.analysis.maxQueuedJobs).toBe(0);
    expect(config.analysis.includePrivateMembers).toBe(true);
    expect(config.analysis.typeInference).toBe('off');
  });

  it('rejects disabled production authentication', () => {
    expect(() =>
      buildConfig(envSchema.parse({ NODE_ENV: 'production', AUTH_MODE: 'disabled' })),
    ).toThrow(ConfigurationError);
  });

  it('requires strong API keys', () => {
    expect(() =>
      buildConfig(envSchema.parse({ NODE_ENV: 'test', AUTH_MODE: 'api-key', API_KEYS: 'short' })),
    ).toThrow('at least 32');
  });

  it('rejects an incoherent byte ceiling and invalid limit values', () => {
    expect(() =>
      buildConfig(
        envSchema.parse({
          NODE_ENV: 'test',
          AUTH_MODE: 'disabled',
          AST_MAX_FILE_BYTES: '2000',
          AST_MAX_TOTAL_BYTES: '1000',
        }),
      ),
    ).toThrow('AST_MAX_TOTAL_BYTES');
    expect(() =>
      loadConfig({ NODE_ENV: 'test', AUTH_MODE: 'disabled', AST_MAX_DECLARATIONS: '0' }),
    ).toThrow(ConfigurationError);
    expect(() =>
      loadConfig({ NODE_ENV: 'test', AUTH_MODE: 'disabled', AST_TYPE_INFERENCE: 'whole-project' }),
    ).toThrow(ConfigurationError);
  });
});
