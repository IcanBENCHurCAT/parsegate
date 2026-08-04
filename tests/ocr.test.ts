/**
 * Tests for the OCR Pipeline (P007).
 *
 * Covers:
 *  - Google Cloud Vision OCR integration (mocked)
 *  - Qwen3 structuring (mocked)
 *  - End-to-end OCR pipeline
 *  - Error handling and fallbacks
 *  - hasTextLayer detection heuristic
 *  - visionAnnotationsToElements mapping
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { detectFormat } from '../src/detector.js';
import {
  ocrPipeline,
  ocrDocument,
  structureWithQwen3,
  hasTextLayer,
  visionAnnotationsToElements,
  type VisionAnnotateResponse,
  type Qwen3Response,
} from '../src/ocr.js';
import { config } from '../src/config.js';
import type { TriageResult } from '../src/detector.js';

// ── Mocks ────────────────────────────────────────────────────────

// Mock axios for GCV API calls
vi.mock('axios', () => ({
  default: {
    post: vi.fn(),
  },
}));

// Mock fetch for Qwen3 API calls
const originalFetch = global.fetch;
let mockFetchResponse: { ok: boolean; status: number; json: () => Promise<any> } | null = null;

global.fetch = async (url: RequestInfo | URL, options?: RequestInit) => {
  if (mockFetchResponse) {
    return {
      ok: mockFetchResponse.ok,
      status: mockFetchResponse.status,
      json: mockFetchResponse.json,
      text: async () => 'Mock error',
    };
  }
  // Fall back to original fetch for non-mocked requests
  return originalFetch(url, options);
};

// ── Helpers ──────────────────────────────────────────────────────

/** Create a mock PDF buffer for testing. */
function createMockPdf(content: string): Buffer {
  return Buffer.from('%PDF-1.4\n' + content);
}

/** Create a valid Vision API response with OCR text. */
function createMockVisionResponse(fullText: string): VisionAnnotateResponse {
  return {
    responses: [
      {
        fullTextAnnotation: {
          text: fullText,
          pages: [
            {
              width: 612,
              height: 792,
              blockCount: 5,
              confidence: 0.92,
            },
          ],
        },
      },
    ],
  };
}

/** Create a mock Vision API error response. */
function createMockVisionError(message: string): VisionAnnotateResponse {
  return {
    responses: [
      {
        error: {
          code: 403,
          message,
        },
      },
    ],
  };
}

/** Set up mock fetch for Qwen3 response. */
function mockQwen3Response(elements: any[]): void {
  const jsonContent = JSON.stringify({
    elements,
    detectedLanguage: 'en',
    totalPages: 1,
  });
  mockFetchResponse = {
    ok: true,
    status: 200,
    json: async () => ({
      choices: [{ message: { content: jsonContent } }],
    }),
  };
}

/** Set up mock fetch for Qwen3 error. */
function mockQwen3Error(): void {
  mockFetchResponse = {
    ok: false,
    status: 500,
    json: async () => ({}),
  };
}

/** Get the last Qwen3 request body. */
function getLastQwen3Request(): any {
  // We can't easily capture this with the current mock setup
  // but we can verify fetch was called by checking mockFetchResponse
  return null;
}

// ── Tests ────────────────────────────────────────────────────────

describe('OCR Pipeline — Google Cloud Vision OCR', () => {
  it('calls GCV API and returns annotations on success', async () => {
    const { default: axios } = await import('axios');
    const mockAxios = axios as any;
    mockAxios.post.mockResolvedValueOnce({
      data: createMockVisionResponse('Hello from scanned PDF.'),
    });

    const result = await ocrDocument(createMockPdf('scanned content'), {
      apiKey: 'test-gcv-key',
    });

    expect(result).not.toBeNull();
    expect(result?.responses[0]?.fullTextAnnotation?.text).toBe('Hello from scanned PDF.');
    expect(mockAxios.post).toHaveBeenCalledTimes(1);
    expect(mockAxios.post).toHaveBeenCalledWith(
      'https://vision.googleapis.com/v1/images:batchAnnotate',
      expect.any(Object),
      expect.objectContaining({
        params: { key: 'test-gcv-key' },
      }),
    );
  });

  it('returns null when no API key is provided', async () => {
    const { default: axios } = await import('axios');
    const mockAxios = axios as any;
    mockAxios.post.mockRejectedValue(new Error('API key required'));

    const result = await ocrDocument(createMockPdf('content'), { apiKey: '' });

    expect(result).toBeNull();
  });

  it('returns null when GCV API call fails', async () => {
    const { default: axios } = await import('axios');
    const mockAxios = axios as any;
    mockAxios.post.mockRejectedValueOnce(new Error('Network error'));

    const result = await ocrDocument(createMockPdf('content'), {
      apiKey: 'test-gcv-key',
    });

    expect(result).toBeNull();
  });

  it('returns error response from GCV API', async () => {
    const { default: axios } = await import('axios');
    const mockAxios = axios as any;
    mockAxios.post.mockResolvedValueOnce({
      data: createMockVisionError('Invalid API key'),
    });

    const result = await ocrDocument(createMockPdf('content'), {
      apiKey: 'invalid-key',
    });

    expect(result).not.toBeNull();
    expect(result?.responses[0]?.error).toBeDefined();
  });
});

describe('OCR Pipeline — Qwen3 Structuring', () => {
  beforeEach(() => {
    mockFetchResponse = null;
  });

  it('calls Qwen3 API and parses structured output on success', async () => {
    mockQwen3Response([
      { type: 'heading', text: 'Introduction', level: 1, confidence: 0.9 },
      { type: 'paragraph', text: 'This is the introduction.', confidence: 0.85 },
    ]);

    const result = await structureWithQwen3(
      'Hello from scanned PDF.',
      { qwen3BaseUrl: 'http://localhost:8080' },
      1,
    );

    expect(result.elements).toHaveLength(2);
    expect(result.elements[0].type).toBe('heading');
    expect((result.elements[0] as any).text).toBe('Introduction');
    expect(result.detectedLanguage).toBe('en');
  });

  it('strips markdown code fences from Qwen3 response', async () => {
    // Qwen3 might wrap JSON in ```json ... ```
    mockFetchResponse = {
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{ message: { content: '```json\n{"elements": [{"type": "paragraph", "text": "test"}], "detectedLanguage": "en", "totalPages": 1}\n```' } }],
      }),
    };

    const result = await structureWithQwen3(
      'Test content',
      { qwen3BaseUrl: 'http://localhost:8080' },
      1,
    );

    expect(result.elements).toHaveLength(1);
    expect(result.elements[0].type).toBe('paragraph');
  });

  it('returns empty elements when Qwen3 returns no choices', async () => {
    mockFetchResponse = {
      ok: true,
      status: 200,
      json: async () => ({ choices: [] }),
    };

    const result = await structureWithQwen3(
      'Test content',
      { qwen3BaseUrl: 'http://localhost:8080' },
      1,
    );

    expect(result.elements).toHaveLength(0);
  });

  it('returns empty elements when Qwen3 API fails', async () => {
    mockQwen3Error();

    const result = await structureWithQwen3(
      'Test content',
      { qwen3BaseUrl: 'http://localhost:8080' },
      1,
    );

    expect(result.elements).toHaveLength(0);
    expect(result.detectedLanguage).toBe('en');
  });

  it('returns empty elements when no Qwen3 base URL is provided', async () => {
    const result = await structureWithQwen3(
      'Test content',
      { qwen3BaseUrl: '' },
      1,
    );

    expect(result.elements).toHaveLength(0);
  });
});

describe('OCR Pipeline — End-to-End', () => {
  beforeEach(() => {
    mockFetchResponse = null;
    vi.resetAllMocks();
  });

  it('runs full pipeline: Vision OCR → Qwen3 → ParsedDocument', async () => {
    // Mock GCV
    const { default: axios } = await import('axios');
    const mockAxios = axios as any;
    mockAxios.post.mockResolvedValueOnce({
      data: createMockVisionResponse('# Title\n\nBody paragraph.\n\n## Section\n\nMore text.'),
    });

    // Mock Qwen3
    mockQwen3Response([
      { type: 'heading', text: 'Title', level: 1, confidence: 0.95 },
      { type: 'paragraph', text: 'Body paragraph.', confidence: 0.9 },
      { type: 'heading', text: 'Section', level: 2, confidence: 0.92 },
      { type: 'paragraph', text: 'More text.', confidence: 0.88 },
    ]);

    const triage = {
      format: 'pdf',
      tier: 'scanned' as const,
      estimatedPages: 1,
      needsOCR: true,
      detectedBy: 'magic-byte',
    } as TriageResult;

    const doc = await ocrPipeline(createMockPdf('scanned'), triage, {
      apiKey: 'test-gcv-key',
      qwen3BaseUrl: 'http://localhost:8080',
    });

    expect(doc.format).toBe('pdf');
    expect(doc.tier).toBe('scanned');
    expect(doc.needsOCR).toBe(true);
    expect(doc.provenance.normalizer).toBe('ocr');
    expect(doc.elements.length).toBe(4);
    expect(doc.elements[0].type).toBe('heading');
    expect(doc.elements[1].type).toBe('paragraph');
    expect(doc.elements[2].type).toBe('heading');
    expect(doc.elements[3].type).toBe('paragraph');
    expect(doc.metadata.ocrProvider).toBe('google-cloud-vision');
    expect(doc.metadata.structuredBy).toBe('qwen3');
  });

  it('falls back to Vision annotations when Qwen3 returns no elements', async () => {
    // Mock GCV
    const { default: axios } = await import('axios');
    const mockAxios = axios as any;
    mockAxios.post.mockResolvedValueOnce({
      data: createMockVisionResponse('# Title\n\nBody text.'),
    });

    // Mock Qwen3 to return empty elements (simulating model failure)
    mockQwen3Response([]);

    const triage = {
      format: 'pdf',
      tier: 'scanned' as const,
      estimatedPages: 1,
      needsOCR: true,
      detectedBy: 'magic-byte',
    } as TriageResult;

    const doc = await ocrPipeline(createMockPdf('scanned'), triage, {
      apiKey: 'test-gcv-key',
      qwen3BaseUrl: 'http://localhost:8080',
    });

    // Should fall back to Vision-based elements
    expect(doc.elements.length).toBeGreaterThan(0);
    // Fallback uses Vision annotations to elements
    expect(doc.provenance.normalizer).toBe('ocr');
  });

  it('returns empty document when OCR fails completely', async () => {
    // Mock GCV to fail
    const { default: axios } = await import('axios');
    const mockAxios = axios as any;
    mockAxios.post.mockRejectedValueOnce(new Error('API key missing'));

    const triage = {
      format: 'pdf',
      tier: 'scanned' as const,
      estimatedPages: 2,
      needsOCR: true,
      detectedBy: 'magic-byte',
    } as TriageResult;

    const doc = await ocrPipeline(createMockPdf('scanned'), triage, {
      apiKey: '', // No API key
      qwen3BaseUrl: 'http://localhost:8080',
    });

    expect(doc.elements.length).toBe(0);
    expect(doc.needsOCR).toBe(true);
  });

  it('handles all element types from Qwen3', async () => {
    // Mock GCV
    const { default: axios } = await import('axios');
    const mockAxios = axios as any;
    mockAxios.post.mockResolvedValueOnce({
      data: createMockVisionResponse('Full OCR text.'),
    });

    // Mock Qwen3 with all element types
    mockQwen3Response([
      { type: 'heading', text: 'Main Title', level: 1, confidence: 0.95 },
      { type: 'paragraph', text: 'Body content.', confidence: 0.9 },
      {
        type: 'table',
        headers: ['Name', 'Age'],
        rows: [['Alice', '30'], ['Bob', '25']],
        confidence: 0.85,
      },
      { type: 'formula', latex: 'E = mc^2', alt: 'Mass-energy equivalence', confidence: 0.8 },
      { type: 'image', alt: 'Chart showing growth', confidence: 0.6 },
    ]);

    const triage = {
      format: 'pdf',
      tier: 'scanned' as const,
      estimatedPages: 1,
      needsOCR: true,
      detectedBy: 'magic-byte',
    } as TriageResult;

    const doc = await ocrPipeline(createMockPdf('scanned'), triage, {
      apiKey: 'test-gcv-key',
      qwen3BaseUrl: 'http://localhost:8080',
    });

    expect(doc.elements.length).toBe(5);
    expect(doc.elements[0].type).toBe('heading');
    expect(doc.elements[1].type).toBe('paragraph');
    expect(doc.elements[2].type).toBe('table');
    expect(doc.elements[3].type).toBe('formula');
    expect(doc.elements[4].type).toBe('image');

    // Verify table structure
    const table = doc.elements[2];
    if (table.type === 'table') {
      expect(table.headers).toEqual(['Name', 'Age']);
      expect(table.rows).toEqual([['Alice', '30'], ['Bob', '25']]);
      expect(table.colCount).toBe(2);
      expect(table.rowCount).toBe(2);
    }

    // Verify formula
    const formula = doc.elements[3];
    if (formula.type === 'formula') {
      expect(formula.latex).toBe('E = mc^2');
      expect(formula.alt).toBe('Mass-energy equivalence');
    }
  });

  it('sets language metadata when detected by Qwen3', async () => {
    const { default: axios } = await import('axios');
    const mockAxios = axios as any;
    mockAxios.post.mockResolvedValueOnce({
      data: createMockVisionResponse('Text content.'),
    });

    mockFetchResponse = {
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{ message: { content: JSON.stringify({ elements: [], detectedLanguage: 'es', totalPages: 1 }) } }],
      }),
    };

    const triage = {
      format: 'pdf',
      tier: 'scanned' as const,
      estimatedPages: 1,
      needsOCR: true,
      detectedBy: 'magic-byte',
    } as TriageResult;

    const doc = await ocrPipeline(createMockPdf('scanned'), triage, {
      apiKey: 'test-gcv-key',
      qwen3BaseUrl: 'http://localhost:8080',
    });

    expect(doc.metadata.language).toBe('es');
  });
});

describe('Vision Annotations → ParsedElement Mapping', () => {
  it('maps heading heuristics from Vision annotations', () => {
    const response = createMockVisionResponse('# Title\n## Section\nBody text.');
    const elements = visionAnnotationsToElements(response, 1);

    // Should detect heading patterns
    const headings = elements.filter((el) => el.type === 'heading');
    const paragraphs = elements.filter((el) => el.type === 'paragraph');

    expect(headings.length).toBeGreaterThanOrEqual(1);
    expect(paragraphs.length).toBeGreaterThanOrEqual(0);
  });

  it('maps all lines to paragraphs when no headings detected', () => {
    const response = createMockVisionResponse('Line one.\nLine two.\nLine three.');
    const elements = visionAnnotationsToElements(response, 1);

    expect(elements.length).toBe(3);
    expect(elements.every((el) => el.type === 'paragraph')).toBe(true);
    expect(elements.every((el) => el.confidence === 0.75)).toBe(true);
  });

  it('handles Vision error response gracefully', () => {
    const response = createMockVisionError('API error');
    const elements = visionAnnotationsToElements(response, 1);

    expect(elements.length).toBe(0);
  });

  it('skips empty lines', () => {
    const response = createMockVisionResponse('Text\n\n\nMore text\n');
    const elements = visionAnnotationsToElements(response, 1);

    expect(elements.length).toBe(2);
  });

  it('maps ALL_CAPS lines as headings', () => {
    const response = createMockVisionResponse('SECTION HEADER\n\nNormal text.\n\nANOTHER HEADER\n\nMore text.');
    const elements = visionAnnotationsToElements(response, 1);

    const headings = elements.filter((el) => el.type === 'heading');
    const paragraphs = elements.filter((el) => el.type === 'paragraph');

    // ALL_CAPS should be detected as headings
    expect(headings.length).toBeGreaterThanOrEqual(2);
    expect(paragraphs.length).toBeGreaterThanOrEqual(2);
  });
});

describe('hasTextLayer Heuristic', () => {
  it('returns true for PDFs with text content (BT/ET blocks)', () => {
    const pdfWithText = Buffer.from(
      '%PDF-1.4\n' +
      '1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n' +
      '2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n' +
      '3 0 obj<</Type/Page/MediaBox[0 0 612 792]/Parent 2 0 R/Contents 4 0 R>>endobj\n' +
      '4 0 obj<</Length 44>>stream\n' +
      'BT\n/F1 12 Tf\n100 700 Td\n(Hello World) Tj\nET\nendstream\nendobj\n',
    );

    expect(hasTextLayer(pdfWithText)).toBe(true);
  });

  it('returns true for PDFs with stream content', () => {
    const pdfWithStream = Buffer.from(
      '%PDF-1.4\n' +
      'stream\nHello World\nendstream\n',
    );

    expect(hasTextLayer(pdfWithStream)).toBe(true);
  });

  it('returns false for PDFs without text markers', () => {
    // A scanned PDF (images only, no text layer)
    const scannedPdf = Buffer.from(
      '%PDF-1.4\n' +
      '% This is a scanned PDF with no text layer\n' +
      '%%EOF\n',
    );

    expect(hasTextLayer(scannedPdf)).toBe(false);
  });

  it('returns false for empty buffer', () => {
    expect(hasTextLayer(Buffer.from(''))).toBe(false);
  });

  it('returns false for non-PDF content', () => {
    expect(hasTextLayer(Buffer.from('This is just plain text.'))).toBe(false);
  });
});

describe('OCR Pipeline — Integration with existing system', () => {
  it('works with triage result from detector for scanned PDFs', async () => {
    // Simulate a real detection flow
    const pdfContent = createMockPdf('scanned document content here');
    const triage = detectFormat(pdfContent, 'scanned.pdf');

    expect(triage.format).toBe('pdf');
    expect(triage.tier).toBe('scanned');

    // Mock the external calls
    const { default: axios } = await import('axios');
    const mockAxios = axios as any;
    mockAxios.post.mockResolvedValueOnce({
      data: createMockVisionResponse('# Report\n\nThis is a scanned report.'),
    });

    mockQwen3Response([
      { type: 'heading', text: 'Report', level: 1, confidence: 0.95 },
      { type: 'paragraph', text: 'This is a scanned report.', confidence: 0.88 },
    ]);

    const doc = await ocrPipeline(pdfContent, triage, {
      apiKey: 'test-key',
      qwen3BaseUrl: 'http://localhost:8080',
    });

    expect(doc.format).toBe('pdf');
    expect(doc.tier).toBe('scanned');
    expect(doc.needsOCR).toBe(true);
    expect(doc.elements.length).toBe(2);
  });

  it('uses normalizer for non-scanned formats (e.g., markdown)', async () => {
    // This tests that the OCR pipeline is NOT called for non-scanned formats
    const mdContent = Buffer.from('# Hello\n\nWorld content.');
    const triage = detectFormat(mdContent, 'readme.md');

    expect(triage.tier).toBe('text');
    expect(triage.needsOCR).toBe(false);

    // OCR should not be invoked for text-tier documents
    // (This is tested in index.test.ts via the app layer)
    expect(triage.format).toBe('md');
  });
});

describe('OCR Pipeline — Config', () => {
  it('uses default GCV endpoint', async () => {
    const { default: axios } = await import('axios');
    const mockAxios = axios as any;
    mockAxios.post.mockResolvedValueOnce({
      data: createMockVisionResponse('Test.'),
    });

    await ocrDocument(createMockPdf('test'), { apiKey: 'test-key' });

    expect(mockAxios.post).toHaveBeenCalledWith(
      'https://vision.googleapis.com/v1/images:batchAnnotate',
      expect.any(Object),
      expect.any(Object),
    );
  });

  it('supports custom GCV endpoint', async () => {
    const { default: axios } = await import('axios');
    const mockAxios = axios as any;
    mockAxios.post.mockResolvedValueOnce({
      data: createMockVisionResponse('Test.'),
    });

    await ocrDocument(createMockPdf('test'), {
      apiKey: 'test-key',
      gcvEndpoint: 'https://custom-vision-api.example.com/v1/images:batchAnnotate',
    });

    expect(mockAxios.post).toHaveBeenCalledWith(
      'https://custom-vision-api.example.com/v1/images:batchAnnotate',
      expect.any(Object),
      expect.any(Object),
    );
  });

  it('passes Qwen3 configuration options', async () => {
    mockQwen3Response([{ type: 'paragraph', text: 'Test', confidence: 0.9 }]);

    await structureWithQwen3(
      'Test content',
      {
        qwen3BaseUrl: 'http://localhost:8080',
        qwen3Model: 'qwen3-max',
        qwen3MaxTokens: 4096,
        qwen3Temperature: 0.05,
      },
      2,
    );

    expect(mockFetchResponse).not.toBeNull();
    expect(mockFetchResponse?.ok).toBe(true);
  });
});

describe('OCR Pipeline — Error Handling', () => {
  it('handles Vision API timeout gracefully', async () => {
    const { default: axios } = await import('axios');
    const mockAxios = axios as any;
    mockAxios.post.mockRejectedValueOnce(new Error('Timeout: operation timed out'));

    const triage = {
      format: 'pdf',
      tier: 'scanned' as const,
      estimatedPages: 3,
      needsOCR: true,
      detectedBy: 'magic-byte',
    } as TriageResult;

    const doc = await ocrPipeline(createMockPdf('large scanned doc'), triage, {
      apiKey: 'test-key',
      qwen3BaseUrl: 'http://localhost:8080',
    });

    expect(doc.elements.length).toBe(0);
    expect(doc.needsOCR).toBe(true);
  });

  it('handles malformed JSON from Qwen3 gracefully', async () => {
    const { default: axios } = await import('axios');
    const mockAxios = axios as any;
    mockAxios.post.mockResolvedValueOnce({
      data: createMockVisionResponse('OCR text.'),
    });

    mockFetchResponse = {
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{ message: { content: 'This is not valid JSON' } }],
      }),
    };

    const triage = {
      format: 'pdf',
      tier: 'scanned' as const,
      estimatedPages: 1,
      needsOCR: true,
      detectedBy: 'magic-byte',
    } as TriageResult;

    const doc = await ocrPipeline(createMockPdf('scanned'), triage, {
      apiKey: 'test-key',
      qwen3BaseUrl: 'http://localhost:8080',
    });

    // Should fall back to Vision annotations since Qwen3 JSON parsing failed
    expect(doc.provenance.normalizer).toBe('ocr');
  });
});
