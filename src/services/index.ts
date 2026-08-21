import { BoundedSemaphore } from '@agent-tool-platform/runtime/concurrency';
import { supportedExtensions } from '../ast/language.js';
import { AstService } from '../ast/service.js';
import { Workspace } from '../ast/workspace.js';
import type { AstConfig } from '../config/index.js';

/**
 * AST domain resources.
 *
 * Only analysis state lives here. The tool registry, authentication, transports, lifecycle, and
 * readiness aggregation belong to the platform, so nothing in this module knows they exist.
 */
export interface AstServices {
  readonly ast: AstService;
  readonly workspace: Workspace;
  readonly semaphore: BoundedSemaphore;
}

export const createAstServices = (config: AstConfig): AstServices => {
  const workspace = new Workspace({
    root: config.workspace.root,
    maxFileBytes: config.analysis.limits.maxFileBytes,
    allowedExtensions: supportedExtensions,
  });
  const semaphore = new BoundedSemaphore(
    config.analysis.maxConcurrentJobs,
    config.analysis.maxQueuedJobs,
  );
  const ast = new AstService({
    workspace,
    ceilings: config.analysis.limits,
    semaphore,
    includePrivateMembers: config.analysis.includePrivateMembers,
    typeInference: config.analysis.typeInference,
  });
  return { ast, workspace, semaphore };
};
