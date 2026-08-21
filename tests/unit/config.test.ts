import { describe, expect, it } from 'vitest';
import { ConfigurationError } from '@agent-tool-platform/runtime/config';
import { defaultLimits } from '../../src/ast/limits.js';
import { loadAstConfig } from '../../src/config/index.js';
import { testApiKey } from '../helpers/config.js';

describe('AST configuration', () => {
  it('applies conservative analysis defaults and ignores blank optional values', () => {
    const config = loadAstConfig({
      NODE_ENV: 'test',
      AUTH_MODE: 'api-key',
      API_KEYS: testApiKey,
      PUBLIC_BASE_URL: '',
      AST_WORKSPACE_ROOT: '',
    });
    expect(config.analysis.limits).toEqual(defaultLimits);
    expect(config.analysis.maxConcurrentJobs).toBe(2);
    expect(config.analysis.includePrivateMembers).toBe(false);
    expect(config.workspace.root).toBeUndefined();
    expect(config.service.publicBaseUrl).toBeUndefined();
  });

  it('keeps the platform configuration surface alongside the AST surface', () => {
    const config = loadAstConfig({ NODE_ENV: 'test', AUTH_MODE: 'disabled' });
    expect(config.service.name).toBe('agent-tool-server-ast-summarizer');
    expect(config.http.port).toBe(8080);
    expect(config.auth.mode).toBe('disabled');
    expect(config.logging.level).toBe('info');
    expect(config.mutations.enabled).toBe(false);
  });

  it('reads workspace and limit overrides from the environment', () => {
    const config = loadAstConfig({
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

  it('inherits platform production safety for authentication', () => {
    expect(() => loadAstConfig({ NODE_ENV: 'production', AUTH_MODE: 'disabled' })).toThrow(
      ConfigurationError,
    );
    expect(() =>
      loadAstConfig({ NODE_ENV: 'test', AUTH_MODE: 'api-key', API_KEYS: 'short' }),
    ).toThrow(ConfigurationError);
  });

  it('rejects an incoherent byte ceiling and invalid AST limit values', () => {
    expect(() =>
      loadAstConfig({
        NODE_ENV: 'test',
        AUTH_MODE: 'disabled',
        AST_MAX_FILE_BYTES: '2000',
        AST_MAX_TOTAL_BYTES: '1000',
      }),
    ).toThrow('AST_MAX_TOTAL_BYTES');
    expect(() =>
      loadAstConfig({ NODE_ENV: 'test', AUTH_MODE: 'disabled', AST_MAX_DECLARATIONS: '0' }),
    ).toThrow(ConfigurationError);
    expect(() =>
      loadAstConfig({
        NODE_ENV: 'test',
        AUTH_MODE: 'disabled',
        AST_TYPE_INFERENCE: 'whole-project',
      }),
    ).toThrow(ConfigurationError);
    expect(() =>
      loadAstConfig({
        NODE_ENV: 'test',
        AUTH_MODE: 'disabled',
        AST_INCLUDE_PRIVATE_MEMBERS: 'maybe',
      }),
    ).toThrow(ConfigurationError);
  });
});
