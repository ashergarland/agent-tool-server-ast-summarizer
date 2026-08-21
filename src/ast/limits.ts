import { resolveCeilings } from '@agent-tool-platform/runtime/limits';

/**
 * AST deployment ceilings and per-request budgets. No compiler or AST imports.
 *
 * The ceilings themselves are domain knowledge: the platform has no opinion about what a
 * declaration or a dependency edge costs. Only the shape of "a caller may lower a ceiling but never
 * raise it" is shared, which is why {@link resolveLimits} delegates to the platform helper.
 */

export interface AnalysisLimits {
  /** Largest single source file that may be read, in bytes. */
  readonly maxFileBytes: number;
  /** Largest cumulative source volume for one request, in bytes. */
  readonly maxTotalBytes: number;
  /** Largest dependency traversal depth. Depth 0 analyses the entry file only. */
  readonly maxDepth: number;
  /** Largest number of files visited by one dependency traversal. */
  readonly maxFiles: number;
  /** Largest number of recorded dependency edges of any classification. */
  readonly maxEdges: number;
  /** Largest number of top-level declarations projected into one skeleton. */
  readonly maxDeclarations: number;
  /** Largest number of members retained per class, interface, enum, or module. */
  readonly maxMembersPerDeclaration: number;
  /** Largest retained documentation length per declaration, in characters. */
  readonly maxJsDocChars: number;
  /** Largest rendered result size, in characters. */
  readonly maxResultChars: number;
  /** Wall-clock deadline for one analysis, in milliseconds. */
  readonly requestTimeoutMs: number;
}

export type LimitName = keyof AnalysisLimits;

export const limitNames: readonly LimitName[] = [
  'maxDeclarations',
  'maxDepth',
  'maxEdges',
  'maxFileBytes',
  'maxFiles',
  'maxJsDocChars',
  'maxMembersPerDeclaration',
  'maxResultChars',
  'maxTotalBytes',
  'requestTimeoutMs',
];

/** Conservative defaults sized for a developer machine and a 0.25 vCPU / 0.5 GiB container. */
export const defaultLimits: AnalysisLimits = {
  maxFileBytes: 1_048_576,
  maxTotalBytes: 8_388_608,
  maxDepth: 8,
  maxFiles: 200,
  maxEdges: 2_000,
  maxDeclarations: 500,
  maxMembersPerDeclaration: 200,
  maxJsDocChars: 600,
  maxResultChars: 120_000,
  requestTimeoutMs: 15_000,
};

/** Per-call overrides may lower a ceiling but never raise it. */
export type LimitOverrides = Partial<Record<LimitName, number | undefined>>;

export interface ResolvedLimits {
  readonly limits: AnalysisLimits;
  /** Overrides that asked for more than the deployment allows and were clamped. */
  readonly clamped: readonly LimitName[];
}

export const resolveLimits = (
  ceilings: AnalysisLimits,
  overrides: LimitOverrides = {},
): ResolvedLimits => {
  const resolved = resolveCeilings<LimitName>(ceilings, overrides);
  return { limits: resolved.values, clamped: resolved.clamped };
};

/**
 * Tracks consumption for a single request. Every limit is checked before work is performed, so a
 * result is always a complete prefix rather than a sliced payload.
 */
export class Budget {
  private readonly reached = new Set<LimitName>();
  private consumedBytes = 0;

  public constructor(public readonly limits: AnalysisLimits) {}

  public get totalBytes(): number {
    return this.consumedBytes;
  }

  public get limitsReached(): readonly LimitName[] {
    return [...this.reached].sort();
  }

  public get truncated(): boolean {
    return this.reached.size > 0;
  }

  public markReached(name: LimitName): void {
    this.reached.add(name);
  }

  public has(name: LimitName): boolean {
    return this.reached.has(name);
  }

  /** Returns false and records the limit when the additional bytes would exceed the budget. */
  public tryConsumeBytes(bytes: number): boolean {
    if (this.consumedBytes + bytes > this.limits.maxTotalBytes) {
      this.markReached('maxTotalBytes');
      return false;
    }
    this.consumedBytes += bytes;
    return true;
  }

  /** Returns false and records the limit when `count` has already reached `name`. */
  public allows(name: LimitName, count: number): boolean {
    if (count >= this.limits[name]) {
      this.markReached(name);
      return false;
    }
    return true;
  }
}
