const TWENTY_FOUR_HOURS_MS = 1000 * 60 * 60 * 24;
const MAX_ENTRIES_BEFORE_CLEANUP = 10_000;

type ClockFn = () => number;

export class IdempotencyStore {
  private readonly seen = new Map<string, number>();
  private readonly clock: ClockFn;
  private readonly ttlMs: number;

  constructor(clock: ClockFn = Date.now, ttlMs: number = TWENTY_FOUR_HOURS_MS) {
    this.clock = clock;
    this.ttlMs = ttlMs;
  }

  has(key: string): boolean {
    const ts = this.seen.get(key);
    if (ts === undefined) return false;
    if (this.clock() - ts > this.ttlMs) {
      this.seen.delete(key);
      return false;
    }
    return true;
  }

  remember(key: string): void {
    this.seen.set(key, this.clock());
    if (this.seen.size > MAX_ENTRIES_BEFORE_CLEANUP) this.cleanup();
  }

  size(): number {
    return this.seen.size;
  }

  private cleanup(): void {
    const cutoff = this.clock() - this.ttlMs;
    for (const [k, ts] of this.seen) {
      if (ts < cutoff) this.seen.delete(k);
    }
  }
}
