/**
 * Async Rate Limiter — free tier discovery throttling (P008).
 *
 * Tracks API calls per wallet address with a daily limit.
 * In-memory, Workers-compatible. For production, replace with
 * a persistent store (Redis, DB).
 */

export interface RateLimitEntry {
  /** Wallet address (key). */
  wallet: string;
  /** Date string (YYYY-MM-DD) for the rate limit window. */
  date: string;
  /** Number of calls made in the window. */
  count: number;
  /** Limit per window. */
  limit: number;
}

class FreeTierRateLimiter {
  private entries = new Map<string, RateLimitEntry>();
  private defaultLimit: number;

  constructor(defaultLimit = 3) {
    this.defaultLimit = defaultLimit;
  }

  /** Get the current date string. */
  private today(): string {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  }

  /** Check if a wallet has remaining free tier calls. */
  allow(wallet: string): boolean {
    const todayStr = this.today();
    const key = `${wallet}:${todayStr}`;
    const entry = this.entries.get(key);

    if (!entry || entry.date !== todayStr) {
      // Fresh day — reset
      this.entries.set(key, {
        wallet,
        date: todayStr,
        count: 1,
        limit: this.defaultLimit,
      });
      return true;
    }

    if (entry.count >= entry.limit) {
      return false;
    }

    entry.count++;
    return true;
  }

  /** Get remaining calls for a wallet today. */
  remaining(wallet: string): number {
    const todayStr = this.today();
    const key = `${wallet}:${todayStr}`;
    const entry = this.entries.get(key);

    if (!entry || entry.date !== todayStr) {
      return this.defaultLimit;
    }

    return Math.max(0, entry.limit - entry.count);
  }

  /** Get rate limit header values for a response. */
  headers(wallet: string): {
    'X-RateLimit-Limit': string;
    'X-RateLimit-Remaining': string;
    'X-RateLimit-Reset': string;
  } {
    const remaining = this.remaining(wallet);
    // Reset at midnight UTC
    const now = new Date();
    const tomorrow = new Date(now);
    tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
    tomorrow.setUTCHours(0, 0, 0, 0);

    return {
      'X-RateLimit-Limit': String(this.defaultLimit),
      'X-RateLimit-Remaining': String(remaining),
      'X-RateLimit-Reset': String(Math.floor(tomorrow.getTime() / 1000)),
    };
  }

  /** Reset all rate limit entries (useful for testing). */
  clear(): void {
    this.entries.clear();
  }

  /** Clean up stale entries (older than 2 days). */
  cleanup(): number {
    const todayStr = this.today();
    let cleaned = 0;
    for (const [key] of this.entries.entries()) {
      // Parse date from key (wallet:YYYY-MM-DD)
      const datePart = key.split(':').pop();
      if (!datePart) continue;
      if (datePart < todayStr) {
        // More than 1 day old
        const daysDiff = Math.floor(
          (new Date(todayStr).getTime() - new Date(datePart).getTime()) / 86400000
        );
        if (daysDiff >= 1) {
          this.entries.delete(key);
          cleaned++;
        }
      }
    }
    return cleaned;
  }

  get size(): number {
    return this.entries.size;
  }
}

export const rateLimiter = new FreeTierRateLimiter(3);
