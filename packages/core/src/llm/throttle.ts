const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export interface ThrottleOptions {
  /** Max LLM calls in flight at once (0 = unlimited). */
  maxConcurrent: number;
  /** Max HTTP requests per rolling window (0 = unlimited). Keeps free/low tiers under their RPM quota. */
  perWindow: number;
  windowMs?: number;
}

/** Process-wide limiter shared by every LLM call, so retries and parallel agents respect the quota. */
export class Throttle {
  private active = 0;
  private readonly waiting: (() => void)[] = [];
  private readonly stamps: number[] = [];
  private readonly windowMs: number;

  constructor(private readonly o: ThrottleOptions) {
    this.windowMs = o.windowMs ?? 60_000;
  }

  async withSlot<T>(fn: () => Promise<T>): Promise<T> {
    if (this.o.maxConcurrent > 0 && this.active >= this.o.maxConcurrent) {
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    }
    this.active++;
    try {
      return await fn();
    } finally {
      this.active--;
      this.waiting.shift()?.();
    }
  }

  /** Resolves when another request may be sent inside the rate window. */
  async waitForRate(): Promise<void> {
    if (this.o.perWindow <= 0) return;
    for (;;) {
      const now = Date.now();
      while (this.stamps.length > 0 && now - (this.stamps[0] ?? now) >= this.windowMs) this.stamps.shift();
      if (this.stamps.length < this.o.perWindow) {
        this.stamps.push(now);
        return;
      }
      await sleep((this.stamps[0] ?? now) + this.windowMs - now + 5);
    }
  }
}
