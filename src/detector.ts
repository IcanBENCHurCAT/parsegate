/**
 * Format detection + triage router for Parsegate (P002).
 *
 * Detection priority:
 * 1. Magic byte sniffing — check file headers first
 * 2. Extension fallback — use file extension for ambiguous cases
 * 3. Text content analysis — for plain files, detect markdown vs plain text
 *
 * Branch routing:
 *   xlsx, csv        → exceljs / SheetJS direct parse
 *   docx, pptx       → mammoth / XML unzip
 *   md, txt, epub    → unified/remark, epub.js
 *   PDF (text layer) → pdf-parse or pdfium WASM
 *   PDF (scanned)    → mark scanned, route to external OCR (no OCR call yet)
 */

export interface TriageResult {
  format: string;
  tier: 'text' | 'structured' | 'scanned' | 'unknown';
  estimatedPages: number;
  needsOCR: boolean;
  detectedBy: 'magic-byte' | 'extension' | 'content-analysis';
}

// ── Known file-extension → format mapping ──────────────────────────

const FORMAT_EXTENSIONS: Record<string, string[]> = {
  docx: ['doc', 'docx'],
  xlsx: ['xls', 'xlsx'],
  pptx: ['ppt', 'pptx'],
  pdf:  ['pdf'],
  md:   ['md'],
  epub: ['epub'],
  csv:  ['csv', 'tsv'],
  txt:  ['txt'],
  rtf:  ['rtf'],
};

const EXTENSION_TO_FORMAT_MAP = new Map<string, string>();
for (const [format, extensions] of Object.entries(FORMAT_EXTENSIONS)) {
  for (const ext of extensions) {
    EXTENSION_TO_FORMAT_MAP.set(ext, format);
  }
}

// ── Magic-byte signatures ─────────────────────────────────────────

const PDF_HEADER = '%PDF-';
const ZIP_HEADER = 'PK\x03\x04';
const RTF_HEADER = '{\\rtf1';

/**
 * Return the format hinted by the file header, or null.
 * 'zip' is returned for any ZIP-based format (DOCX, XLSX, PPTX, EPUB)
 * because they all share the PK\x03\x04 signature.
 */
function detectMagic(buffer: Buffer): string | null {
  if (buffer.length >= 5 && buffer.subarray(0, 5).toString() === PDF_HEADER) return 'pdf';
  if (buffer.length >= 4 && buffer.subarray(0, 4).toString() === ZIP_HEADER) return 'zip';
  if (buffer.length >= 6 && buffer.subarray(0, 6).toString() === RTF_HEADER) return 'rtf';
  return null;
}

// ── Helpers ───────────────────────────────────────────────────────

function extensionToFormat(ext: string): string | null {
  return EXTENSION_TO_FORMAT_MAP.get(ext.toLowerCase()) || null;
}

function getTier(format: string): 'text' | 'structured' | 'scanned' | 'unknown' {
  if (['txt', 'md'].includes(format)) return 'text';
  if (['xlsx', 'csv', 'docx', 'pptx', 'epub', 'rtf'].includes(format)) return 'structured';
  if (format === 'pdf') return 'scanned';
  return 'unknown';
}

/**
 * Rough page-count heuristic from file size.
 * Tuned for typical document densities.
 */
function estimatePages(buffer: Buffer, format: string): number {
  const sizeKB = buffer.length / 1024;
  switch (format) {
    case 'pdf':      return Math.max(1, Math.ceil(sizeKB / 75));
    case 'docx':     return Math.max(1, Math.ceil(sizeKB / 25));
    case 'xlsx':     return Math.max(1, Math.ceil(sizeKB / 10));
    case 'pptx':     return Math.max(1, Math.ceil(sizeKB / 20));
    case 'txt':
    case 'md':       return Math.max(1, Math.ceil(sizeKB / 3));
    case 'epub':     return Math.max(1, Math.ceil(sizeKB / 30));
    case 'csv':      return Math.max(1, Math.ceil(sizeKB / 5));
    case 'rtf':      return Math.max(1, Math.ceil(sizeKB / 25));
    default:         return 1;
  }
}

/**
 * Analyse raw text content to distinguish markdown from plain text.
 */
function analyzeContent(buffer: Buffer): { format: string } {
  try {
    const text = buffer.toString('utf8');
    if (!text.trim()) return { format: 'unknown' };

    // Reject binary content (null bytes / control chars)
    for (let i = 0; i < text.length; i++) {
      const code = text.charCodeAt(i);
      if (code < 32 && code !== 10 && code !== 13 && code !== 9) {
        return { format: 'unknown' };
      }
    }

    const markdownPatterns = [
      /^#{1,6}\s.+$/m,          // ATX headings
      /^\s*[-*+]\s+.+$/m,       // Bullet lists
      /^\s*\d+\.\s+.+$/m,       // Numbered lists
      /^`{3,}/m,                 // Code fences
      /\[.+?\]\(.+?\)/,          // Links (anywhere in line)
      /^>{1,3}\s.+$/m,           // Blockquotes
    ];

    if (markdownPatterns.some((p) => p.test(text))) {
      return { format: 'md' };
    }

    return { format: 'txt' };
  } catch {
    return { format: 'unknown' };
  }
}

// ── Public API ────────────────────────────────────────────────────

/**
 * Detect the format of a file buffer and return triage information.
 *
 * Detection priority:
 *   1. Magic byte sniffing (PDF, ZIP-based, RTF headers)
 *   2. File extension fallback
 *   3. Text content analysis (markdown vs plain text)
 *
 * @param buffer  — File content
 * @param fileName — Optional filename (used for extension fallback)
 */
export function detectFormat(
  buffer: Buffer,
  fileName?: string,
): TriageResult {
  // ── Priority 1: Magic-byte detection ────────────────────────

  const magic = detectMagic(buffer);

  // PDF
  if (magic === 'pdf') {
    const pages = estimatePages(buffer, 'pdf');
    // Heuristic: >100 KB/page suggests scanned images
    return {
      format: 'pdf',
      tier: 'scanned',
      estimatedPages: pages,
      needsOCR: buffer.length > pages * 100 * 1024,
      detectedBy: 'magic-byte',
    };
  }

  // ZIP-based (DOCX, XLSX, PPTX, EPUB) — disambiguate by extension
  if (magic === 'zip') {
    if (fileName) {
      const ext = fileName.split('.').pop()?.toLowerCase() || '';
      const format = extensionToFormat(ext);
      if (format) {
        return {
          format,
          tier: getTier(format),
          estimatedPages: estimatePages(buffer, format),
          needsOCR: false,
          detectedBy: 'magic-byte',
        };
      }
    }
  }

  // RTF
  if (magic === 'rtf') {
    return {
      format: 'rtf',
      tier: 'structured',
      estimatedPages: estimatePages(buffer, 'rtf'),
      needsOCR: false,
      detectedBy: 'magic-byte',
    };
  }

  // ── Priority 2: Extension fallback ──────────────────────────

  if (fileName) {
    const ext = fileName.split('.').pop()?.toLowerCase() || '';
    const format = extensionToFormat(ext);
    if (format) {
      return {
        format,
        tier: getTier(format),
        estimatedPages: estimatePages(buffer, format),
        needsOCR: false,
        detectedBy: 'extension',
      };
    }
  }

  // ── Priority 3: Content analysis ────────────────────────────

  const analysis = analyzeContent(buffer);
  return {
    format: analysis.format,
    tier: getTier(analysis.format),
    estimatedPages: estimatePages(buffer, analysis.format),
    needsOCR: false,
    detectedBy: 'content-analysis',
  };
}
