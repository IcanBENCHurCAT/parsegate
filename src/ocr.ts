/**
 * OCR Pipeline — Scanned PDF Processing (P007).
 *
 * End-to-end pipeline for scanned documents:
 *   1. Google Cloud Vision OCR (DOCUMENT_TEXT_DETECTION) → raw text + layout
 *   2. Qwen3 local model → structured ParsedDocument matching the unified schema
 *
 * This module is Workers-compatible (no native deps, no fs/proc/child_process).
 * Uses the fetch API for HTTP requests (available in Node 18+ and Workers).
 *
 * Cost model: ~$0.0025-0.003/page (Cloud Vision $0.0015 + Qwen3 ~$0.001)
 */

import axios from 'axios';
import {
  type ParsedDocument,
  type ParsedElement,
  HeadingElement,
  ParagraphElement,
  TableElement,
  ImageElement,
  FormulaElement,
  createEmptyDocument,
  defaultConfidenceForTier,
} from './schema.js';
import type { TriageResult } from './detector.js';

// ─────────────────────────────────────────────────────────────────
// Types — Google Cloud Vision API response
// ─────────────────────────────────────────────────────────────────

/** Vertex (point) in the annotation coordinate space. */
export interface VisionVertex {
  x: number;
  y: number;
}

/** Bounding polygon defining a region of interest. */
export interface VisionBoundingPoly {
  vertices: VisionVertex[];
}

/** A word recognized by Vision OCR. */
export interface VisionWord {
  boundingBox: VisionBoundingPoly;
  property?: {
    detectedLanguages?: Array<{
      languageCode: string;
      confidence?: number;
    }>;
  };
  text: string;
  confidence?: number;
}

/** A block of text (paragraph-level). */
export interface VisionBlock {
  boundingBox: VisionBoundingPoly;
  blockType?: number; // 1 = Text, 2 = Heading
  words?: VisionWord[];
  confidence?: number;
}

/** A page-level annotation from Vision. */
export interface VisionPage {
  width: number;
  height: number;
  blockCount?: number;
  blocks?: VisionBlock[];
  fullTextAnnotation?: {
    pages?: Array<{
      width: number;
      height: number;
      blockCount?: number;
      confidence?: number;
      detectedLanguages?: Array<{
        languageCode: string;
        confidence?: number;
      }>;
    }>;
    text: string;
  };
}

/** A symbol (character-level). */
export interface VisionSymbol {
  boundingBox: VisionBoundingPoly;
  text: string;
  confidence?: number;
}

/** The full batchAnnotate response. */
export interface VisionAnnotateResponse {
  responses: Array<{
    error?: {
      code: number;
      message: string;
    };
    fullTextAnnotation?: {
      text: string;
      pages?: VisionPage[];
    };
    textAnnotations?: Array<{
      description: string;
      boundingBox: VisionBoundingPoly;
      confidence?: number;
    }>;
  }>;
}

// ─────────────────────────────────────────────────────────────────
// Types — Qwen3 / LLM response
// ─────────────────────────────────────────────────────────────────

export interface Qwen3Element {
  type: 'heading' | 'paragraph' | 'table' | 'image' | 'formula';
  text?: string;
  content?: string;
  level?: number;
  headers?: string[];
  rows?: string[][];
  latex?: string;
  alt?: string;
  confidence?: number;
  page?: number;
}
interface Qwen3ChoiceMessage {
  content: string;
}

interface Qwen3Choice {
  message?: Qwen3ChoiceMessage;
}

interface Qwen3Error {
  message: string;
}

export interface Qwen3Response {
  choices?: Qwen3Choice[];
  error?: Qwen3Error;
}

// ─────────────────────────────────────────────────────────────────
// Configuration
// ─────────────────────────────────────────────────────────────────

interface OCRConfig {
  /** Google Cloud Vision API key. Required for OCR. */
  apiKey: string;
  /** Qwen3 base URL for local model (OpenAI-compatible API). */
  qwen3BaseUrl?: string;
  /** Qwen3 model name (default: qwen3). */
  qwen3Model?: string;
  /** Max tokens for Qwen3 response. */
  qwen3MaxTokens?: number;
  /** Temperature for Qwen3 (lower = more deterministic). */
  qwen3Temperature?: number;
  /** GCV API endpoint (default: official Google endpoint). */
  gcvEndpoint?: string;
}

const DEFAULT_CONFIG: Required<OCRConfig> = {
  apiKey: '',
  qwen3BaseUrl: '',
  qwen3Model: 'qwen3',
  qwen3MaxTokens: 8192,
  qwen3Temperature: 0.1,
  gcvEndpoint: 'https://vision.googleapis.com/v1/images:batchAnnotate',
};

// ─────────────────────────────────────────────────────────────────
// Google Cloud Vision OCR
// ─────────────────────────────────────────────────────────────────

/**
 * Call Google Cloud Vision API for DOCUMENT_TEXT_DETECTION.
 *
 * Sends the PDF buffer directly — Vision accepts PDFs up to 20MB
 * and performs OCR on each page internally.
 *
 * @param buffer — Raw PDF bytes
 * @param config — OCR configuration with API key
 * @returns Vision annotations or null on error
 */
export async function ocrDocument(
  buffer: Buffer,
  config: Partial<OCRConfig> = {},
): Promise<VisionAnnotateResponse | null> {
  const { apiKey, gcvEndpoint } = { ...DEFAULT_CONFIG, ...config };

  if (!apiKey) {
    console.warn('[OCR] No API key provided — returning null');
    return null;
  }

  // Encode PDF as base64 for the Vision API request
  const base64Pdf = buffer.toString('base64');

  const request = {
    requests: [
      {
        image: {
          content: base64Pdf,
        },
        features: [
          {
            type: 'DOCUMENT_TEXT_DETECTION',
            maxResults: 1000, // max annotations to return
          },
        ],
      },
    ],
  };

  try {
    const response = await axios.post<VisionAnnotateResponse>(
      gcvEndpoint ?? DEFAULT_CONFIG.gcvEndpoint,
      request,
      {
        params: { key: apiKey },
        headers: { 'Content-Type': 'application/json' },
        timeout: 120000, // 2 minutes for large PDFs
      },
    );

    return response.data;
  } catch (err) {
    console.error('[OCR] Google Cloud Vision API error:', (err as Error).message);
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────
// Qwen3 Structuring
// ─────────────────────────────────────────────────────────────────

/**
 * Build the system prompt for Qwen3 to structure OCR output.
 *
 * Instructs Qwen3 to output JSON matching the unified ParsedDocument schema.
 * Includes rules for mapping OCR text → elements (headings, paragraphs, tables, etc.)
 */
function buildQwen3Prompt(ocrText: string, pages: number): string {
  return [
    'You are a document parsing assistant. Convert the following OCR text output',
    'into structured elements matching a unified document schema.',
    '',
    'OCR OUTPUT:',
    '---',
    ocrText,
    '---',
    '',
    'DOCUMENT INFO:',
    `- Estimated pages: ${pages}`,
    '',
    'STRUCTURE THE DOCUMENT AS FOLLOWS:',
    '1. **Headings** — Lines that appear to be section headings (usually bold, larger text, or at the start of a new section). Output as heading elements with level 1-6 based on hierarchy.',
    '2. **Paragraphs** — Body text blocks. Keep line breaks as newlines within the paragraph.',
    '3. **Tables** — If the OCR shows tabular data (aligned columns, grid-like structure), output as a table element with headers and rows.',
    '4. **Formulas** — Mathematical expressions or equations. Output in LaTeX format.',
    '5. **Images** — References to figures, charts, or embedded images.',
    '',
    'RULES:',
    '- Output ONLY valid JSON (no markdown code fences, no explanation)',
    '- Each element must have a type, content/text, and confidence (0-1)',
    '- For tables: extract headers from the first row if apparent',
    '- For formulas: convert to LaTeX',
    '- Set confidence based on OCR quality (0.7-0.95 for clear text, 0.4-0.7 for unclear regions)',
    '- Maintain document order (top-to-bottom, left-to-right)',
    '- Detect language if not English',
    '',
    'JSON OUTPUT STRUCTURE:',
    '{',
    '  "elements": [',
    '    {"type": "heading", "text": "...", "level": 2, "confidence": 0.9},',
    '    {"type": "paragraph", "text": "...", "confidence": 0.85},',
    '    {"type": "table", "headers": ["col1", "col2"], "rows": [["a", "b"]], "confidence": 0.8},',
    '    {"type": "formula", "latex": "...", "confidence": 0.75},',
    '    {"type": "image", "alt": "...", "confidence": 0.6}',
    '  ],',
    '  "detectedLanguage": "en",',
    '  "totalPages": 1',
    '}',
    '',
    'OUTPUT ONLY THE JSON. No explanations, no markdown formatting.',
  ].join('\n');
}

/**
 * Call Qwen3 (local model) to structure OCR output.
 *
 * Uses the OpenAI-compatible API format that Qwen3 supports.
 *
 * @param ocrText — Raw OCR text from Google Cloud Vision
 * @param config — OCR configuration including Qwen3 URL
 * @param estimatedPages — Estimated page count from triage
 * @returns structured elements or empty array on error
 */
export async function structureWithQwen3(
  ocrText: string,
  config: Partial<OCRConfig> = {},
  _estimatedPages: number = 1,
): Promise<{ elements: Qwen3Element[]; detectedLanguage?: string }> {
  const { qwen3BaseUrl, qwen3Model, qwen3MaxTokens, qwen3Temperature } = {
    ...DEFAULT_CONFIG,
    ...config,
  };

  if (!qwen3BaseUrl) {
    console.warn('[Qwen3] No base URL provided — returning empty elements');
    return { elements: [], detectedLanguage: 'en' };
  }

  const prompt = buildQwen3Prompt(ocrText, _estimatedPages);

  try {
    const response = await fetch(`${qwen3BaseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(process.env.QWEN_API_KEY ? { Authorization: `Bearer ${process.env.QWEN_API_KEY}` } : {}),
      },
      body: JSON.stringify({
        model: qwen3Model,
        messages: [
          { role: 'system', content: 'You are a precise document parsing assistant. Output ONLY valid JSON matching the requested schema. No markdown, no explanation, no code fences.' },
          { role: 'user', content: prompt },
        ],
        max_tokens: qwen3MaxTokens,
        temperature: qwen3Temperature,
      }),
      signal: AbortSignal.timeout(60000), // 60 second timeout
    });

    if (!response.ok) {
      const errorBody = await response.text();
      console.error(`[Qwen3] HTTP ${response.status}: ${errorBody}`);
      return { elements: [], detectedLanguage: 'en' };
    }

    const data: Qwen3Response = await response.json();

    if (data.error) {
      console.error('[Qwen3] API error:', data.error.message);
      return { elements: [], detectedLanguage: 'en' };
    }

    const content = data.choices?.[0]?.message?.content;
    if (!content) {
      console.warn('[Qwen3] Empty response from model');
      return { elements: [], detectedLanguage: 'en' };
    }

    // Parse the JSON from the response
    // The model might wrap JSON in markdown code fences, so strip them
    let cleanContent = content.trim();
    // Remove markdown code fences if present
    if (cleanContent.startsWith('```')) {
      const lines = cleanContent.split('\n');
      // Remove first line (```json or ```)
      if (lines[0].startsWith('```')) lines.shift();
      // Remove last line if it's just ```
      const lastLine = lines[lines.length - 1];
      if (lastLine === '```') lines.pop();
      cleanContent = lines.join('\n');
    }

    const parsed = JSON.parse(cleanContent);

    return {
      elements: parsed.elements ?? [],
      detectedLanguage: parsed.detectedLanguage,
    };
  } catch (err) {
    console.error('[Qwen3] Error:', (err as Error).message);
    return { elements: [], detectedLanguage: 'en' };
  }
}

// ─────────────────────────────────────────────────────────────────
// Vision Annotation → ParsedElement Converter
// ─────────────────────────────────────────────────────────────────

/**
 * Convert Google Cloud Vision annotations to ParsedElement[] directly.
 *
 * This is used as a fallback when Qwen3 is unavailable, producing
 * a simpler element structure from raw Vision output.
 */
function visionAnnotationsToElements(
  response: VisionAnnotateResponse,
  _estimatedPages: number,
): ParsedElement[] {
  const elements: ParsedElement[] = [];
  const annotateResponse = response.responses?.[0];

  if (!annotateResponse) return elements;

  // Extract full text if available
  const fullText = annotateResponse.fullTextAnnotation?.text;
  if (!fullText) return elements;

  const lines = fullText.split('\n');

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    // Heuristic: lines starting with # are likely headings
    const headingMatch = trimmed.match(/^(#{1,6})\s+(.+)$/);
    if (headingMatch) {
      elements.push({
        type: 'heading',
        text: headingMatch[2],
        level: headingMatch[1].length,
        confidence: 0.85,
      } as HeadingElement);
      continue;
    }

    // Heuristic: all-caps lines might be section headers
    if (/^[A-Z0-9\s-()]{10,}$/.test(trimmed)) {
      elements.push({
        type: 'heading',
        text: trimmed,
        level: 2,
        confidence: 0.7,
      } as HeadingElement);
      continue;
    }

    // Otherwise, it's a paragraph
    elements.push({
      type: 'paragraph',
      text: trimmed,
      confidence: 0.75,
    } as ParagraphElement);
  }

  return elements;
}

// ─────────────────────────────────────────────────────────────────
// Main OCR Pipeline
// ─────────────────────────────────────────────────────────────────

/**
 * Run the full OCR pipeline for a scanned PDF.
 *
 * Steps:
 *   1. Google Cloud Vision OCR → raw text + layout
 *   2. Qwen3 structuring → unified ParsedDocument with elements
 *   3. Fallback: if Qwen3 fails, use Vision annotations directly
 *
 * @param buffer — Raw PDF bytes (scanned document)
 * @param triage — TriageResult indicating scanned tier
 * @param config — Optional OCR configuration
 * @returns ParsedDocument matching the unified schema
 */
export async function ocrPipeline(
  buffer: Buffer,
  triage: TriageResult,
  config: Partial<OCRConfig> = {},
): Promise<ParsedDocument> {
  const effectiveConfig = { ...DEFAULT_CONFIG, ...config };

  const doc = createEmptyDocument(
    triage.format,
    triage.tier,
    triage.estimatedPages,
    true,
    triage.detectedBy,
  );
  doc.provenance.normalizer = 'ocr';

  // ── Step 1: Google Cloud Vision OCR ──────────────────────────

  const visionResult = await ocrDocument(buffer, effectiveConfig);

  if (!visionResult) {
    // OCR failed — return empty document with OCR flag
    console.error('[OCR Pipeline] OCR failed for scanned document');
    return doc;
  }

  // ── Step 2: Qwen3 Structuring ───────────────────────────────

  // Get the full text from Vision for structuring
  const visionText = visionResult.responses?.[0]?.fullTextAnnotation?.text
    ?? visionResult.responses?.[0]?.textAnnotations?.[0]?.description
    ?? '';

  const { elements: structuredElements, detectedLanguage } = await structureWithQwen3(
    visionText,
    effectiveConfig,
    triage.estimatedPages,
  );

  if (structuredElements.length > 0) {
    // Qwen3 succeeded — map to unified schema
    for (const el of structuredElements) {
      const parsedEl = mapQwen3ElementToUnified(el);
      if (parsedEl) {
        doc.elements.push(parsedEl);
      }
    }
  } else {
    // Fallback: Vision annotations → elements
    console.warn('[OCR Pipeline] Qwen3 returned no elements, using Vision fallback');
    doc.elements = visionAnnotationsToElements(visionResult, triage.estimatedPages);
  }

  // Set language metadata if detected by Qwen3 (applies even in fallback)
  if (detectedLanguage) {
    doc.metadata.language = detectedLanguage;
  }

  // ── Step 3: Set provenance and metadata ─────────────────────

  doc.metadata.ocrProvider = 'google-cloud-vision';
  doc.metadata.structuredBy = effectiveConfig.qwen3BaseUrl ? 'qwen3' : 'vision';

  return doc;
}

/**
 * Map a Qwen3 element to a unified ParsedElement.
 *
 * Handles type mapping and field conversion.
 */
function mapQwen3ElementToUnified(el: Qwen3Element): ParsedElement | null {
  const confidence = el.confidence ?? defaultConfidenceForTier('scanned');

  switch (el.type) {
    case 'heading':
      if (!el.text) return null;
      return {
        type: 'heading',
        text: el.text,
        level: el.level ?? 2,
        confidence,
      } as HeadingElement;

    case 'paragraph':
      return {
        type: 'paragraph',
        text: el.text ?? el.content ?? '',
        confidence,
      } as ParagraphElement;

    case 'table':
      return {
        type: 'table',
        headers: el.headers ?? [],
        rows: el.rows ?? [],
        colCount: (el.headers ?? []).length,
        rowCount: (el.rows ?? []).length,
        confidence,
      } as TableElement;

    case 'formula':
      return {
        type: 'formula',
        latex: el.latex ?? el.text ?? '',
        alt: el.alt,
        confidence,
      } as FormulaElement;

    case 'image':
      return {
        type: 'image',
        alt: el.alt ?? el.text ?? '',
        confidence,
      } as ImageElement;

    default:
      return null;
  }
}

// ─────────────────────────────────────────────────────────────────
// Quick text-layer check for PDFs
// ─────────────────────────────────────────────────────────────────

/**
 * Check if a PDF has a text layer (i.e., is not a scanned image).
 *
 * Heuristic: if the PDF buffer contains extractable text markers
 * (%Text, %TextLine, font definitions, etc.), it likely has a
 * text layer. This is a rough check — the full detection happens
 * in the detector module.
 *
 * @param buffer — PDF buffer
 * @returns true if the PDF appears to have a text layer
 */
export function hasTextLayer(buffer: Buffer): boolean {
  const text = buffer.toString('utf8');

  // Check for text content markers that appear in text-layer PDFs
  const textPatterns = [
    /BT[\s\S]*?ET/, // Text block (Begin Text / End Text)
    /\/TxProc[\s\S]*?\]/, // Text state object
    /stream[\s\S]*?[\r\n][\s\S]*?endstream/, // Stream content that likely contains text ops
  ];

  return textPatterns.some((p) => p.test(text));
}

// ─────────────────────────────────────────────────────────────────
// Re-exports
// ─────────────────────────────────────────────────────────────────

export { DEFAULT_CONFIG as defaultOcrConfig };
export type { OCRConfig };
export { visionAnnotationsToElements };
