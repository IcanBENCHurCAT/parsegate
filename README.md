# Parsegate — parsegate

> x402-native document-to-structured-data API

An x402-native document-to-structured-data API. Agents pay per parse, in stablecoins, priced by how much compute the document actually required — not a subscription, not an API key.

## 🏗️ Architecture

```
┌─────────────────────────────┐
│  Agent (HTTP client)        │
│  multipart/form-data        │
│  or presigned URL           │
└──────────────┬──────────────┘
               │
┌──────────────▼──────────────┐
│        Hono API Layer       │
│  /parse /parse/stream       │
│  x402 payment middleware    │
└──────────────┬──────────────┘
               │
┌──────────────▼──────────────┐
│  Triage / Router            │
│  detect format + complexity │
└──────────────┬──────────────┘
               │
┌──────────────▼──────────────┐
│  Unified JSON schema        │
│  (elements, tables, conf.)  │
└─────────────────────────────┘
```

## 🚀 Setup

### Local Development

```bash
# Install dependencies
npm install

# Copy .env.example and configure
cp .env.example .env

# Run locally
npm run dev
```

### API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/health` | Health check |
| GET | `/v1/pricing` | Machine-readable price table |
| POST | `/v1/parse` | Parse a document (x402 payment gated) |

## 📦 Tech Stack

- **API framework:** Hono
- **Payments:** x402 (Coinbase facilitator / Algorand)
- **Parsers:** mammoth (docx), exceljs (xlsx), pdf-parse (PDF), unified/remark (md), epub (epub)
- **Validation:** Zod
- **Runtime:** Node.js 20+

## 📄 Output Schema

All documents are normalized to a unified schema:

```typescript
interface ParsedDocument {
  format: string;
  source_pages_or_units: number;
  tier_used: "deterministic" | "vlm_assisted" | "hybrid";
  elements: Element[];
  metadata: Record<string, string | number>;
}

type Element =
  | { type: "heading"; level: number; text: string; location: Location }
  | { type: "paragraph"; text: string; location: Location }
  | { type: "table"; rows: string[][]; confidence: number; location: Location }
  | { type: "image"; description?: string; location: Location }
  | { type: "formula"; latex: string; confidence: number; location: Location };
```

## 📝 License

MIT
