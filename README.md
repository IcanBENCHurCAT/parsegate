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
pnpm install

# Copy .env.example and configure
cp .env.example .env

# Run locally
pnpm run dev
```

### API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/health` | Health check |
| GET | `/v1/plan` | Discovery endpoint (free tier, agent-friendly) |
| GET | `/v1/pricing` | Machine-readable price table |
| POST | `/v1/detect` | Detect file format and triage complexity (free, no auth) |
| POST | `/v1/parse` | Sync parse a document (requires `x402-credential`) |
| POST | `/v1/parse/async` | Async parse (supports `x402-credential` or `x-wallet-address` for free tier) |
| GET | `/v1/jobs/:id` | Poll async job status |
| GET | `/v1/jobs/stats` | Get job queue stats |

### Async & Free Tier Usage

The `/v1/parse/async` endpoint allows you to submit documents for asynchronous processing. This endpoint supports a **Free Tier** for testing and discovery.

1. **Submit Job (Free Tier):**
   Send a `POST` to `/v1/parse/async` with the `x-wallet-address` header. This allows up to 3 calls per day per wallet.
   *(For the paid tier, provide the standard `x402-credential` header instead).*
   You may optionally provide an `x-webhook-url` header to receive a POST request with the result when processing is complete.

2. **Poll for Result:**
   The response will contain a `jobId`. Poll the `/v1/jobs/:id` endpoint using `GET` to check the status.
   Once the status changes to `completed`, the full parsed document will be included in the response.

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

AGPLv3
