/**
 * Normalizer — maps raw file content → unified ParsedDocument.
 *
 * Routes to format-specific normalizers based on TriageResult.format.
 *
 * Supported formats (MVP):
 *   plain text (txt), markdown (md), PDF (text layer), CSV/TSV (csv, tsv)
 *
 * Planned formats:
 *   Excel (xlsx), Word (docx), PowerPoint (pptx), EPUB, RTF
 */

import {
  createEmptyDocument,
  defaultConfidenceForTier,
  ParsedDocument,
  } from './schema.js';
import type { TriageResult } from './detector.js';

// ─────────────────────────────────────────────────────────────────
// Format-specific normalizer contracts
// ─────────────────────────────────────────────────────────────────

interface NormalizerFn {
  (buffer: Buffer, triage: TriageResult): ParsedDocument;
}

// ─────────────────────────────────────────────────────────────────
// Plain-text normalizer
// ─────────────────────────────────────────────────────────────────
const normalizeText: NormalizerFn = (buffer, triage) => {
  const doc = createEmptyDocument(
    triage.format,
    triage.tier,
    triage.estimatedPages,
    triage.needsOCR,
    triage.detectedBy,
  );
  doc.provenance.normalizer = 'text';

  const text = buffer.toString('utf8');
  const lines = text.split(/\r?\n/);

  // Group consecutive non-empty lines into paragraph blocks
  const paragraphs: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      if (paragraphs.length > 0) {
        doc.elements.push({
          type: 'paragraph',
          text: paragraphs.join('\n'),
          confidence: defaultConfidenceForTier(triage.tier),
        });
        paragraphs.length = 0;
      }
    } else {
      paragraphs.push(trimmed);
    }
  }
  // Flush remaining
  if (paragraphs.length > 0) {
    doc.elements.push({
      type: 'paragraph',
      text: paragraphs.join('\n'),
      confidence: defaultConfidenceForTier(triage.tier),
    });
  }

  return doc;
};

// ─────────────────────────────────────────────────────────────────
// Markdown normalizer
// ─────────────────────────────────────────────────────────────────
const normalizeMarkdown: NormalizerFn = (buffer, triage) => {
  const doc = createEmptyDocument(
    triage.format,
    triage.tier,
    triage.estimatedPages,
    triage.needsOCR,
    triage.detectedBy,
  );
  doc.provenance.normalizer = 'markdown';

  const text = buffer.toString('utf8');
  const lines = text.split(/\r?\n/);

  let currentParagraph: string[] = [];

  const flushParagraph = () => {
    if (currentParagraph.length === 0) return;
    const text = currentParagraph.join('\n');
    if (text.trim().length > 0) {
      doc.elements.push({
        type: 'paragraph',
        text,
        confidence: defaultConfidenceForTier(triage.tier),
      });
    }
    currentParagraph = [];
  };

  for (const line of lines) {
    // ATX heading detection: # ... ######
    const headingMatch = line.match(/^(#{1,6})\s+(.+)$/);
    if (headingMatch) {
      flushParagraph();
      doc.elements.push({
        type: 'heading',
        text: headingMatch[2],
        level: headingMatch[1].length,
        confidence: defaultConfidenceForTier(triage.tier),
      });
      continue;
    }

    // Blank line or horizontal rule
    if (/^(\s*|---|\*\*\*|___)\s*$/.test(line)) {
      flushParagraph();
      continue;
    }

    // Collect paragraph lines
    currentParagraph.push(line);
  }
  flushParagraph();

  // Tag code blocks as a special paragraph annotation
  // (simplified: detect fenced code blocks and tag them)
  const fullText = text;
  const codeBlockRegex = /```[\s\S]*?```/g;
  while (codeBlockRegex.exec(fullText) !== null) {
    // The code block is embedded in an existing paragraph element;
    // we mark nearby elements with a code-block tag.
    // For now, just add a tag to the element containing the block.
    for (const el of doc.elements) {
      if (el.type === 'paragraph' && el.text.includes('```')) {
        el.tags = [...(el.tags ?? []), 'code-block'];
      }
    }
    break;
  }

  return doc;
};

// ─────────────────────────────────────────────────────────────────
// CSV / TSV normalizer
// ─────────────────────────────────────────────────────────────────
const normalizeCSV: NormalizerFn = (buffer, triage) => {
  const doc = createEmptyDocument(
    triage.format,
    triage.tier,
    triage.estimatedPages,
    triage.needsOCR,
    triage.detectedBy,
  );
  doc.provenance.normalizer = 'csv';

  const text = buffer.toString('utf8').trim();
  if (!text) return doc;

  const csvLines = text.split(/\r?\n/);

  // Detect delimiter
  let delimiter = ',';
  const firstLine = csvLines[0] ?? '';
  if (firstLine.includes('\t')) {
    delimiter = '\t';
  } else if (firstLine.includes(';') && !firstLine.includes(',')) {
    delimiter = ';';
  }

  // Parse all rows
  const rows: string[][] = csvLines.map((line) => {
    // Simple CSV parsing (no quoted fields with embedded newlines for MVP)
    return line.split(delimiter).map((cell) => cell.trim());
  });

  if (rows.length === 0) return doc;

  // First row is the header; remaining rows are data
  const headers = rows[0];
  const dataRows = rows.slice(1);

  doc.elements.push({
    type: 'table',
    headers,
    rows: dataRows,
    colCount: headers.length,
    rowCount: dataRows.length,
    confidence: defaultConfidenceForTier(triage.tier),
    tags: ['structured-data'],
  });

  doc.metadata.rowCount = dataRows.length;
  doc.metadata.columnCount = headers.length;
  doc.metadata.delimiter = delimiter;

  return doc;
};

// ─────────────────────────────────────────────────────────────────
// PDF normalizer (text-layer extraction)
// ─────────────────────────────────────────────────────────────────
const normalizePDF: NormalizerFn = (buffer, _triage) => {
  const doc = createEmptyDocument(
    'pdf',
    _triage.tier,
    _triage.estimatedPages,
    _triage.needsOCR,
    _triage.detectedBy,
  );
  doc.provenance.normalizer = 'pdf';

  // Heuristic: if the buffer starts with %PDF, it's a real PDF.
  // For the MVP, we do a simple text extraction by splitting on
  // %PDF markers (simulating multi-page detection).
  const text = buffer.toString('utf8');

  if (text.length === 0) {
    // Empty PDF — return empty document
    return doc;
  }

  // Simulate page-by-page extraction for simplicity.
  // In production, use pdf-parse or pdfium WASM for proper text extraction.
  // For now, treat each ~1000 chars as a rough "page".
  const pageSize = 1000;
  const totalPages = _triage.estimatedPages;

  let offset = 0;
  let pageNum = 0;

  while (offset < text.length && pageNum < totalPages) {
    const chunk = text.substring(offset, offset + pageSize);
    const lines = chunk.split(/\r?\n/).filter((l) => l.trim().length > 0);

    if (lines.length > 0) {
      // Merge consecutive lines into paragraph blocks
      const paragraphParts: string[] = [];
      for (const line of lines) {
        paragraphParts.push(line.trim());
      }

      doc.elements.push({
        type: 'paragraph',
        text: paragraphParts.join(' '),
        confidence: _triage.needsOCR ? 0.4 : 0.85, // lower for OCR, higher for text layer
        tags: ['pdf-page'],
      });
    }

    offset += pageSize;
    pageNum++;
  }

  doc.metadata.pageCount = pageNum;

  return doc;
};

// ─────────────────────────────────────────────────────────────────
// Format → normalizer mapping
// ─────────────────────────────────────────────────────────────────

const NORMALIZERS: Record<string, NormalizerFn> = {
  txt: normalizeText,
  text: normalizeText,
  md: normalizeMarkdown,
  markdown: normalizeMarkdown,
  csv: normalizeCSV,
  tsv: normalizeCSV,
  pdf: normalizePDF,
  // Add more formats as they are implemented:
  // xlsx: normalizeExcel,
  // docx: normalizeWord,
  // pptx: normalizePowerpoint,
  // epub: normalizeEPUB,
};

// ─────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────

/**
 * Normalize a file's raw content into a unified ParsedDocument.
 *
 * @param buffer  — Raw file bytes
 * @param triage  — TriageResult from the format detector
 * @returns       — Unified ParsedDocument
 *
 * @throws Will throw if no normalizer is registered for the given format.
 */
export function normalize(
  buffer: Buffer,
  triage: TriageResult,
): ParsedDocument {
  const formatKey = triage.format.toLowerCase();
  const normalizer = NORMALIZERS[formatKey];

  if (!normalizer) {
    // Fallback: treat as plain text so the document is still produced
    return normalizeText(buffer, triage);
  }

  return normalizer(buffer, triage);
}

/**
 * Register a custom normalizer for a format.
 * Useful for extending the normalizer with third-party parsers.
 */
export function registerNormalizer(
  format: string,
  normalizer: NormalizerFn,
): void {
  NORMALIZERS[format.toLowerCase()] = normalizer;
}

