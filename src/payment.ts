/**
 * x402 Payment Middleware for Parsegate (P004).
 *
 * Implements the x402 challenge/response flow on /v1/parse:
 *   1. First call (no credential) → 402 with PaymentRequired challenge
 *   2. Retry with valid credential → process document → 200 with result + receipt
 *   3. Invalid credential → 402 with retry challenge
 *
 * Uses @x402 types from @x402/core and @x402/hono for compatibility.
 * In development/test mode, accepts a `test_`-prefixed credential for testing.
 */

import { Context } from 'hono';
import { detectFormat } from './detector.js';
import { normalize } from './normalizer.js';
import {
  pricingTable,
  type ComputedPrice,
  type SettlementReceipt,
} from './pricing.js';

// ─────────────────────────────────────────────────────────────────
// Types (mirrors @x402/core PaymentRequirements)
// ─────────────────────────────────────────────────────────────────

/** A single payment requirement (mirrors @x402/core's PaymentRequirements) */
export interface PaymentRequirement {
  scheme: string;
  network: string;
  asset: string;
  amount: string;
  payTo: string;
  maxTimeoutSeconds: number;
  extra: Record<string, unknown>;
}

/** Challenge returned in the 402 response (mirrors @x402/core's PaymentRequired) */
export interface PaymentChallenge {
  x402Version: number;
  error?: string;
  description?: string;
  resource: string;
  accepts: PaymentRequirement[];
}

/** Credential presented by the client on retry */
export interface ParsedCredential {
  version: number;
  amount: string;
  scheme: string;
  network: string;
  secret: string;
  priceHash?: string;
  description?: string;
}

/** Result of a successful parse (sent in the 200 response) */
export interface ParseResponse {
  triage: ReturnType<typeof detectFormat>;
  document: ReturnType<typeof normalize>;
  payment: {
    status: 'paid';
    price: ComputedPrice;
    receipt: SettlementReceipt;
  };
}

// ─────────────────────────────────────────────────────────────────
// Test-mode credential helpers
// ─────────────────────────────────────────────────────────────────

const TEST_SECRET = 'parsegate-x402-secret';

/**
 * Build a test-mode credential string.
 * Format: test_<base64-encoded-credential-json>
 *
 * The client (or test code) encodes the price, scheme, network, and secret
 * so the server can verify payment was made for the correct amount.
 */
export function buildTestCredential(
  price: ComputedPrice,
  triage: ReturnType<typeof detectFormat>,
): string {
  const credential: ParsedCredential = {
    version: 1,
    amount: price.amount.toFixed(6),
    scheme: 'exact',
    network: 'algo:testnet',
    secret: TEST_SECRET,
    priceHash: price.priceHash,
    description: `Parsegate ${triage.format} processing`,
  };
  return `test_${Buffer.from(JSON.stringify(credential)).toString('base64url')}`;
}

/**
 * Validate a test-mode credential against a quoted price.
 * Returns the parsed credential or null if invalid.
 *
 * Validation checks:
 *   - Credential format (test_ prefix + base64url)
 *   - Amount matches quoted price (within floating-point tolerance)
 *   - Scheme is 'exact'
 *   - Network starts with 'algo:'
 *   - Secret matches test secret
 */
export function validateCredential(
  credential: string,
  price: ComputedPrice,
): ParsedCredential | null {
  if (!credential.startsWith('test_')) {
    return null;
  }

  const encoded = credential.slice(5);
  let parsed: ParsedCredential;
  try {
    parsed = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf-8'));
  } catch {
    return null;
  }

  // Verify amount matches quoted price (within floating-point tolerance)
  const quotedNumeric = parseFloat(parsed.amount);
  if (isNaN(quotedNumeric) || Math.abs(quotedNumeric - price.amount) > 0.000001) {
    return null;
  }

  // Verify scheme and network
  if (parsed.scheme !== 'exact' || !parsed.network.startsWith('algo:')) {
    return null;
  }

  // Verify the secret
  if (parsed.secret !== TEST_SECRET) {
    return null;
  }

  return parsed;
}

// ─────────────────────────────────────────────────────────────────
// Challenge Builder
// ─────────────────────────────────────────────────────────────────

/**
 * Build a PaymentChallenge from a triage result and computed price.
 * Returns the body that should be sent in a 402 response.
 */
export function buildChallenge(
  triage: ReturnType<typeof detectFormat>,
  price: ComputedPrice,
): PaymentChallenge {
  return {
    x402Version: 1,
    error: 'Payment Required',
    description: `Parsegate document processing (${triage.format})`,
    resource: '/v1/parse',
    accepts: [
      {
        scheme: 'exact',
        network: 'algo:testnet',
        asset: 'USDC',
        amount: price.amount.toFixed(6),
        payTo: 'PARSEGATE_RECEIVER_WALLET',
        maxTimeoutSeconds: 3600,
        extra: {
          tier: triage.tier,
          estimatedPages: triage.estimatedPages,
          needsOCR: triage.needsOCR,
          priceHash: price.priceHash,
          format: triage.format,
          breakdown: price.breakdown,
        },
      },
    ],
  };
}

// ─────────────────────────────────────────────────────────────────
// x402 Middleware
// ─────────────────────────────────────────────────────────────────

/**
 * x402 payment middleware for the /v1/parse endpoint.
 *
 * Intercepts requests before the handler:
 *   - No credential → returns 402 with PaymentRequired challenge
 *   - Valid test credential → calls next() to let handler process
 *   - Invalid credential → returns 402 with retry challenge
 *
 * The middleware handles only credential presence/absence. The handler
 * computes triage, calculates exact price, and fully validates credentials.
 */
export function x402Middleware() {
  return async (c: Context, next: () => Promise<void>) => {
    // Only intercept /v1/parse requests (path-based matching)
    // NOTE: We check the path ourselves instead of relying on
    // app.use('/v1/parse*', ...) because Hono's path-based middleware
    // matching does not work correctly in vitest.
    const path = c.req.path;
    if (path !== '/v1/parse' && !path.startsWith('/v1/parse?')) {
      return next();
    }

    // Check for x402 credential header.
    // We only validate credential FORMAT when present — we never block
    // missing credentials here. The handler computes triage/price and
    // returns the detailed 402 challenge (with tier, format, etc.).
    const credential = c.req.header('x402-credential');

    if (credential && !credential.startsWith('test_')) {
      // Unrecognized credential format → return 402 challenge
      return c.json(
        {
          x402Version: 1,
          error: 'Payment Required',
          message: 'Invalid credential format.',
          accepts: [
            {
              scheme: 'exact',
              network: 'algo:testnet',
              asset: 'USDC',
              amount: (pricingTable.tiers.unknown.floorPrice ?? 0).toFixed(6),
              payTo: 'PARSEGATE_RECEIVER_WALLET',
              maxTimeoutSeconds: 3600,
            },
          ],
        },
        402,
      );
    }

    // No credential or valid test credential → let handler process
    return next();
  };
}

// ─────────────────────────────────────────────────────────────────
// Route Configuration (for @x402/hono integration)
// ─────────────────────────────────────────────────────────────────

/**
 * x402 route configuration for the /v1/parse endpoint.
 *
 * This configures the route for use with @x402/hono's payment middleware.
 * In production, the price would be a DynamicPrice function that computes
 * the triage-based price at request time.
 */
export const x402RouteConfig = {
  accepts: {
    scheme: 'exact',
    payTo: 'PARSEGATE_RECEIVER_WALLET',
    price: 0.005, // Base price; actual price computed per-request via triage
    network: 'algo:testnet' as const,
    maxTimeoutSeconds: 3600,
  },
  description: 'Document-to-structured-data parsing endpoint',
  mimeType: 'application/octet-stream',
  tags: ['parsegate', 'x402', 'document-parsing'],
};

// ─────────────────────────────────────────────────────────────────
// Re-exports from @x402 packages for consumer convenience
// ─────────────────────────────────────────────────────────────────

/** Re-export @x402 types for compatibility */
export type { PaymentPayload, PaymentRequirements } from '@x402/core/types';
export type { RouteConfig, RoutesConfig } from '@x402/core/server';
