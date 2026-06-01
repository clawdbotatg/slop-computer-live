// Tiny in-memory token-bucket rate limiter. Same shape as the soft cap baked
// into ChatHistory.allow, pulled out for reuse by costlier paths (e.g. the
// AI-backed /tip parser). Per-key buckets refill continuously; a relay
// restart resets everything, which is fine for a soft abuse cap.

type Bucket = { ts: number; tokens: number };

export class TokenBucket {
  private buckets = new Map<string, Bucket>();

  /**
   * @param burst   max tokens (and starting balance) per key
   * @param refillPerSec tokens regained per second
   */
  constructor(
    private readonly burst: number,
    private readonly refillPerSec: number,
  ) {}

  private peek(key: string, now: number): number {
    const entry = this.buckets.get(key) ?? { ts: now, tokens: this.burst };
    const elapsed = (now - entry.ts) / 1000;
    return Math.min(this.burst, entry.tokens + elapsed * this.refillPerSec);
  }

  /** Try to spend a token. Returns false (and spends nothing) when empty. */
  allow(key: string, now = Date.now()): boolean {
    const tokens = this.peek(key, now);
    if (tokens < 1) {
      this.buckets.set(key, { ts: now, tokens });
      return false;
    }
    this.buckets.set(key, { ts: now, tokens: tokens - 1 });
    return true;
  }

  /** ms until the next token is available for this key (0 if one is ready). */
  retryInMs(key: string, now = Date.now()): number {
    const tokens = this.peek(key, now);
    if (tokens >= 1) return 0;
    return Math.ceil(((1 - tokens) / this.refillPerSec) * 1000);
  }
}
