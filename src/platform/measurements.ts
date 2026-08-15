/**
 * Measurement seam.
 *
 * Only safe, low-cardinality fields are recorded: never a path, filename, source text, tool
 * argument, result, or credential. The full portfolio telemetry plan is intentionally out of scope
 * here; this interface exists so it can be attached later without touching analysis code.
 */

export type MeasurementOutcome = 'ok' | 'error' | 'busy' | 'timeout';

export interface MeasurementEvent {
  readonly name: string;
  readonly tool?: string;
  readonly outcome?: MeasurementOutcome;
  readonly errorCode?: string;
  readonly durationMs?: number;
  readonly sourceBytes?: number;
  readonly resultChars?: number;
  readonly filesVisited?: number;
  readonly declarationsReturned?: number;
  readonly truncated?: boolean;
  readonly limitsReached?: readonly string[];
  readonly queueDepth?: number;
  readonly activeJobs?: number;
}

export interface MeasurementSink {
  record(event: MeasurementEvent): void;
}

export const noopMeasurementSink: MeasurementSink = { record: () => undefined };
