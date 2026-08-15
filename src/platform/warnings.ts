import { boundedMessage } from '../errors.js';

/**
 * Bounded, deduplicated diagnostics for callers. Warnings are aggregated by code so a pathological
 * file cannot produce an unbounded list.
 */

export interface Warning {
  readonly code: string;
  readonly message: string;
  readonly count: number;
}

const defaultMaxWarnings = 25;

export class WarningCollector {
  private readonly warnings = new Map<string, { message: string; count: number }>();
  private suppressed = 0;

  public constructor(private readonly maxWarnings: number = defaultMaxWarnings) {}

  public add(code: string, message: string): void {
    const existing = this.warnings.get(code);
    if (existing) {
      existing.count += 1;
      return;
    }
    if (this.warnings.size >= this.maxWarnings) {
      this.suppressed += 1;
      return;
    }
    this.warnings.set(code, { message: boundedMessage(message), count: 1 });
  }

  public get size(): number {
    return this.warnings.size;
  }

  public list(): readonly Warning[] {
    const entries = [...this.warnings.entries()]
      .map(([code, value]) => ({ code, message: value.message, count: value.count }))
      .sort((left, right) => left.code.localeCompare(right.code));
    return this.suppressed === 0
      ? entries
      : [
          ...entries,
          {
            code: 'warnings_suppressed',
            message: 'Additional warning categories were suppressed by the warning limit',
            count: this.suppressed,
          },
        ];
  }
}
