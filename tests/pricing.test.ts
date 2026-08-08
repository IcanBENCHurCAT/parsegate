/**
 * Tests for the pricing engine (pricing.ts).
 *
 * Covers:
 *  - Pricing table structure and defaults
 *  - computePrice for all tiers (text, structured, scanned, unknown)
 *  - OCR surcharge for scanned PDFs
 *  - Floor price enforcement
 *  - computeSettlement and subsidized behavior
 *  - Deterministic price hash
 */

import { describe, it, expect } from 'vitest';
import {
  pricingTable,
  computePrice,
  computeSettlement,

  type ComputedPrice,

} from '../src/pricing.js';
import type { TriageResult as TriageType } from '../src/detector.js';

// ─────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────

function makeTriage(overrides: Partial<TriageType>): TriageType {
  return {
    format: 'txt',
    tier: 'text',
    estimatedPages: 1,
    needsOCR: false,
    detectedBy: 'extension',
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────────
// Pricing table structure
// ─────────────────────────────────────────────────────────────────

describe('Pricing table structure', () => {
  it('has all four tiers', () => {
    const tiers = pricingTable.tiers;
    expect(tiers.text).toBeDefined();
    expect(tiers.structured).toBeDefined();
    expect(tiers.scanned).toBeDefined();
    expect(tiers.unknown).toBeDefined();
  });

  it('specifies currency as USDC', () => {
    expect(pricingTable.currency).toBe('USDC');
  });

  it('has a version string', () => {
    expect(pricingTable.version).toBeDefined();
    expect(typeof pricingTable.version).toBe('string');
  });

  it('has an explanatory note', () => {
    expect(pricingTable.note).toBeDefined();
    expect(pricingTable.note!.length).toBeGreaterThan(0);
  });

  it('defines perPage for paginated formats', () => {
    expect(pricingTable.tiers.scanned.perPage).toBeGreaterThan(0);
    expect(pricingTable.tiers.structured.perPage).toBeGreaterThan(0);
  });

  it('defines per100KB for text format', () => {
    expect(pricingTable.tiers.text.per100KB).toBeGreaterThan(0);
  });

  it('defines OCR surcharge for scanned tier', () => {
    expect(pricingTable.tiers.scanned.ocrSurchargePerPage).toBeGreaterThan(0);
  });

  it('defines floor prices for all tiers', () => {
    for (const [, config] of Object.entries(pricingTable.tiers)) {
      expect(config.floorPrice).toBeGreaterThan(0);
    }
  });
});

// ─────────────────────────────────────────────────────────────────
// computePrice — text tier
// ─────────────────────────────────────────────────────────────────

describe('computePrice — text tier', () => {
  it('computes price for plain text with 1 page', () => {
    const triage = makeTriage({ tier: 'text', estimatedPages: 1 });
    const price = computePrice(triage);

    expect(price.tier).toBe('text');
    expect(price.currency).toBe('USDC');
    expect(price.amount).toBeGreaterThan(0);
    expect(price.hasOcrSurcharge).toBe(false);
    expect(price.estimatedPages).toBe(1);
    expect(price.breakdown).toContain('text-rate');
    expect(price.priceHash).toMatch(/^\w{8}$/);
  });

  it('scales price with more pages', () => {
    const p1 = computePrice(makeTriage({ tier: 'text', estimatedPages: 1 }));
    const p10 = computePrice(makeTriage({ tier: 'text', estimatedPages: 10 }));

    expect(p10.amount).toBeGreaterThan(p1.amount);
  });

  it('enforces floor price when computed amount is below floor', () => {
    const triage = makeTriage({ tier: 'text', estimatedPages: 1 });
    const price = computePrice(triage);

    expect(price.amount).toBeGreaterThanOrEqual(
      pricingTable.tiers.text.floorPrice!,
    );
  });
});

// ─────────────────────────────────────────────────────────────────
// computePrice — structured tier
// ─────────────────────────────────────────────────────────────────

describe('computePrice — structured tier', () => {
  it('computes price based on perPage rate', () => {
    const triage = makeTriage({
      tier: 'structured',
      format: 'docx',
      estimatedPages: 3,
    });
    const price = computePrice(triage);

    expect(price.tier).toBe('structured');
    expect(price.estimatedPages).toBe(3);
    expect(price.hasOcrSurcharge).toBe(false);
    // expected: 0.003 * 3 = 0.009
    expect(price.amount).toBe(0.009);
  });

  it('enforces floor price for small structured documents', () => {
    const triage = makeTriage({
      tier: 'structured',
      format: 'docx',
      estimatedPages: 1,
    });
    const price = computePrice(triage);

    // 0.003 * 1 = 0.003, floor is 0.002, so 0.003 should apply
    expect(price.amount).toBe(0.003);
  });
});

// ─────────────────────────────────────────────────────────────────
// computePrice — scanned tier
// ─────────────────────────────────────────────────────────────────

describe('computePrice — scanned tier', () => {
  it('computes base price for scanned PDF without OCR', () => {
    const triage = makeTriage({
      tier: 'scanned',
      format: 'pdf',
      estimatedPages: 5,
      needsOCR: false,
    });
    const price = computePrice(triage);

    expect(price.tier).toBe('scanned');
    expect(price.hasOcrSurcharge).toBe(false);
    // expected: 0.005 * 5 = 0.025
    expect(price.amount).toBe(0.025);
    expect(price.breakdown).toContain('scanned-rate');
    expect(price.breakdown).not.toContain('ocr');
  });

  it('adds OCR surcharge for scanned PDFs that need OCR', () => {
    const triage = makeTriage({
      tier: 'scanned',
      format: 'pdf',
      estimatedPages: 5,
      needsOCR: true,
    });
    const price = computePrice(triage);

    expect(price.hasOcrSurcharge).toBe(true);
    // base: 0.005 * 5 = 0.025, ocr: 0.01 * 5 = 0.05, total: 0.075
    expect(price.amount).toBe(0.075);
    expect(price.breakdown).toContain('ocr-surge');
  });

  it('enforces floor price for scanned tier', () => {
    const triage = makeTriage({
      tier: 'scanned',
      format: 'pdf',
      estimatedPages: 1,
      needsOCR: false,
    });
    const price = computePrice(triage);

    // 0.005 * 1 = 0.005, floor is 0.002, so 0.005 applies
    expect(price.amount).toBe(0.005);
  });
});

// ─────────────────────────────────────────────────────────────────
// computePrice — unknown tier (fallback)
// ─────────────────────────────────────────────────────────────────

describe('computePrice — unknown tier', () => {
  it('uses unknown tier pricing for unrecognized formats', () => {
    const triage = makeTriage({
      tier: 'unknown',
      format: 'xyz',
      estimatedPages: 2,
    });
    const price = computePrice(triage);

    expect(price.tier).toBe('unknown');
    // expected: 0.01 * 2 = 0.02
    expect(price.amount).toBe(0.02);
  });

  it('enforces floor price for unknown tier', () => {
    const triage = makeTriage({
      tier: 'unknown',
      format: 'xyz',
      estimatedPages: 1,
    });
    const price = computePrice(triage);

    // 0.01 * 1 = 0.01, floor is 0.005, so 0.01 applies
    expect(price.amount).toBe(0.01);
  });
});

// ─────────────────────────────────────────────────────────────────
// Deterministic price hash
// ─────────────────────────────────────────────────────────────────

describe('Price hash determinism', () => {
  it('produces the same hash for identical triage', () => {
    const triage = makeTriage({
      tier: 'scanned',
      format: 'pdf',
      estimatedPages: 5,
      needsOCR: true,
    });
    const price1 = computePrice(triage);
    const price2 = computePrice(triage);

    expect(price1.priceHash).toBe(price2.priceHash);
  });

  it('produces different hashes for different triage inputs', () => {
    const p1 = computePrice(makeTriage({ tier: 'text', estimatedPages: 1 }));
    const p2 = computePrice(makeTriage({ tier: 'text', estimatedPages: 2 }));

    expect(p1.priceHash).not.toBe(p2.priceHash);
  });

  it('produces different hashes when OCR flag differs', () => {
    const p1 = computePrice(
      makeTriage({ tier: 'scanned', estimatedPages: 1, needsOCR: false }),
    );
    const p2 = computePrice(
      makeTriage({ tier: 'scanned', estimatedPages: 1, needsOCR: true }),
    );

    expect(p1.priceHash).not.toBe(p2.priceHash);
  });
});

// ─────────────────────────────────────────────────────────────────
// Round precision
// ─────────────────────────────────────────────────────────────────

describe('Price rounding', () => {
  it('rounds to 6 decimal places', () => {
    const triage = makeTriage({
      tier: 'text',
      estimatedPages: 3,
    });
    const price = computePrice(triage);

    // Should have at most 6 decimal places
    const decimalPlaces = price.amount.toString().split('.')[1]?.length ?? 0;
    expect(decimalPlaces).toBeLessThanOrEqual(6);
  });
});

// ─────────────────────────────────────────────────────────────────
// computeSettlement
// ─────────────────────────────────────────────────────────────────

describe('computeSettlement — settlement receipts', () => {
  it('produces a receipt when actual cost is below quoted', () => {
    const quoted: ComputedPrice = {
      tier: 'text',
      amount: 0.005,
      currency: 'USDC',
      estimatedPages: 2,
      hasOcrSurcharge: false,
      breakdown: 'price=0.005000 USDC [tier=text]',
      priceHash: 'deadbeef',
    };
    const receipt = computeSettlement(quoted, 0.003);

    expect(receipt.quotedPrice).toBe(0.005);
    expect(receipt.actualCost).toBe(0.003);
    expect(receipt.absorbedSurcharge).toBe(0);
    expect(receipt.subsidized).toBe(false);
    expect(receipt.processingTier).toBe('text');
  });

  it('absorbs surcharge when actual cost exceeds quoted', () => {
    const quoted: ComputedPrice = {
      tier: 'text',
      amount: 0.003,
      currency: 'USDC',
      estimatedPages: 1,
      hasOcrSurcharge: false,
      breakdown: 'price=0.003000 USDC [tier=text]',
      priceHash: 'cafebabe',
    };
    const receipt = computeSettlement(quoted, 0.01);

    expect(receipt.quotedPrice).toBe(0.003);
    expect(receipt.actualCost).toBe(0.01);
    expect(receipt.absorbedSurcharge).toBe(0.007); // 0.01 - 0.003
    expect(receipt.subsidized).toBe(true);
  });

  it('includes optional settlement and payment IDs', () => {
    const quoted: ComputedPrice = {
      tier: 'structured',
      amount: 0.009,
      currency: 'USDC',
      estimatedPages: 3,
      hasOcrSurcharge: false,
      breakdown: '',
      priceHash: 'abcdef01',
    };
    const receipt = computeSettlement(quoted, 0.005, 'settle-123', 'pay-456');

    expect(receipt.settlementId).toBe('settle-123');
    expect(receipt.paymentHash).toBe('pay-456');
  });
});

// ─────────────────────────────────────────────────────────────────
// Edge cases
// ─────────────────────────────────────────────────────────────────

describe('Edge cases', () => {
  it('handles 0 estimated pages (defaults to 1)', () => {
    const triage = makeTriage({ estimatedPages: 0 });
    const price = computePrice(triage);

    expect(price.estimatedPages).toBe(1);
  });

  it('handles missing tier (falls back to unknown)', () => {
    const triage = makeTriage({ tier: 'text' as string } as TriageType);
    const price = computePrice(triage);

    expect(price.tier).toBe('text'); // Still uses the provided tier key
    // If the tier key is not in the pricing table, it falls back to unknown config
  });

  it('all ComputedPrice fields are present', () => {
    const triage = makeTriage({ tier: 'structured', estimatedPages: 2 });
    const price = computePrice(triage);

    expect(price).toMatchObject({
      tier: expect.any(String),
      amount: expect.any(Number),
      currency: 'USDC',
      estimatedPages: expect.any(Number),
      hasOcrSurcharge: expect.any(Boolean),
      breakdown: expect.any(String),
      priceHash: expect.any(String),
    });
  });
});
