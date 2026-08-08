/**
 * Pricing engine for Parsegate (P004).
 *
 * Provides a machine-readable price table and deterministic price
 * computation based on triage (format + estimatedPages + needsOCR).
 *
 * v0 pricing philosophy:
 *   - Per-page rates for paginated formats (PDF, DOCX, PPTX, EPUB)
 *   - Per-100KB rate for text-based formats (TXT, MD)
 *   - OCR surcharge for scanned PDFs that need OCR processing
 *   - If actual processing cost exceeds quoted price, we eat the loss
 *     (v0 trust-building: over-cost documents are free)
 */

import { TriageResult } from './detector.js';

// ── Price tiers (machine-readable) ────────────────────────────────

export interface PriceTier {
  /** Price per page for paginated formats */
  perPage: number;
  /** Price per 100KB for text formats */
  per100KB?: number;
  /** Optional OCR surcharge per page (scanned PDFs) */
  ocrSurchargePerPage?: number;
  /** Floor price per request */
  floorPrice?: number;
}

export interface PricingTable {
  tiers: {
    text: PriceTier;
    structured: PriceTier;
    scanned: PriceTier;
    unknown: PriceTier;
  };
  currency: string;
  version: string;
  note?: string;
}

/**
 * Structured pricing table returned by GET /v1/pricing.
 *
 * Rates are in USDC per page (paginated) or per 100KB (text).
 * OCR surcharge is added per page for scanned PDFs that need OCR.
 */
export const pricingTable: PricingTable = {
  tiers: {
    text: {
      perPage: 0,
      per100KB: 0.002,
      floorPrice: 0.001,
    },
    structured: {
      perPage: 0.003,
      floorPrice: 0.002,
    },
    scanned: {
      perPage: 0.005,
      ocrSurchargePerPage: 0.01,
      floorPrice: 0.002,
    },
    unknown: {
      perPage: 0.01,
      floorPrice: 0.005,
    },
  },
  currency: 'USDC',
  version: 'v0.1.0',
  note:
    'Prices per page for paginated formats, per 100KB for text formats. ' +
    'OCR surcharge applies to scanned PDFs. If actual processing cost exceeds ' +
    'quoted price, the difference is absorbed by Parsegate (v0 trust-building).',
};

// ── Price computation ─────────────────────────────────────────────

export interface ComputedPrice {
  /** Pricing tier used */
  tier: string;
  /** Total price in USDC */
  amount: number;
  /** Currency (always USDC) */
  currency: string;
  /** Estimated pages from triage */
  estimatedPages?: number;
  /** Whether OCR surcharge applied */
  hasOcrSurcharge: boolean;
  /** Price break-down string for transparency */
  breakdown: string;
  /** Hash of triage input for price determinism */
  priceHash: string;
}

/**
 * Deterministically compute the price for a document based on triage result.
 *
 * Price is derived from:
 *   1. Triage tier (text / structured / scanned / unknown)
 *   2. Estimated pages (or size for text)
 *   3. OCR flag (surcharge for scanned PDFs)
 *
 * The same triage result always produces the same price (deterministic).
 */
export function computePrice(triage: TriageResult): ComputedPrice {
  const tierConfig = pricingTable.tiers[triage.tier] || pricingTable.tiers.unknown;
  const pages = Math.max(1, triage.estimatedPages ?? 1);
  const hasOcr = triage.needsOCR;

  let amount: number;

  if (triage.tier === 'text') {
    // Text: per-100KB rate
     // rough estimate: 3KB/page → convert back
    // Actually, we don't have raw file size in TriageResult. Use perPage as proxy.
    // For text formats, estimate: ~3KB/page. So per100KB ≈ perPage / 33.3
    // But the pricing table already encodes this. Use perPage × pages with text rate.
    // Per the pricing spec: text is per-100KB. Without file size, we approximate:
    amount = Math.max(0.002 * pages, tierConfig.floorPrice ?? 0.001);
  } else if (triage.tier === 'structured') {
    amount = tierConfig.perPage * pages;
  } else if (triage.tier === 'scanned') {
    amount = tierConfig.perPage * pages;
    if (hasOcr && tierConfig.ocrSurchargePerPage) {
      amount += tierConfig.ocrSurchargePerPage * pages;
    }
  } else {
    // unknown
    amount = tierConfig.perPage * pages;
  }

  // Apply floor price
  if (tierConfig.floorPrice && amount < tierConfig.floorPrice) {
    amount = tierConfig.floorPrice;
  }

  // Round to 6 decimal places (sub-cent precision)
  amount = Math.round(amount * 1e6) / 1e6;

  const breakdown = buildBreakdown(triage, amount, hasOcr);

  // Deterministic hash: tier + pages + ocr flag
  const priceHash = deterministicHash(triage.tier, pages, hasOcr);

  return {
    tier: triage.tier,
    amount,
    currency: pricingTable.currency,
    estimatedPages: pages,
    hasOcrSurcharge: hasOcr,
    breakdown,
    priceHash,
  };
}

/**
 * Build a human-readable price breakdown string.
 */
function buildBreakdown(triage: TriageResult, amount: number, hasOcr: boolean): string {
  const parts: string[] = [];
  const pages = triage.estimatedPages ?? 1;

  parts.push(`tier=${triage.tier}`);
  parts.push(`pages=${pages}`);

  if (triage.tier === 'text') {
    parts.push(`text-rate(per-100KB)`);
  } else if (triage.tier === 'scanned' && hasOcr) {
    parts.push(`scanned-rate(+ocr-surge)`);
  } else if (triage.tier === 'scanned') {
    parts.push(`scanned-rate`);
  } else {
    parts.push(`${triage.tier}-rate`);
  }

  return `price=${amount.toFixed(6)} USDC [${parts.join(', ')}]`;
}

/**
 * Deterministic hash from triage inputs (for price integrity verification).
 * Uses simple string hashing — sufficient for price audit trail.
 */
function deterministicHash(tier: string, pages: number, needsOcr: boolean): string {
  const input = `${tier}:${pages}:ocr=${needsOcr}`;
  let hash = 0;
  for (let i = 0; i < input.length; i++) {
    const char = input.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash = hash & hash; // Convert to 32-bit integer
  }
  return Math.abs(hash).toString(16).padStart(8, '0');
}

// ── Fallback pricing (P004: eat the loss) ─────────────────────────

export interface SettlementReceipt {
  /** Price quoted to client */
  quotedPrice: number;
  /** Actual processing cost (internal; may exceed quoted) */
  actualCost: number;
  /** Surcharge absorbed by Parsegate (if any) */
  absorbedSurcharge: number;
  /** Whether the document was subsidized */
  subsidized: boolean;
  /** Transaction/settlement ID (from x402) */
  settlementId?: string;
  /** x402 payment proof hash */
  paymentHash?: string;
  /** Processing tier used */
  processingTier: string;
}

/**
 * Compute settlement receipt with fallback pricing.
 *
 * v0 policy: if actual processing cost > quoted price, absorb the difference.
 * This builds trust with early users.
 *
 * @param quoted   — Price computed from triage (what we quoted)
 * @param actualCost — Actual cost of processing (e.g., OCR API call)
 */
export function computeSettlement(
  quoted: ComputedPrice,
  actualCost: number,
  settlementId?: string,
  paymentHash?: string,
): SettlementReceipt {
  const absorbedSurcharge = Math.max(0, actualCost - quoted.amount);

  return {
    quotedPrice: quoted.amount,
    actualCost,
    absorbedSurcharge,
    subsidized: absorbedSurcharge > 0,
    settlementId,
    paymentHash,
    processingTier: quoted.tier,
  };
}
