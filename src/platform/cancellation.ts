import { timedOut } from '../errors.js';

/**
 * Cooperative cancellation. Analysis is synchronous inside the compiler, so the deadline is
 * checked between work units rather than interrupting a running parse.
 */

export interface Cancellation {
  /** Throws a timeout error when the deadline has passed or the caller aborted. */
  throwIfCancelled(): void;
  readonly cancelled: boolean;
  readonly signal: AbortSignal;
  readonly remainingMs: number;
}

export class Deadline implements Cancellation {
  private readonly controller = new AbortController();
  private readonly expiresAtMs: number;
  private readonly timer: NodeJS.Timeout;
  private readonly detach: () => void;

  public constructor(timeoutMs: number, parent?: AbortSignal) {
    this.expiresAtMs = Date.now() + timeoutMs;
    this.timer = setTimeout(
      () => this.controller.abort(timedOut('Analysis deadline exceeded')),
      Math.max(0, timeoutMs),
    );
    this.timer.unref?.();
    if (parent) {
      const onAbort = (): void => this.controller.abort(parent.reason);
      if (parent.aborted) onAbort();
      else parent.addEventListener('abort', onAbort, { once: true });
      this.detach = (): void => parent.removeEventListener('abort', onAbort);
    } else {
      this.detach = (): void => undefined;
    }
  }

  public get signal(): AbortSignal {
    return this.controller.signal;
  }

  public get cancelled(): boolean {
    return this.controller.signal.aborted || Date.now() >= this.expiresAtMs;
  }

  public get remainingMs(): number {
    return Math.max(0, this.expiresAtMs - Date.now());
  }

  public throwIfCancelled(): void {
    if (!this.cancelled) return;
    const reason: unknown = this.controller.signal.reason;
    throw reason instanceof Error ? reason : timedOut('Analysis deadline exceeded');
  }

  public dispose(): void {
    clearTimeout(this.timer);
    this.detach();
  }
}

/** A cancellation that never fires; used by tests and by callers without a deadline. */
export const neverCancelled: Cancellation = {
  throwIfCancelled: () => undefined,
  cancelled: false,
  signal: new AbortController().signal,
  remainingMs: Number.POSITIVE_INFINITY,
};
