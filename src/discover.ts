/**
 * Free tier discovery endpoint for agent-friendly self-service.
 * 3 calls/day per wallet address (unauthenticated).
 * Separates rate limits from paid path.
 */

import { Hono } from 'hono';
import type { DiscoverResponse, RateLimitInfo } from './types';

const FREE_TIER_LIMIT_PER_DAY = 3;
const FREE_TIER_DESCRIPTION = 'Free tier for agents to discover and test Parsegate';

/**
 * In-memory rate limit store: walletAddress -> { count, day }.
 * Keys are reset at midnight UTC each day.
 */
class FreeTierRateLimiter {
  private stores = new Map<string, { count: number; day: string }>();

  private getTodayKey(): string {
    return new Date().toISOString().split('T')[0];
  }

  private getResetAt(): string {
    // Next midnight UTC
    const now = new Date();
    const nextMidnight = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0, 0));
    nextMidnight.setDate(nextMidnight.getDate() + 1);
    return nextMidnight.toISOString();
  }

  getRateLimit(walletAddress: string): RateLimitInfo {
    const today = this.getTodayKey();
    const key = walletAddress.toLowerCase();
    const stored = this.stores.get(key);

    if (!stored || stored.day !== today) {
      // New day, reset count
      const info: RateLimitInfo = {
        walletAddress,
        callsToday: 0,
        limitPerDay: FREE_TIER_LIMIT_PER_DAY,
        remaining: FREE_TIER_LIMIT_PER_DAY,
        resetAt: this.getResetAt(),
      };
      this.stores.set(key, { count: 0, day: today });
      return info;
    }

    return {
      walletAddress,
      callsToday: stored.count,
      limitPerDay: FREE_TIER_LIMIT_PER_DAY,
      remaining: FREE_TIER_LIMIT_PER_DAY - stored.count,
      resetAt: this.getResetAt(),
    };
  }

  consume(walletAddress: string): boolean {
    const today = this.getTodayKey();
    const key = walletAddress.toLowerCase();
    const stored = this.stores.get(key);

    if (!stored || stored.day !== today) {
      this.stores.set(key, { count: 1, day: today });
      return true;
    }

    if (stored.count >= FREE_TIER_LIMIT_PER_DAY) {
      return false;
    }

    stored.count += 1;
    return true;
  }
}

export const freeTierLimiter = new FreeTierRateLimiter();

export const discoverApp = new Hono();

// Discover endpoint — returns service info + rate limit state
discoverApp.get('/v1/discover', (c) => {
  const walletAddress = c.req.query('wallet');

  let rateLimit: RateLimitInfo | undefined;
  if (walletAddress) {
    rateLimit = freeTierLimiter.getRateLimit(walletAddress);
  }

  const response: DiscoverResponse = {
    service: 'parsegate',
    version: '0.2.0',
    description: 'x402-native document-to-structured-data API with async processing and agent-friendly discovery',
    endpoints: {
      sync: '/v1/parse',
      async: '/v1/parse/async',
      poll: '/v1/jobs/:id',
      discover: '/v1/discover',
    },
    tiers: {
      free: {
        callsPerDay: FREE_TIER_LIMIT_PER_DAY,
        walletAddress: walletAddress || undefined,
        note: walletAddress ? (rateLimit && rateLimit.remaining > 0 ? 'You have calls remaining today' : 'Daily limit reached, reset at midnight UTC') : 'Include ?wallet=YOUR_WALLET to check your limit',
      },
      paid: {
        currency: 'USDC',
        perPage: { min: 0.004, max: 0.008 },
        per100kb: { min: 0.002, max: 0.002 },
        x402: 'Payment settles at submission via x402 protocol',
      },
    },
    features: [
      'Sync parse (document -> structured data)',
      'Async parse (job-based polling)',
      'Webhook callbacks on completion',
      'Free tier with rate limiting',
      'x402 payment integration',
      'Multiple document formats (PDF, DOCX, EPUB, Excel)',
      'OCR support for scanned documents',
      'Agent-friendly JSON responses',
    ],
  };

  return c.json(response);
});

// Rate limit check endpoint (useful for agents to check before making calls)
discoverApp.get('/v1/discover/rate-limit', (c) => {
  const walletAddress = c.req.query('wallet');
  if (!walletAddress) {
    return c.json({ error: 'wallet query parameter required' }, 400);
  }

  const rateLimit = freeTierLimiter.getRateLimit(walletAddress);
  return c.json(rateLimit);
});

// Consume a free tier call (called by discover endpoint when wallet is provided)
discoverApp.post('/v1/discover/consume', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const walletAddress = body.wallet as string;

  if (!walletAddress) {
    return c.json({ error: 'wallet required in request body' }, 400);
  }

  const allowed = freeTierLimiter.consume(walletAddress);
  if (!allowed) {
    const rateLimit = freeTierLimiter.getRateLimit(walletAddress);
    return c.json({
      error: 'Rate limit exceeded',
      message: `Free tier limit of ${FREE_TIER_LIMIT_PER_DAY} calls/day reached`,
      rateLimit,
    }, 429);
  }

  const rateLimit = freeTierLimiter.getRateLimit(walletAddress);
  return c.json({ allowed: true, rateLimit });
});
