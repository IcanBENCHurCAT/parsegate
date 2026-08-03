/**
 * Unified output schema for Parsegate.
 *
 * Every parser — regardless of input format — produces a ParsedDocument
 * with a common element model so downstream consumers (agents, APIs, UIs)
 * speak one language.
 */

// ─────────────────────────────────────────────────────────────────
// Element types
// ─────────────────────────────────────────────────────────────────

export type ElementType = 'heading' | 'paragraph' | 'table' | 'image' | 'formula';

/**
 * Base type shared by every element.
 * confidence:  1.0 for deterministic extraction,
 *              model-reported value for OCR / VLM extraction.
 */
export interface ElementBase {
  type: ElementType;
  /** Numeric confidence 0–1 of the element's extraction fidelity. */
  confidence: number;
  /** Arbitrary string tags the normalizer sets for provenance (format, detector, etc.) */
  tags?: string[];
}

/** Top-level text block with optional inline markdown. */
export interface ParagraphElement extends ElementBase {
  type: 'paragraph';
  /** Raw text content; may contain inline Markdown (bold, italic, links). */
  text: string;
}

/** ATX-style heading (e.g. `## Section`), with nesting level 1–6. */
export interface HeadingElement extends ElementBase {
  type: 'heading';
  /** Heading text without the `#` markers. */
  text: string;
  /** Nesting depth: 1 (H1) … 6 (H6). */
  level: number;
}

/**
 * Structured table (rows × cols).
 * NOT flattened text — consumers get a real grid.
 */
export interface TableElement extends ElementBase {
  type: 'table';
  /** Column headers (empty array when the table has no header row). */
  headers: string[];
  /** Each row is an array of cell strings, length === headers.length. */
  rows: string[][];
  /** Approximate number of columns inferred from the first row. */
  colCount: number;
  /** Total row count (excluding header). */
  rowCount: number;
}

/** Embedded image (photo, diagram, scanned graphic). */
export interface ImageElement extends ElementBase {
  type: 'image';
  /** MIME type of the image (png, jpeg, svg, …). */
  mimeType?: string;
  /** Base64 or URL; omitted when only metadata is extracted. */
  data?: string;
  /** Alt-text or brief description. */
  alt?: string;
  /** Width / height in CSS pixels when available. */
  width?: number;
  height?: number;
}

/** Display / inline mathematical formula. */
export interface FormulaElement extends ElementBase {
  type: 'formula';
  /** LaTeX source string (e.g. `\frac{-b \pm \sqrt{\Delta}}{2a}`). */
  latex: string;
  /** Plain-text fallback for environments without LaTeX rendering. */
  alt?: string;
}

export type ParsedElement =
  | ParagraphElement
  | HeadingElement
  | TableElement
  | ImageElement
  | FormulaElement;

// ─────────────────────────────────────────────────────────────────
// Location tracking
// ─────────────────────────────────────────────────────────────────

/**
 * Which page or slide an element lives on.
 * 1-indexed; undefined when the format has no paging concept.
 */
export interface LocationInfo {
  page?: number;
  /** Spreadsheet sheet / tab name. */
  sheet?: string;
  /** Presentation slide number (1-indexed). */
  slide?: number;
  /** Book / chapter identifier. */
  chapter?: string;
}

// ─────────────────────────────────────────────────────────────────
// Unified document
// ─────────────────────────────────────────────────────────────────

/**
 * The single, format-agnostic document model that all normalizers
 * produce.
 */
export interface ParsedDocument {
  /** Format the file was identified as ('pdf', 'csv', 'docx', …). */
  format: string;
  /** Tier used for extraction ('text' | 'structured' | 'scanned' | 'unknown'). */
  tier: 'text' | 'structured' | 'scanned' | 'unknown';
  /** Total estimated page count. */
  estimatedPages: number;
  /** Whether the document required OCR / VLM. */
  needsOCR: boolean;
  /** List of extracted elements, in document order. */
  elements: ParsedElement[];
  /** Document-level metadata (author, title, language, etc.). */
  metadata: Record<string, string | number | boolean | string[]>;
  /** Per-element provenance / detection source. */
  provenance: {
    detectedBy: 'magic-byte' | 'extension' | 'content-analysis';
    normalizer: string;
  };
}

// ─────────────────────────────────────────────────────────────────
// Helpers / builders
// ─────────────────────────────────────────────────────────────────

/** Convenience factory for a blank ParsedDocument. */
export function createEmptyDocument(
  format: string,
  tier: 'text' | 'structured' | 'scanned' | 'unknown',
  estimatedPages: number,
  needsOCR: boolean,
  detectedBy: 'magic-byte' | 'extension' | 'content-analysis',
): ParsedDocument {
  return {
    format,
    tier,
    estimatedPages,
    needsOCR,
    elements: [],
    metadata: {},
    provenance: { detectedBy, normalizer: 'unified' },
  };
}

/** Set a default confidence (1.0 = fully deterministic). */
export function withConfidence(element: ParsedElement, confidence: number): ParsedElement {
  return { ...element, confidence };
}

/**
 * Infer a confidence score from tier:
 *   text    → 1.0  (plain text is always deterministic)
 *   structured → 1.0  (ZIP-based parsers are deterministic)
 *   scanned → <1.0  (OCR / VLM — caller fills in the actual value)
 *   unknown → 0.0
 */
export function defaultConfidenceForTier(tier: string): number {
  if (tier === 'text' || tier === 'structured') return 1.0;
  if (tier === 'scanned') return 0.5; // placeholder — OCR confidence
  return 0.0;
}
