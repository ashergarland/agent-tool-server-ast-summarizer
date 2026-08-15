import { AstService } from '../ast/service.js';
import { supportedExtensions } from '../ast/language.js';
import type { AppConfig } from '../config/index.js';
import { noopMeasurementSink, type MeasurementSink } from '../platform/measurements.js';
import { BoundedSemaphore } from '../platform/semaphore.js';
import { Workspace } from '../platform/workspace.js';

export interface ReadinessCheck {
  readonly name: string;
  readonly ok: boolean;
  readonly detail?: string;
}

export interface ReadinessReport {
  readonly ready: boolean;
  readonly checks: readonly ReadinessCheck[];
}

export interface Services {
  readonly ast: AstService;
  readonly workspace: Workspace;
  readiness(): Promise<ReadinessReport>;
  shutdown(): Promise<void>;
}

export interface CreateServicesOptions {
  /** Overrides the configured root; stdio uses it to default to the launch directory. */
  readonly workspaceRoot?: string;
  readonly measurements?: MeasurementSink;
}

export const createServices = (
  config: AppConfig,
  options: CreateServicesOptions = {},
): Services => {
  const workspace = new Workspace({
    root: options.workspaceRoot ?? config.workspace.root,
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
    measurements: options.measurements ?? noopMeasurementSink,
  });

  return {
    ast,
    workspace,
    /** Readiness never reads or lists source; it only proves the boundary and capacity exist. */
    async readiness(): Promise<ReadinessReport> {
      const status = await workspace.status();
      const capacity = semaphore.accepting;
      const checks: ReadinessCheck[] = [
        { name: 'configuration', ok: true },
        {
          name: 'workspace',
          ok: status.usable,
          ...(status.reason === undefined ? {} : { detail: status.reason }),
        },
        {
          name: 'analysis_capacity',
          ok: capacity,
          ...(capacity ? {} : { detail: 'analysis_queue_saturated' }),
        },
      ];
      return { ready: checks.every((check) => check.ok), checks };
    },
    async shutdown(): Promise<void> {
      await semaphore.drain();
    },
  };
};
