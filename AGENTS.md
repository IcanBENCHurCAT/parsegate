# AGENTS.md — Agent Guide for Parsegate

Welcome, agent. This document outlines the project guidelines, architecture, and coding conventions for Parsegate, an x402-native document-to-structured-data API.

---

## 1. Project Overview

Parsegate is a service that implements an HTTP `402 Payment Required` interface to parse complex documents (PDFs, Excel, Word, Markdown, etc.) into a unified, machine-readable JSON structure.

### Core Architecture
- **API Layer**: Hono/TypeScript web server handling file uploads (`multipart/form-data`) and asynchronous job polling.
- **x402 Payment Middleware**: Integrates with `@x402/hono` to return HTTP 402 challenges based on document complexity (pricing determined by `computePrice`).
- **Triage / Router**: Detects the file format and complexity (deterministic, vlm_assisted, hybrid) and routes the document to the appropriate parser.
- **Parsers & OCR Pipeline**: Uses `mammoth`, `exceljs`, `pdf-parse`, `epub`, and unified plugins. Employs a fallback OCR pipeline utilizing Google Cloud Vision and Qwen3 for unstructured or scanned PDFs.
- **Unified JSON Schema**: Transforms diverse inputs into standard types (e.g., headings, paragraphs, tables, images) matching `ParsedDocument`.

---

## 2. Directory Structure

```text
parsegate/
├── .github/                # CI workflows and templates
├── docs/                   # Additional documentation
├── src/                    # TypeScript Source Code
│   ├── index.ts            # Main SDK entrypoint & Hono application
│   ├── server.ts           # Standalone web server entrypoint
│   ├── config.ts           # Centralized environment/configuration
│   ├── detector.ts         # Format detection and complexity triage
│   ├── normalizer.ts       # Structured document parsing
│   ├── ocr.ts              # Fallback Vision/Qwen3 pipeline
│   ├── payment.ts          # x402 middleware and validation
│   ├── pricing.ts          # Price calculation logic
│   ├── schema.ts           # Unified output interfaces
│   ├── jobs.ts             # Asynchronous parsing jobs store
│   └── rate-limit.ts       # Free tier usage tracking
├── tests/                  # Vitest test suite
├── package.json            # Configuration, using `exports` field
├── README.md               # Quickstart and architecture overview
└── AGENTS.md               # This guide
```

---

## 3. Technology Stack & Key Libraries

- **Backend Framework**: Node.js 20+, TypeScript, Hono (`@hono/node-server`).
- **Payments**: `@x402/core`, `@x402/hono`, `@x402/avm`, `@x402/extensions`.
- **Parsing**: `mammoth`, `exceljs`, `pdf-parse`, `epub`, `unified`, `remark-parse`.
- **Validation**: `zod`.
- **Package Manager**: `pnpm` exclusively.

---

## 4. Coding Conventions & Guardrails

- **Package Manager**: Use `pnpm` exclusively; never use npm or yarn.
- **ES Modules**: The project uses `"type": "module"`. Ensure local imports use `.js` extensions (e.g., `import { jobStore } from './jobs.js'`). For testing/running files directly, use `.cjs` or `pnpm exec tsx`.
- **SDK Exports**: The `package.json` restricts exports to `.`, mapping to `dist/index.js`. Consume internal elements only through `src/index.ts`. Ensure all public interfaces, schemas, and types remain explicitly exported in `src/index.ts`.
- **Server Singletons**: Do not export internal singletons (like `jobStore`, `rateLimiter`, `x402Middleware`) from `src/index.ts` to keep the public API surface clean.
- **Testing Hono**: Because Hono's path-based middleware matching fails in Vitest, apply middleware globally (`app.use(middleware())`) and perform internal path checks inside the middleware logic. Tests must import the actual `app` instance from `src/index.js` to test routing accurately.
- **Strict TypeScript Linting**: The ESLint configuration (`.eslintrc.cjs`) strictly warns against `@typescript-eslint/no-unused-vars` and `@typescript-eslint/no-explicit-any`. All variables should be strongly typed.
- **No Hardcoded Secrets**: Manage all application settings and environment variables centrally from `src/config.ts`.
- **Build Output**: The project uses `tsc` to compile code to the `dist/` directory, outputting both JS and `.d.ts` declaration files.
- **License**: All contributions must adhere to the AGPLv3 license.

---

## 5. Client Methods & Endpoints (P008)

The main endpoints for agent consumption include:

### `POST /v1/parse` (Sync)
- Requires `x402-credential` for payment validation.
- Agent uploads file (`multipart/form-data`) -> Receives 402 Challenge if unpaid or invalid -> Submits paid credential -> Receives JSON `ParseResponse` including the parsed document and settlement receipt.

### `POST /v1/parse/async` (Async)
- Accepts both `x402-credential` (Paid tier) and `x-wallet-address` (Free tier, limited to 3/day).
- Returns an immediate JSON response containing the `jobId` and initial `triage` data.
- Can accept an optional `x-webhook-url` header for callback execution upon job completion.

### `GET /v1/jobs/:id` (Polling)
- Retrieves the status of an asynchronous job (`pending`, `processing`, `completed`, `failed`).
- Returns the full `ParseResponse` data once `status` is `completed`.

### `GET /v1/detect` (Free)
- Open detection endpoint to determine format, `needsOCR`, and `estimatedPages` prior to committing to a parse job.

---
*Keep this document updated as the project evolves.*