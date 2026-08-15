import type { MeasurementSink } from '../platform/measurements.js';
import { Deadline } from '../platform/cancellation.js';
import {
  Budget,
  resolveLimits,
  type AnalysisLimits,
  type LimitOverrides,
} from '../platform/limits.js';
import type { BoundedSemaphore } from '../platform/semaphore.js';
import { WarningCollector, type Warning } from '../platform/warnings.js';
import type { Workspace } from '../platform/workspace.js';
import { limitExceeded } from '../errors.js';
import { parseDiagnosticsOf, type ParseDiagnostic } from './diagnostics.js';
import {
  analyseDependencyGraph,
  type ExternalDependency,
  type GraphDiagnostic,
  type ResolvedDependency,
  type UnresolvedDependency,
} from './graph.js';
import { languageOf, parseSourceFile, type SourceLanguage } from './language.js';
import { DeclarationProjector, type Omission } from './projector.js';
import { SingleFileTypeResolver, noTypeResolver, type TypeResolver } from './type-text.js';

const maxDiagnostics = 20;
const maxTypeChars = 400;

export type TypeInferenceMode = 'off' | 'single-file';

export interface AstServiceOptions {
  readonly workspace: Workspace;
  readonly ceilings: AnalysisLimits;
  readonly semaphore: BoundedSemaphore;
  readonly includePrivateMembers: boolean;
  readonly typeInference: TypeInferenceMode;
  readonly measurements: MeasurementSink;
}

export interface AnalysisRequest {
  readonly path: string;
  readonly limits?: LimitOverrides;
  readonly signal?: AbortSignal;
}

export interface SkeletonRequest extends AnalysisRequest {
  readonly includePrivateMembers?: boolean;
}

export interface GraphRequest extends AnalysisRequest {
  readonly maxDepth?: number;
}

export interface AnalysisEnvelope {
  readonly truncated: boolean;
  readonly complete: boolean;
  readonly limitsReached: string[];
  readonly warnings: Warning[];
}

export interface SkeletonMetrics {
  readonly sourceBytes: number;
  readonly sourceLines: number;
  readonly skeletonChars: number;
  readonly declarationsDiscovered: number;
  readonly declarationsReturned: number;
  readonly declarationsOmitted: number;
}

export interface FileSkeleton extends AnalysisEnvelope {
  readonly path: string;
  readonly language: SourceLanguage;
  readonly skeleton: string;
  readonly originalLines: number;
  readonly skeletonLines: number;
  readonly metrics: SkeletonMetrics;
  readonly omissions: Omission[];
  readonly diagnostics: ParseDiagnostic[];
}

export interface GraphMetrics {
  readonly sourceBytes: number;
  readonly filesDiscovered: number;
  readonly filesReturned: number;
  readonly resolvedEdges: number;
  readonly externalEdges: number;
  readonly unresolvedEdges: number;
  readonly maxDepth: number;
}

export interface DependencyGraph extends AnalysisEnvelope {
  readonly entry: string;
  readonly files: string[];
  readonly dependencies: ResolvedDependency[];
  readonly external: ExternalDependency[];
  readonly unresolved: UnresolvedDependency[];
  readonly configPath: string | undefined;
  readonly diagnostics: GraphDiagnostic[];
  readonly metrics: GraphMetrics;
}

const countLines = (text: string): number => (text === '' ? 0 : text.split(/\r?\n/u).length);

/** Defers program construction so a file that needs no inference never pays for a checker. */
const lazyTypeResolver = (create: () => TypeResolver): TypeResolver => {
  let resolver: TypeResolver | undefined;
  const get = (): TypeResolver => (resolver ??= create());
  return {
    inferredTypeOf: (node) => get().inferredTypeOf(node),
    inferredReturnTypeOf: (node) => get().inferredReturnTypeOf(node),
  };
};

export class AstService {
  public constructor(private readonly options: AstServiceOptions) {}

  public get workspace(): Workspace {
    return this.options.workspace;
  }

  public async getFileSkeleton(request: SkeletonRequest): Promise<FileSkeleton> {
    return this.run('get_file_skeleton', request, async (budget, warnings, cancellation) => {
      const file = await this.options.workspace.resolveFile(request.path);
      if (!budget.tryConsumeBytes(file.sizeBytes)) {
        throw limitExceeded('The source file exceeds the cumulative byte budget for one request', {
          limit: 'maxTotalBytes',
        });
      }
      const source = await this.options.workspace.readFile(file);
      cancellation.throwIfCancelled();
      const sourceFile = parseSourceFile(file.realPath, source.text);
      const diagnostics = parseDiagnosticsOf(sourceFile, maxDiagnostics);
      if (diagnostics.length > 0) {
        warnings.add(
          'parse_diagnostics_present',
          'The file did not parse cleanly, so the projection is based on a recovered syntax tree',
        );
      }
      const projector = new DeclarationProjector(sourceFile, budget, warnings, {
        includePrivateMembers: request.includePrivateMembers ?? this.options.includePrivateMembers,
        maxTypeChars,
        cancellation,
        typeResolver:
          this.options.typeInference === 'single-file'
            ? lazyTypeResolver(() => new SingleFileTypeResolver(sourceFile, maxTypeChars))
            : noTypeResolver,
      });
      const projection = projector.project();
      const complete = diagnostics.length === 0 && !budget.truncated;
      return {
        result: {
          path: file.relativePath,
          language: languageOf(file.realPath),
          skeleton: projection.text,
          originalLines: countLines(source.text),
          skeletonLines: countLines(projection.text),
          truncated: budget.truncated,
          complete,
          limitsReached: [...budget.limitsReached],
          warnings: [...warnings.list()],
          omissions: [...projection.omissions],
          diagnostics: [...diagnostics],
          metrics: {
            sourceBytes: source.bytes,
            sourceLines: countLines(source.text),
            skeletonChars: projection.text.length,
            declarationsDiscovered: projection.declarationsDiscovered,
            declarationsReturned: projection.declarationsReturned,
            declarationsOmitted: projection.declarationsOmitted,
          },
        },
        measurement: {
          sourceBytes: source.bytes,
          resultChars: projection.text.length,
          declarationsReturned: projection.declarationsReturned,
        },
      };
    });
  }

  public async getDependencyGraph(request: GraphRequest): Promise<DependencyGraph> {
    const overrides: LimitOverrides = {
      ...request.limits,
      ...(request.maxDepth === undefined ? {} : { maxDepth: request.maxDepth }),
    };
    return this.run(
      'get_dependency_graph',
      { ...request, limits: overrides },
      async (budget, warnings, cancellation) => {
        const root = await this.options.workspace.root();
        const entry = await this.options.workspace.resolveFile(request.path);
        const analysis = await analyseDependencyGraph(entry, {
          workspace: this.options.workspace,
          root,
          budget,
          warnings,
          cancellation,
          maxDiagnostics,
        });
        const discovered =
          analysis.files.length + analysis.dependencies.filter((edge) => !edge.traversed).length;
        return {
          result: {
            entry: analysis.entry,
            files: [...analysis.files],
            dependencies: [...analysis.dependencies],
            external: [...analysis.external],
            unresolved: [...analysis.unresolved],
            configPath: analysis.configPath,
            diagnostics: [...analysis.diagnostics],
            truncated: budget.truncated,
            complete: analysis.diagnostics.length === 0 && !budget.truncated,
            limitsReached: [...budget.limitsReached],
            warnings: [...warnings.list()],
            metrics: {
              sourceBytes: analysis.sourceBytes,
              filesDiscovered: discovered,
              filesReturned: analysis.files.length,
              resolvedEdges: analysis.dependencies.length,
              externalEdges: analysis.external.length,
              unresolvedEdges: analysis.unresolved.length,
              maxDepth: budget.limits.maxDepth,
            },
          },
          measurement: {
            sourceBytes: analysis.sourceBytes,
            filesVisited: analysis.files.length,
          },
        };
      },
    );
  }

  /** Applies admission control, the deadline, limit resolution, and safe measurement. */
  private async run<T extends AnalysisEnvelope>(
    tool: string,
    request: AnalysisRequest,
    work: (
      budget: Budget,
      warnings: WarningCollector,
      cancellation: Deadline,
    ) => Promise<{ result: T; measurement: Record<string, number> }>,
  ): Promise<T> {
    const startedAt = Date.now();
    const { limits, clamped } = resolveLimits(this.options.ceilings, request.limits);
    const budget = new Budget(limits);
    const warnings = new WarningCollector();
    for (const name of clamped) {
      warnings.add(
        'limit_clamped',
        `A requested limit exceeded the deployment ceiling and was clamped: ${name}`,
      );
    }
    try {
      const outcome = await this.options.semaphore.run(async () => {
        const deadline = new Deadline(limits.requestTimeoutMs, request.signal);
        try {
          return await work(budget, warnings, deadline);
        } finally {
          deadline.dispose();
        }
      });
      this.options.measurements.record({
        name: 'ast.analysis',
        tool,
        outcome: 'ok',
        durationMs: Date.now() - startedAt,
        truncated: outcome.result.truncated,
        limitsReached: outcome.result.limitsReached,
        queueDepth: this.options.semaphore.stats.queued,
        activeJobs: this.options.semaphore.stats.active,
        ...outcome.measurement,
      });
      return outcome.result;
    } catch (error) {
      const code = (error as { code?: string }).code;
      this.options.measurements.record({
        name: 'ast.analysis',
        tool,
        outcome: code === 'busy' ? 'busy' : code === 'timeout' ? 'timeout' : 'error',
        errorCode: typeof code === 'string' ? code : 'internal_error',
        durationMs: Date.now() - startedAt,
        queueDepth: this.options.semaphore.stats.queued,
        activeJobs: this.options.semaphore.stats.active,
      });
      throw error;
    }
  }
}
