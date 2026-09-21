/**
 * Tests for the unified ParsedDocument schema and normalizer.
 *
 * Covers:
 *  - Unified schema contract (all element types, location tracking)
 *  - Confidence scoring (1.0 for deterministic, lower for OCR)
 *  - Format-specific normalizers: plain text, markdown, PDF, CSV
 *  - Table structure (not flattened)
 *  - Edge cases and fallback behavior
 */

import { describe, it, expect } from 'vitest';
import { detectFormat } from '../src/detector.js';
import { normalize } from '../src/normalizer.js';
import {
  createEmptyDocument,
  defaultConfidenceForTier,
  withConfidence,
} from '../src/schema.js';
import type {
  ParsedElement,
  HeadingElement,
  ParagraphElement,
  TableElement,
} from '../src/schema.js';
import type { TriageResult } from '../src/detector.js';

// ─────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────

/** Create a minimal ZIP-like buffer for format detection. */

/** Assert that an element is a heading with the expected text and level. */
function expectHeading(
  el: ParsedElement,
  expectedText: string,
  expectedLevel: number,
  expectedConfidence: number,
): void {
  expect(el.type).toBe('heading');
  const h = el as HeadingElement;
  expect(h.text).toBe(expectedText);
  expect(h.level).toBe(expectedLevel);
  expect(h.confidence).toBe(expectedConfidence);
}

/** Assert that an element is a paragraph with expected text. */
function expectParagraph(
  el: ParsedElement,
  expectedText: string,
  expectedConfidence: number,
): void {
  expect(el.type).toBe('paragraph');
  const p = el as ParagraphElement;
  expect(p.text).toBe(expectedText);
  expect(p.confidence).toBe(expectedConfidence);
}

/** Assert that an element is a table with expected structure. */
function expectTable(
  el: ParsedElement,
  expectedHeaders: string[],
  expectedRows: string[][],
  expectedConfidence: number,
): void {
  expect(el.type).toBe('table');
  const t = el as TableElement;
  expect(t.headers).toEqual(expectedHeaders);
  expect(t.rows).toEqual(expectedRows);
  expect(t.colCount).toBe(expectedHeaders.length);
  expect(t.rowCount).toBe(expectedRows.length);
  expect(t.confidence).toBe(expectedConfidence);
  // Verify tables are NOT flattened: must have headers + rows arrays
  expect(t.headers).toBeDefined();
  expect(t.rows).toBeDefined();
  expect(Array.isArray(t.rows)).toBe(true);
  for (const row of t.rows) {
    expect(Array.isArray(row)).toBe(true);
    expect(row.length).toBe(expectedHeaders.length);
  }
}

// ─────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────

describe('Unified ParsedDocument schema', () => {
  it('creates an empty document with correct fields', () => {
    const doc = createEmptyDocument(
      'pdf',
      'scanned',
      3,
      false,
      'magic-byte',
    );

    expect(doc.format).toBe('pdf');
    expect(doc.tier).toBe('scanned');
    expect(doc.estimatedPages).toBe(3);
    expect(doc.needsOCR).toBe(false);
    expect(doc.elements).toEqual([]);
    expect(doc.metadata).toEqual({});
    expect(doc.provenance.detectedBy).toBe('magic-byte');
    expect(doc.provenance.normalizer).toBe('unified');
  });

  it('assigns confidence 1.0 for text and structured tiers', () => {
    expect(defaultConfidenceForTier('text')).toBe(1.0);
    expect(defaultConfidenceForTier('structured')).toBe(1.0);
  });

  it('assigns reduced confidence for scanned tier', () => {
    expect(defaultConfidenceForTier('scanned')).toBe(0.5);
  });

  it('assigns zero confidence for unknown tier', () => {
    expect(defaultConfidenceForTier('unknown')).toBe(0.0);
  });

  it('wraps an element with confidence via withConfidence', () => {
    const el: ParagraphElement = {
      type: 'paragraph',
      text: 'Hello',
      confidence: 0.0,
    };
    const wrapped = withConfidence(el, 0.95) as ParagraphElement;
    expect(wrapped.confidence).toBe(0.95);
    // Original is unchanged (immutable)
    expect(el.confidence).toBe(0.0);
  });
});

// ─────────────────────────────────────────────────────────────────
// Plain-text normalizer
// ─────────────────────────────────────────────────────────────────

describe('normalize — plain text', () => {
  it('splits text into paragraph elements by blank lines', () => {
    const triage = detectFormat(
      Buffer.from('First paragraph.\n\nSecond paragraph.\n\nThird paragraph.'),
      'notes.txt',
    );

    const doc = normalize(Buffer.from('First paragraph.\n\nSecond paragraph.\n\nThird paragraph.'), triage);

    expect(doc.format).toBe('txt');
    expect(doc.elements.length).toBe(3);
    expectParagraph(doc.elements[0], 'First paragraph.', 1.0);
    expectParagraph(doc.elements[1], 'Second paragraph.', 1.0);
    expectParagraph(doc.elements[2], 'Third paragraph.', 1.0);
  });

  it('groups consecutive non-empty lines into one paragraph', () => {
    const triage = detectFormat(
      Buffer.from('Line 1\nLine 2\nLine 3'),
      'notes.txt',
    );

    const doc = normalize(Buffer.from('Line 1\nLine 2\nLine 3'), triage);

    expect(doc.elements.length).toBe(1);
    expectParagraph(doc.elements[0], 'Line 1\nLine 2\nLine 3', 1.0);
  });

  it('ignores leading/trailing blank lines', () => {
    const triage = detectFormat(Buffer.from('\n\nHello\n\n'), 'notes.txt');
    const doc = normalize(Buffer.from('\n\nHello\n\n'), triage);

    expect(doc.elements.length).toBe(1);
    expectParagraph(doc.elements[0], 'Hello', 1.0);
  });

  it('returns empty document for empty buffer', () => {
    const triage = detectFormat(Buffer.from(''), 'empty.txt');
    const doc = normalize(Buffer.from(''), triage);

    expect(doc.elements.length).toBe(0);
  });

  it('handles CRLF line endings', () => {
    const triage = detectFormat(Buffer.from('Hello\r\nWorld\r\n\r\nSecond'), 'notes.txt');
    const doc = normalize(Buffer.from('Hello\r\nWorld\r\n\r\nSecond'), triage);

    expect(doc.elements.length).toBe(2);
    expectParagraph(doc.elements[0], 'Hello\nWorld', 1.0);
    expectParagraph(doc.elements[1], 'Second', 1.0);
  });
});

// ─────────────────────────────────────────────────────────────────
// Markdown normalizer
// ─────────────────────────────────────────────────────────────────

describe('normalize — markdown', () => {
  it('detects ATX headings and creates HeadingElements', () => {
    const triage = detectFormat(
      Buffer.from('# Title\n## Section\n### Subsection'),
      'readme.md',
    );

    const doc = normalize(Buffer.from('# Title\n## Section\n### Subsection'), triage);

    expect(doc.format).toBe('md');
    expect(doc.elements.length).toBe(3);
    expectHeading(doc.elements[0], 'Title', 1, 1.0);
    expectHeading(doc.elements[1], 'Section', 2, 1.0);
    expectHeading(doc.elements[2], 'Subsection', 3, 1.0);
  });

  it('combines headings and paragraphs in document order', () => {
    const content = '# Main Title\n\nBody paragraph one.\n\n## Section Two\n\nBody paragraph two.';
    const triage = detectFormat(Buffer.from(content), 'readme.md');
    const doc = normalize(Buffer.from(content), triage);

    expect(doc.elements.length).toBe(4);
    expectHeading(doc.elements[0], 'Main Title', 1, 1.0);
    expectParagraph(doc.elements[1], 'Body paragraph one.', 1.0);
    expectHeading(doc.elements[2], 'Section Two', 2, 1.0);
    expectParagraph(doc.elements[3], 'Body paragraph two.', 1.0);
  });

  it('ignores horizontal rules and blank lines', () => {
    const content = '# Title\n\n---\n\nSome content.\n\n***\n\nMore content.';
    const triage = detectFormat(Buffer.from(content), 'readme.md');
    const doc = normalize(Buffer.from(content), triage);

    // Should have: heading + 2 paragraphs (horizontal rules create breaks)
    expect(doc.elements.length).toBe(3);
    expectHeading(doc.elements[0], 'Title', 1, 1.0);
    expectParagraph(doc.elements[1], 'Some content.', 1.0);
    expectParagraph(doc.elements[2], 'More content.', 1.0);
  });

  it('detects markdown via content analysis when no extension', () => {
    const content = '# Hey\n\nWhat\'s up?';
    const triage = detectFormat(Buffer.from(content)); // no filename

    expect(triage.format).toBe('md');

    const doc = normalize(Buffer.from(content), triage);
    expect(doc.format).toBe('md');
    expect(doc.elements[0].type).toBe('heading');
  });
});

// ─────────────────────────────────────────────────────────────────
// CSV normalizer
// ─────────────────────────────────────────────────────────────────

describe('normalize — CSV', () => {
  it('parses CSV into a structured table with headers and rows', () => {
    const csv = 'name,age,city\nJohn,30,NYC\nJane,25,LA\nBob,35,CHI';
    const triage = detectFormat(Buffer.from(csv), 'data.csv');

    const doc = normalize(Buffer.from(csv), triage);

    expect(doc.format).toBe('csv');
    expect(doc.elements.length).toBe(1);
    expectTable(doc.elements[0], ['name', 'age', 'city'], [
      ['John', '30', 'NYC'],
      ['Jane', '25', 'LA'],
      ['Bob', '35', 'CHI'],
    ], 1.0);
  });

  it('handles CSV with no data rows (header only)', () => {
    const csv = 'col_a,col_b\n';
    const triage = detectFormat(Buffer.from(csv), 'empty.csv');
    const doc = normalize(Buffer.from(csv), triage);

    expect(doc.elements.length).toBe(1);
    expectTable(doc.elements[0], ['col_a', 'col_b'], [], 1.0);
  });

  it('detects tab delimiter in TSV files', () => {
    const tsv = 'name\tage\tcity\nJohn\t30\tNYC\nJane\t25\tLA';
    const triage = detectFormat(Buffer.from(tsv), 'data.tsv');

    const doc = normalize(Buffer.from(tsv), triage);

    expectTable(doc.elements[0], ['name', 'age', 'city'], [
      ['John', '30', 'NYC'],
      ['Jane', '25', 'LA'],
    ], 1.0);
  });

  it('trims whitespace from cells', () => {
    const csv = ' name , age , city \n John , 30 , NYC \n';
    const triage = detectFormat(Buffer.from(csv), 'data.csv');
    const doc = normalize(Buffer.from(csv), triage);

    const table = doc.elements[0] as TableElement;
    expect(table.headers).toEqual(['name', 'age', 'city']);
    expect(table.rows[0]).toEqual(['John', '30', 'NYC']);
  });

  it('verifies tables are NOT flattened — has headers and rows arrays', () => {
    const csv = 'a,b\n1,2\n3,4';
    const triage = detectFormat(Buffer.from(csv), 'data.csv');
    const doc = normalize(Buffer.from(csv), triage);

    const table = doc.elements[0] as TableElement;
    expect(table.headers).toBeDefined();
    expect(table.rows).toBeDefined();
    expect(table.colCount).toBe(2);
    expect(table.rowCount).toBe(2);
    // Each row must have the same length as headers (structural integrity)
    for (const row of table.rows) {
      expect(row.length).toBe(2);
    }
  });

  it('sets metadata for CSV documents', () => {
    const csv = 'x,y,z\n1,2,3\n4,5,6\n7,8,9';
    const triage = detectFormat(Buffer.from(csv), 'data.csv');
    const doc = normalize(Buffer.from(csv), triage);

    expect(doc.metadata.rowCount).toBe(3);
    expect(doc.metadata.columnCount).toBe(3);
    expect(doc.metadata.delimiter).toBe(',');
  });
});

// ─────────────────────────────────────────────────────────────────
// PDF normalizer
// ─────────────────────────────────────────────────────────────────

describe('normalize — PDF', () => {
  it('splits PDF text into page-based paragraph elements', () => {
    const pdfContent = '%PDF-1.4\n' + 'x'.repeat(1200); // ~1200 bytes → ~2 pages at 1000/page
    const triage = detectFormat(Buffer.from(pdfContent), 'report.pdf');

    const doc = normalize(Buffer.from(pdfContent), triage);

    expect(doc.format).toBe('pdf');
    expect(doc.tier).toBe('scanned');
    // Should produce at least one paragraph
    expect(doc.elements.length).toBeGreaterThanOrEqual(1);
    expect(doc.elements[0].type).toBe('paragraph');
  });

  it('uses lower confidence for OCR-needed PDFs', () => {
    // Large PDF that needs OCR: need buffer > pages * 100KB
    // This is hard to construct in tests, so we test the normalizer
    // directly by modifying the triage result.
    const triage = {
      format: 'pdf',
      tier: 'scanned' as const,
      estimatedPages: 1,
      needsOCR: true,
      detectedBy: 'magic-byte',
    } as TriageResult;

    const doc = normalize(Buffer.from('%PDF-1.4\nHello from scanned PDF.'), triage);

    const el = doc.elements[0];
    expect(el.type).toBe('paragraph');
    // needsOCR → confidence should be 0.4
    expect(el.confidence).toBe(0.4);
  });

  it('uses higher confidence for text-layer PDFs (no OCR)', () => {
    const triage = {
      format: 'pdf',
      tier: 'scanned' as const,
      estimatedPages: 1,
      needsOCR: false,
      detectedBy: 'magic-byte',
    } as TriageResult;

    const doc = normalize(Buffer.from('%PDF-1.4\nHello from text PDF.'), triage);

    expect(doc.elements[0].confidence).toBe(0.85);
  });

  it('returns empty document for empty PDF buffer', () => {
    const triage = detectFormat(Buffer.from(''), 'empty.pdf');
    const doc = normalize(Buffer.from(''), triage);

    expect(doc.elements.length).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────
// Fallback and edge cases
// ─────────────────────────────────────────────────────────────────

describe('Normalizer fallbacks', () => {
  it('falls back to plain-text normalizer for unregistered formats', () => {
    const triage = {
      format: 'rtf',
      tier: 'structured' as const,
      estimatedPages: 1,
      needsOCR: false,
      detectedBy: 'extension',
    } as TriageResult;

    const doc = normalize(Buffer.from('Hello RTF content'), triage);

    // Should fall back to text normalizer
    expect(doc.elements.length).toBe(1);
    expect(doc.elements[0].type).toBe('paragraph');
    expect(doc.provenance.normalizer).toBe('text');
  });

  it('preserves provenance information in the document', () => {
    const triage = detectFormat(Buffer.from('# Hello'), 'readme.md');
    const doc = normalize(Buffer.from('# Hello'), triage);

    expect(doc.provenance.detectedBy).toBe('extension');
    expect(doc.provenance.normalizer).toBe('markdown');
  });

  it('preserves triage metadata in the document', () => {
    const csv = 'a,b\n1,2';
    const triage = detectFormat(Buffer.from(csv), 'data.csv');
    const doc = normalize(Buffer.from(csv), triage);

    expect(doc.format).toBe('csv');
    expect(doc.tier).toBe('structured');
    expect(doc.estimatedPages).toBeGreaterThanOrEqual(1);
    expect(doc.needsOCR).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────
// Schema type integrity
// ─────────────────────────────────────────────────────────────────

describe('Schema type contract', () => {
  it('all element types exist as discriminable types', () => {
    // Verify the type system distinguishes element types via the `type` discriminator.
    // We test at runtime by creating elements and checking the discriminant.
    const heading: HeadingElement = {
      type: 'heading',
      text: 'H1',
      level: 1,
      confidence: 1.0,
    };
    const paragraph: ParagraphElement = {
      type: 'paragraph',
      text: 'body',
      confidence: 1.0,
    };
    const table: TableElement = {
      type: 'table',
      headers: ['a'],
      rows: [['b']],
      colCount: 1,
      rowCount: 1,
      confidence: 1.0,
    };

    expect(heading.type).toBe('heading');
    expect(paragraph.type).toBe('paragraph');
    expect(table.type).toBe('table');

    // All elements must have confidence
    expect(heading.confidence).toBe(1.0);
    expect(paragraph.confidence).toBe(1.0);
    expect(table.confidence).toBe(1.0);
  });

  it('every ParsedDocument element has a confidence between 0 and 1', () => {
    const csv = 'x,y\n1,2\n3,4';
    const triage = detectFormat(Buffer.from(csv), 'data.csv');
    const doc = normalize(Buffer.from(csv), triage);

    for (const el of doc.elements) {
      expect(el.confidence).toBeGreaterThanOrEqual(0);
      expect(el.confidence).toBeLessThanOrEqual(1);
    }
  });
});

// ─────────────────────────────────────────────────────────────────
// Cross-format comparison
// ─────────────────────────────────────────────────────────────────

describe('Format comparison — all elements have confidence', () => {
  it('text format: all elements have confidence 1.0', () => {
    const triage = detectFormat(Buffer.from('Hello\n\nWorld'), 't.txt');
    const doc = normalize(Buffer.from('Hello\n\nWorld'), triage);
    for (const el of doc.elements) {
      expect(el.confidence).toBe(1.0);
    }
  });

  it('markdown format: all elements have confidence 1.0', () => {
    const triage = detectFormat(Buffer.from('# Hi\n\nContent'), 'm.md');
    const doc = normalize(Buffer.from('# Hi\n\nContent'), triage);
    for (const el of doc.elements) {
      expect(el.confidence).toBe(1.0);
    }
  });

  it('csv format: all elements have confidence 1.0', () => {
    const triage = detectFormat(Buffer.from('a\n1\n2'), 'c.csv');
    const doc = normalize(Buffer.from('a\n1\n2'), triage);
    for (const el of doc.elements) {
      expect(el.confidence).toBe(1.0);
    }
  });
});
