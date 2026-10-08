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

## 🤖 Agent Integration Guide (AX)

Parsegate is designed for autonomous agent consumption using the **x402 protocol**.

### The Payment Challenge Flow (Sync)
1. Your agent makes a `POST /v1/parse` request with a document.
2. If unpaid, Parsegate returns a **`402 Payment Required`** with a challenge payload (cost in USDC).
3. Your agent fulfills the payment on-chain via the x402 facilitator.
4. Your agent resubmits the exact same request, now including the `x402-credential` header.
5. Parsegate verifies the credential and returns the parsed document.

### Webhook Callbacks (Async)
For long-running parses, use `/v1/parse/async` and provide an `x-webhook-url` header.
- Parsegate will immediately return a `200 OK` with a `jobId`.
- Once the parsing completes, Parsegate will make a `POST` request to your webhook URL containing the final parsed document.

## ⚠️ Error Handling

Agents should gracefully handle the following standard HTTP status codes:

| Code | Meaning | Agent Action |
|------|---------|--------------|
| **400** | Bad Request | Check if a valid file was provided in a `multipart/form-data` request, or if required headers are missing. |
| **402** | Payment Required | Fulfill the x402 challenge and resubmit with the `x402-credential` header. |
| **404** | Not Found | Returned by `/v1/jobs/:id` if the `jobId` does not exist. |
| **413** | Payload Too Large | The file exceeds the maximum allowed size (`MAX_FILE_SIZE`). |
| **429** | Too Many Requests | The free tier (`x-wallet-address`) limit of 3 calls/day has been reached. Use the paid x402 tier. |
| **500** | Internal Error | The parser failed unexpectedly. |

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
