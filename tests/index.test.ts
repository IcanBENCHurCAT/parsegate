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
 *  - Error handling for malformed requests
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { detectFormat } from '../src/detector.js';
import { normalize } from '../src/normalizer.js';
import { pricingTable } from '../src/pricing.js';

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

    expect(res.status).toBe(200);
    const data = await res.json();

    // Unknown extension → falls through to content analysis
    // If content is plain text, it will be detected as txt
    // This should not crash
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
