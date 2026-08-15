import { serverBusy } from '../errors.js';

/**
 * Bounded work admission. Analysis is CPU-bound and synchronous inside the compiler, so the number
 * of concurrent jobs must stay small and excess demand must be rejected rather than queued forever.
 */

export interface SemaphoreStats {
  readonly active: number;
  readonly queued: number;
  readonly maxConcurrent: number;
  readonly maxQueued: number;
}

interface Waiter {
  readonly resolve: () => void;
  readonly reject: (error: unknown) => void;
}

export class BoundedSemaphore {
  private active = 0;
  private readonly waiters: Waiter[] = [];
  private draining = false;

  public constructor(
    private readonly maxConcurrent: number,
    private readonly maxQueued: number,
  ) {}

  public get stats(): SemaphoreStats {
    return {
      active: this.active,
      queued: this.waiters.length,
      maxConcurrent: this.maxConcurrent,
      maxQueued: this.maxQueued,
    };
  }

  /** True when at least one more job can be admitted immediately or queued. */
  public get accepting(): boolean {
    return (
      !this.draining && (this.active < this.maxConcurrent || this.waiters.length < this.maxQueued)
    );
  }

  public async run<T>(work: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await work();
    } finally {
      this.release();
    }
  }

  /** Rejects new work and waits for in-flight jobs so shutdown never truncates a response. */
  public async drain(): Promise<void> {
    this.draining = true;
    while (this.waiters.length > 0) {
      this.waiters.shift()?.reject(serverBusy('The tool server is shutting down'));
    }
    while (this.active > 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
    }
  }

  private acquire(): Promise<void> {
    if (this.draining) return Promise.reject(serverBusy('The tool server is shutting down'));
    if (this.active < this.maxConcurrent) {
      this.active += 1;
      return Promise.resolve();
    }
    if (this.waiters.length >= this.maxQueued) {
      return Promise.reject(
        serverBusy('Analysis capacity is saturated; retry after a short delay', {
          maxConcurrent: this.maxConcurrent,
          maxQueued: this.maxQueued,
        }),
      );
    }
    return new Promise<void>((resolve, reject) => {
      this.waiters.push({
        resolve: () => {
          this.active += 1;
          resolve();
        },
        reject,
      });
    });
  }

  private release(): void {
    this.active -= 1;
    this.waiters.shift()?.resolve();
  }
}
