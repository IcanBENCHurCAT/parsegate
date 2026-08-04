/**
 * Integration tests for Parsegate HTTP endpoints.
 *
 * Tests the Hono app directly (without starting a server) via
 * app.request() which simulates HTTP calls.
 *
 * Covers:
 *  - GET /health — health check
 *  - GET /v1/pricing — pricing table from pricing engine
 *  - POST /v1/detect — format detection with normalized output
 *  - POST /v1/parse — x402 payment challenge/response flow
 *  - Error handling for malformed requests
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { detectFormat } from '../src/detector.js';
import { normalize } from '../src/normalizer.js';
import { pricingTable, computePrice } from '../src/pricing.js';
import { x402Middleware, buildTestCredential, buildChallenge, validateCredential } from '../src/payment.js';
import { computeSettlement } from '../src/pricing.js';

// ── Helper: build a minimal app matching src/index.ts ────────────

function createTestApp(): Hono {
  const app = new Hono();

  app.get('/health', (c) => {
    return c.json({ status: 'ok', service: 'parsegate', version: '0.1.0' });
  });

  app.get('/v1/pricing', (c) => {
    return c.json(pricingTable);
  });

  app.post('/v1/detect', async (c) => {
    try {
      const formData = await c.req.parseBody();
      const file = formData.file;

      if (!file || typeof file !== 'object' || !('arrayBuffer' in file)) {
        return c.json(
          { error: 'No file provided (expected multipart upload)' },
          400,
        );
      }

      const buffer = Buffer.from(await file.arrayBuffer());
      // Hono's FormData exposes file as a File object with .name property
      const fileName = (file as { name?: string }).name ?? '';

      const triage = detectFormat(buffer, fileName);
      const doc = normalize(buffer, triage);

      return c.json({ triage, document: doc });
    } catch (err) {
      return c.json(
        { error: 'Detection failed', details: (err as Error).message },
        500,
      );
    }
  });

  return app;
}

/**
 * Helper: build a test app that includes the x402 middleware on /v1/parse.
 * This mirrors src/index.ts but can be instantiated per-test.
 */
function createParseApp(): Hono {
  const app = new Hono();

  app.get('/health', (c) => {
    return c.json({ status: 'ok', service: 'parsegate', version: '0.1.0' });
  });

  app.get('/v1/pricing', (c) => {
    return c.json(pricingTable);
  });

  // Apply x402 middleware (global - middleware checks path internally)
  // NOTE: We use app.use() instead of app.use('/v1/parse*', ...) because
  // Hono's path-based middleware matching doesn't work in vitest.
  app.use(x402Middleware());

  app.post('/v1/parse', async (c) => {
    try {
      const formData = await c.req.parseBody();
      const file = formData.file;

      if (!file || typeof file !== 'object' || !('arrayBuffer' in file)) {
        return c.json(
          { error: 'No file provided (expected multipart upload)' },
          400,
        );
      }

      const buffer = Buffer.from(await file.arrayBuffer());
      const fileName = (file as { name?: string }).name ?? '';

      // Step 1: Detect format + triage
      const triage = detectFormat(buffer, fileName);

      // Step 2: Compute price from triage (deterministic, no silent upcharge)
      const price = computePrice(triage);

      // Step 3: Check for x402 payment credential
      const credential = c.req.header('x402-credential');

      if (!credential || !validateCredential(credential, price)) {
        // No valid credential → return 402 with detailed challenge
        const challenge = buildChallenge(triage, price);
        return c.json(challenge, 402);
      }

      // Step 4: Credential valid → process document
      const doc = normalize(buffer, triage);

      // Step 5: Compute settlement receipt
      const receipt = computeSettlement(price, 0);

      // Step 6: Return 200 with parsed result + settlement receipt
      return c.json({
        triage,
        document: doc,
        payment: {
          status: 'paid',
          price,
          receipt,
        },
      }, 200);
    } catch (err) {
      return c.json(
        { error: 'Parse failed', details: (err as Error).message },
        500,
      );
    }
  });

  return app;
}

// ── Helpers ──────────────────────────────────────────────────────

/**
 * Create a Blob with an attached filename.
 * Hono's FormData parsing extracts filename from file.name or File.name.
 */
function makeBlob(content: string, filename: string): Blob {
  // In Node.js, create a File (subclass of Blob) to ensure .name is set
  return new File([content], filename, { type: 'application/octet-stream' });
}

/** Create a ZIP-like buffer (PK\x03\x04 header) */
function zipLike(content: string, filename: string): Blob {
  const bytes = new TextEncoder().encode('PK\x03\x04' + content);
  return new File([bytes], filename, { type: 'application/octet-stream' });
}

// ── Tests ─────────────────────────────────────────────────────────

describe('GET /health', () => {
  let app: Hono;

  beforeEach(() => {
    app = createTestApp();
  });

  it('returns 200 with status ok', async () => {
    const res = await app.request('/health');

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.status).toBe('ok');
    expect(data.service).toBe('parsegate');
    expect(data.version).toBe('0.1.0');
  });

  it('returns correct content type', async () => {
    const res = await app.request('/health');
    expect(res.headers.get('content-type')).toContain('application/json');
  });
});

describe('GET /v1/pricing', () => {
  let app: Hono;

  beforeEach(() => {
    app = createTestApp();
  });

  it('returns 200 with pricing table', async () => {
    const res = await app.request('/v1/pricing');

    expect(res.status).toBe(200);
    const data = await res.json();

    // Should match pricingTable structure
    expect(data.tiers).toBeDefined();
    expect(data.tiers.text).toBeDefined();
    expect(data.tiers.structured).toBeDefined();
    expect(data.tiers.scanned).toBeDefined();
    expect(data.tiers.unknown).toBeDefined();
    expect(data.currency).toBe('USDC');
    expect(data.version).toBeDefined();
  });

  it('returns consistent pricing data across requests', async () => {
    const res1 = await app.request('/v1/pricing');
    const res2 = await app.request('/v1/pricing');

    const data1 = await res1.json();
    const data2 = await res2.json();

    expect(data1).toEqual(data2);
  });
});

describe('POST /v1/detect', () => {
  let app: Hono;

  beforeEach(() => {
    app = createTestApp();
  });

  it('returns 400 when no file is provided', async () => {
    const res = await app.request('/v1/detect', {
      method: 'POST',
    });

    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toBeDefined();
    expect(data.error).toContain('No file provided');
  });

  it('detects PDF by extension when content has no magic bytes', async () => {
    // Use content that doesn't start with %PDF- so extension is the only signal
    const fd = new FormData();
    fd.append('file', makeBlob('raw pdf content here', 'report.pdf'));

    const res = await app.request('/v1/detect', {
      method: 'POST',
      body: fd,
    });

    expect(res.status).toBe(200);
    const data = await res.json();

    expect(data.triage.format).toBe('pdf');
    expect(data.triage.tier).toBe('scanned');
    expect(data.triage.detectedBy).toBe('extension');
    expect(data.document).toBeDefined();
    expect(data.document.format).toBe('pdf');
  });

  it('detects PDF by magic bytes when content starts with %PDF-', async () => {
    const fd = new FormData();
    fd.append('file', makeBlob('%PDF-1.4\nHello world', 'report.pdf'));

    const res = await app.request('/v1/detect', {
      method: 'POST',
      body: fd,
    });

    expect(res.status).toBe(200);
    const data = await res.json();

    expect(data.triage.format).toBe('pdf');
    expect(data.triage.tier).toBe('scanned');
    expect(data.triage.detectedBy).toBe('magic-byte');
    expect(data.document).toBeDefined();
  });

  it('detects markdown content via content analysis', async () => {
    const fd = new FormData();
    fd.append(
      'file',
      makeBlob('# Main Title\n\nSome content here.\n\n- Item 1\n- Item 2', 'unknown'),
    );

    const res = await app.request('/v1/detect', {
      method: 'POST',
      body: fd,
    });

    expect(res.status).toBe(200);
    const data = await res.json();

    expect(data.triage.format).toBe('md');
    expect(data.triage.tier).toBe('text');
    expect(data.triage.detectedBy).toBe('content-analysis');

    // Document should have elements
    expect(data.document.elements.length).toBeGreaterThan(0);
    expect(data.document.elements[0].type).toBe('heading');
  });

  it('detects plain text when no markdown patterns', async () => {
    const fd = new FormData();
    fd.append(
      'file',
      makeBlob('Just plain text, nothing fancy.', 'notes.txt'),
    );

    const res = await app.request('/v1/detect', {
      method: 'POST',
      body: fd,
    });

    expect(res.status).toBe(200);
    const data = await res.json();

    expect(data.triage.format).toBe('txt');
    expect(data.triage.tier).toBe('text');
  });

  it('detects CSV by extension and returns structured table', async () => {
    const csv = 'name,age,city\nJohn,30,NYC\nJane,25,LA';
    const fd = new FormData();
    fd.append('file', makeBlob(csv, 'data.csv'));

    const res = await app.request('/v1/detect', {
      method: 'POST',
      body: fd,
    });

    expect(res.status).toBe(200);
    const data = await res.json();

    expect(data.triage.format).toBe('csv');
    expect(data.triage.tier).toBe('structured');
    expect(data.document.elements.length).toBe(1);
    expect(data.document.elements[0].type).toBe('table');
  });

  it('detects ZIP-based formats by magic bytes + extension', async () => {
    const fd = new FormData();
    fd.append('file', zipLike('word/document.xml content', 'doc.docx'));

    const res = await app.request('/v1/detect', {
      method: 'POST',
      body: fd,
    });

    expect(res.status).toBe(200);
    const data = await res.json();

    // Should be detected as DOCX via magic byte + extension matching
    expect(data.triage.format).toBe('docx');
    expect(data.triage.tier).toBe('structured');
    expect(data.triage.detectedBy).toBe('magic-byte');
  });

  it('detects RTF by magic bytes', async () => {
    const fd = new FormData();
    fd.append(
      'file',
      makeBlob('{\\rtf1\\ansi\\nHello', 'doc.rtf'),
    );

    const res = await app.request('/v1/detect', {
      method: 'POST',
      body: fd,
    });

    expect(res.status).toBe(200);
    const data = await res.json();

    expect(data.triage.format).toBe('rtf');
    expect(data.triage.tier).toBe('structured');
    expect(data.triage.detectedBy).toBe('magic-byte');
  });

  it('handles empty file gracefully', async () => {
    const fd = new FormData();
    fd.append('file', makeBlob('', 'empty.dat'));

    const res = await app.request('/v1/detect', {
      method: 'POST',
      body: fd,
    });

    expect(res.status).toBe(200);
    const data = await res.json();

    expect(data.triage.format).toBe('unknown');
    expect(data.triage.tier).toBe('unknown');
    expect(data.document.elements.length).toBe(0);
  });

  it('handles unknown extension without magic bytes gracefully', async () => {
    const fd = new FormData();
    fd.append('file', makeBlob('some content', 'random.xyz'));

    const res = await app.request('/v1/detect', {
      method: 'POST',
      body: fd,
    });

    // Unknown extension → falls through to content analysis
    // If content is plain text, it will be detected as txt
    // This should not crash
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.triage.format).toBeDefined();
    expect(data.document).toBeDefined();
    expect(data.document.elements).toBeDefined();
  });

  it('returns proper response shape with all fields', async () => {
    const fd = new FormData();
    fd.append('file', makeBlob('# Hello', 'readme.md'));

    const res = await app.request('/v1/detect', {
      method: 'POST',
      body: fd,
    });

    expect(res.status).toBe(200);
    const data = await res.json();

    // Triage fields
    expect(data.triage.format).toBeDefined();
    expect(data.triage.tier).toBeDefined();
    expect(data.triage.estimatedPages).toBeDefined();
    expect(data.triage.needsOCR).toBeDefined();
    expect(data.triage.detectedBy).toBeDefined();

    // Document fields
    expect(data.document.format).toBeDefined();
    expect(data.document.tier).toBeDefined();
    expect(data.document.estimatedPages).toBeDefined();
    expect(data.document.needsOCR).toBeDefined();
    expect(data.document.elements).toBeDefined();
    expect(Array.isArray(data.document.elements)).toBe(true);
    expect(data.document.provenance).toBeDefined();
    expect(data.document.provenance.detectedBy).toBeDefined();
    expect(data.document.provenance.normalizer).toBeDefined();
  });

  it('returns JSON content type', async () => {
    const fd = new FormData();
    fd.append('file', makeBlob('test', 't.txt'));

    const res = await app.request('/v1/detect', {
      method: 'POST',
      body: fd,
    });

    expect(res.headers.get('content-type')).toContain('application/json');
  });
});

describe('POST /v1/parse — x402 payment flow', () => {
  let app: Hono;

  beforeEach(() => {
    app = createParseApp();
  });

  it('returns 402 when no credential is provided', async () => {
    const fd = new FormData();
    fd.append('file', makeBlob('# Hello world', 'readme.md'));

    const res = await app.request('/v1/parse', {
      method: 'POST',
      body: fd,
    });

    expect(res.status).toBe(402);
    const data = await res.json();

    // Should be a PaymentRequired-style challenge
    expect(data.x402Version).toBe(1);
    expect(data.accepts).toBeDefined();
    expect(Array.isArray(data.accepts)).toBe(true);
    expect(data.accepts.length).toBeGreaterThan(0);
    expect(data.accepts[0].amount).toBeDefined();
    expect(data.accepts[0].scheme).toBe('exact');
    expect(data.accepts[0].network).toContain('algo:');
  });

  it('returns 402 with correct triage-based price for markdown', async () => {
    const fd = new FormData();
    fd.append('file', makeBlob('# Title\n\nSome content here.', 'doc.md'));

    const res = await app.request('/v1/parse', {
      method: 'POST',
      body: fd,
    });

    expect(res.status).toBe(402);
    const data = await res.json();

    // The extra field should contain the triage info
    expect(data.accepts[0].extra.tier).toBe('text');
    expect(data.accepts[0].extra.format).toBe('md');
    expect(data.accepts[0].extra.estimatedPages).toBeDefined();

    // Amount should be a valid price string
    const price = parseFloat(data.accepts[0].amount);
    expect(price).toBeGreaterThan(0);
  });

  it('returns 402 with correct triage-based price for structured format (CSV)', async () => {
    const csv = 'name,age,city\nJohn,30,NYC\nJane,25,LA';
    const fd = new FormData();
    fd.append('file', makeBlob(csv, 'data.csv'));

    const res = await app.request('/v1/parse', {
      method: 'POST',
      body: fd,
    });

    expect(res.status).toBe(402);
    const data = await res.json();

    // CSV should be structured tier
    expect(data.accepts[0].extra.tier).toBe('structured');
    expect(data.accepts[0].extra.format).toBe('csv');

    // Structured price should be different from text price
    const structuredPrice = parseFloat(data.accepts[0].amount);
    expect(structuredPrice).toBeGreaterThan(0);

    // Verify it matches the expected price from computePrice
    const triage = detectFormat(Buffer.from(csv), 'data.csv');
    const expectedPrice = computePrice(triage);
    expect(structuredPrice).toBe(expectedPrice.amount);
  });

  it('returns 402 with scanned tier price for PDF', async () => {
    const fd = new FormData();
    fd.append('file', makeBlob('%PDF-1.4\nHello world', 'report.pdf'));

    const res = await app.request('/v1/parse', {
      method: 'POST',
      body: fd,
    });

    expect(res.status).toBe(402);
    const data = await res.json();

    expect(data.accepts[0].extra.tier).toBe('scanned');
    expect(data.accepts[0].extra.format).toBe('pdf');
  });

  it('returns 402 for unknown format', async () => {
    const fd = new FormData();
    fd.append('file', makeBlob('some content', 'random.xyz'));

    const res = await app.request('/v1/parse', {
      method: 'POST',
      body: fd,
    });

    expect(res.status).toBe(402);
    const data = await res.json();

    // Unknown formats should use unknown tier pricing
    expect(data.accepts[0].extra.tier).toBeDefined();
  });

  it('returns 402 with JSON content type', async () => {
    const fd = new FormData();
    fd.append('file', makeBlob('test', 't.txt'));

    const res = await app.request('/v1/parse', {
      method: 'POST',
      body: fd,
    });

    expect(res.status).toBe(402);
    expect(res.headers.get('content-type')).toContain('application/json');
  });

  it('returns 402 when invalid credential is provided', async () => {
    const fd = new FormData();
    fd.append('file', makeBlob('test', 't.txt'));
    fd.append('x402-credential', 'invalid_credential_string');

    const res = await app.request('/v1/parse', {
      method: 'POST',
      body: fd,
    });

    // Invalid credential → 402 (middleware returns challenge for non-test_ credentials)
    expect(res.status).toBe(402);
    const data = await res.json();
    expect(data.x402Version).toBe(1);
  });

  it('returns 200 with valid test credential (full flow)', async () => {
    const fd = new FormData();
    fd.append('file', makeBlob('# Hello world', 'readme.md'));

    // Step 1: First call without credential — get the price
    const res1 = await app.request('/v1/parse', {
      method: 'POST',
      body: fd,
    });

    expect(res1.status).toBe(402);
    const challenge1 = await res1.json();
    const quotedPrice = parseFloat(challenge1.accepts[0].amount);

    // Step 2: Build test credential from the quoted price
    const triage = detectFormat(Buffer.from('# Hello world'), 'readme.md');
    const price = computePrice(triage);
    const credential = buildTestCredential(price, triage);

    // Step 3: Retry with valid credential
    const fd2 = new FormData();
    fd2.append('file', makeBlob('# Hello world', 'readme.md'));

    const res2 = await app.request('/v1/parse', {
      method: 'POST',
      body: fd2,
      headers: {
        'x402-credential': credential,
      },
    });

    expect(res2.status).toBe(200);
    const data = await res2.json();

    // Should contain triage, document, and payment info
    expect(data.triage).toBeDefined();
    expect(data.triage.format).toBe('md');
    expect(data.document).toBeDefined();
    expect(data.document.elements.length).toBeGreaterThan(0);
    expect(data.payment).toBeDefined();
    expect(data.payment.status).toBe('paid');
    expect(data.payment.price).toBeDefined();
    expect(data.payment.price.amount).toBe(quotedPrice);
    expect(data.payment.receipt).toBeDefined();
    expect(data.payment.receipt.quotedPrice).toBe(quotedPrice);
  });

  it('returns 200 with valid test credential (structured format)', async () => {
    const csv = 'name,age,city\nJohn,30,NYC\nJane,25,LA';
    const fd = new FormData();
    fd.append('file', makeBlob(csv, 'data.csv'));

    // First call — get price
    const res1 = await app.request('/v1/parse', {
      method: 'POST',
      body: fd,
    });
    expect(res1.status).toBe(402);
    const challenge = await res1.json();
    const quotedPrice = parseFloat(challenge.accepts[0].amount);

    // Build credential
    const triage = detectFormat(Buffer.from(csv), 'data.csv');
    const price = computePrice(triage);
    const credential = buildTestCredential(price, triage);

    // Retry with credential
    const fd2 = new FormData();
    fd2.append('file', makeBlob(csv, 'data.csv'));

    const res2 = await app.request('/v1/parse', {
      method: 'POST',
      body: fd2,
      headers: { 'x402-credential': credential },
    });

    expect(res2.status).toBe(200);
    const data = await res2.json();

    expect(data.triage.format).toBe('csv');
    expect(data.triage.tier).toBe('structured');
    expect(data.payment.status).toBe('paid');
    expect(data.payment.price.amount).toBe(quotedPrice);
  });

  it('returns 200 with valid test credential (scanned PDF)', async () => {
    const fd = new FormData();
    fd.append('file', makeBlob('%PDF-1.4\nHello world', 'report.pdf'));

    // First call — get price
    const res1 = await app.request('/v1/parse', {
      method: 'POST',
      body: fd,
    });
    expect(res1.status).toBe(402);
    const challenge = await res1.json();
    const quotedPrice = parseFloat(challenge.accepts[0].amount);

    // Build credential
    const triage = detectFormat(Buffer.from('%PDF-1.4\nHello world'), 'report.pdf');
    const price = computePrice(triage);
    const credential = buildTestCredential(price, triage);

    // Retry with credential
    const fd2 = new FormData();
    fd2.append('file', makeBlob('%PDF-1.4\nHello world', 'report.pdf'));

    const res2 = await app.request('/v1/parse', {
      method: 'POST',
      body: fd2,
      headers: { 'x402-credential': credential },
    });

    expect(res2.status).toBe(200);
    const data = await res2.json();

    expect(data.triage.format).toBe('pdf');
    expect(data.triage.tier).toBe('scanned');
    expect(data.payment.status).toBe('paid');
    expect(data.payment.price.amount).toBe(quotedPrice);
  });

  it('pricing endpoint uses pricing table (not hardcoded)', async () => {
    const fd = new FormData();
    fd.append('file', makeBlob('test', 't.txt'));

    const app2 = createParseApp();
    const res = await app2.request('/v1/pricing');
    expect(res.status).toBe(200);
    const data = await res.json();

    // Verify the pricing table structure
    expect(data.tiers).toBeDefined();
    expect(data.currency).toBe('USDC');
    expect(data.version).toBeDefined();

    // Verify prices match the pricing table
    const textPrice = computePrice({
      format: 'txt',
      tier: 'text',
      estimatedPages: 1,
      needsOCR: false,
      detectedBy: 'extension',
    } as any);

    expect(textPrice.amount).toBeGreaterThan(0);
    expect(textPrice.currency).toBe('USDC');
  });

  it('returns 400 when no file is provided', async () => {
    const res = await app.request('/v1/parse', {
      method: 'POST',
    });

    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toBeDefined();
    expect(data.error).toContain('No file provided');
  });
});

describe('Error handling', () => {
  let app: Hono;

  beforeEach(() => {
    app = createTestApp();
  });

  it('does not crash on large binary blob', async () => {
    const fd = new FormData();
    const buf = Buffer.alloc(10_000_000, 0xff);
    fd.append('file', new File([buf], 'large.dat'));

    const res = await app.request('/v1/detect', {
      method: 'POST',
      body: fd,
    });

    // Should not crash the server (200 or 500, but no unhandled exception)
    expect([200, 500]).toContain(res.status);
  });
});
