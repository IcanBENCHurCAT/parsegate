import { Hono } from 'hono';
import { detectFormat } from './detector.js';
import { normalize } from './normalizer.js';
import { ocrPipeline } from './ocr.js';
import { pricingTable, computePrice, computeSettlement } from './pricing.js';
import { x402Middleware, buildChallenge, validateCredential, type ParseResponse } from './payment.js';
import { config } from './config.js';
import { jobStore, tryWebhook } from './jobs.js';
import { rateLimiter } from './rate-limit.js';

const app = new Hono();

// ── Health check ─────────────────────────────────────────────────

app.get('/health', (c) => {
  return c.json({ status: 'ok', service: 'parsegate', version: '0.1.0' });
});

// ── x402 payment middleware on /v1/parse ──────────────────────────
// NOTE: We use global app.use() instead of app.use('/v1/parse*', ...)
// because Hono's path-based middleware matching doesn't work in vitest.
// The middleware itself checks the path internally.
app.use(x402Middleware());

// ── Sync parse endpoint with x402 challenge/response flow ────────

app.post('/v1/parse', async (c) => {
  try {
    const formData = await c.req.parseBody();
    const file = formData.file;

    if (!isBlob(file)) {
      return c.json({ error: 'No file provided (expected multipart upload)' }, 400);
    }

    const buffer = Buffer.from(await file.arrayBuffer());
    const fileName = (file as { name?: string }).name ?? '';

    // Step 1: Detect format + triage
    const triage = detectFormat(buffer, fileName);

    // Step 2: Compute price from triage (deterministic, no silent upcharge)
    const price = computePrice(triage);

    // Step 3: Check for x402 payment credential
    const credential = c.req.header('x402-credential');

    if (!credential || !validateCredential(credential, price)) {
      const challenge = buildChallenge(triage, price);
      return c.json(challenge, 402);
    }

    // Step 4: Process document
    const doc = triage.tier === 'scanned' && triage.needsOCR
      ? await ocrPipeline(buffer, triage, {
          apiKey: config.googleCloudVisionApiKey,
          qwen3BaseUrl: config.qwen3BaseUrl,
        })
      : normalize(buffer, triage);

    // Step 5: Compute settlement receipt
    const receipt = computeSettlement(price, 0);

    // Step 6: Return parsed result + settlement receipt
    const response: ParseResponse = {
      triage,
      document: doc,
      payment: { status: 'paid', price, receipt },
    };

    return c.json(response, 200);
  } catch (err) {
    return c.json({ error: 'Parse failed', details: (err as Error).message }, 500);
  }
});

// ── Async parse endpoint (P008) — returns job ID immediately ────

app.post('/v1/parse/async', async (c) => {
  try {
    const formData = await c.req.parseBody();
    const file = formData.file;

    if (!isBlob(file)) {
      return c.json({ error: 'No file provided (expected multipart upload)' }, 400);
    }

    const buffer = Buffer.from(await file.arrayBuffer());
    const fileName = (file as { name?: string }).name ?? '';
    const fileSize = buffer.byteLength;

    // Check for optional webhook callback URL
    const webhookUrl = c.req.header('x-webhook-url') || undefined;

    // Check for free tier or paid x402 credential
    const credential = c.req.header('x402-credential');
    const wallet = c.req.header('x-wallet-address') || '';

    if (!credential && !wallet) {
      return c.json({ error: 'Provide x402-credential (paid) or x-wallet-address (free tier)' }, 400);
    }

    // Free tier: rate limit (3 calls/day per wallet)
    if (!credential && wallet) {
      const allowed = rateLimiter.allow(wallet);
      if (!allowed) {
        const headers = rateLimiter.headers(wallet);
        return c.json(
          { error: 'Free tier limit exceeded', detail: '3 calls per day per wallet', wallet },
          429,
          headers as unknown as Record<string, string>,
        );
      }
      // Attach rate limit headers to response
      const headers = rateLimiter.headers(wallet);
      for (const [key, value] of Object.entries(headers)) {
        c.header(key, value);
      }
    }

    // Compute price (for x402 settlement at submission time)
    const triage = detectFormat(buffer, fileName);
    const price = computePrice(triage);

    // If no x402 credential and using free tier: set price to 0 (free tier)
    const effectivePrice = credential ? price : { ...price, amount: 0, currency: 'USDC' };

    // Step 1: Create job and transition to processing
    const job = jobStore.create(fileName, fileSize);
    jobStore.start(job.id);

    // Step 2: Process document asynchronously (still within this request, but structured for future background processing)
    // In production, this would enqueue a background job
    const doc = triage.tier === 'scanned' && triage.needsOCR
      ? await ocrPipeline(buffer, triage, {
          apiKey: config.googleCloudVisionApiKey,
          qwen3BaseUrl: config.qwen3BaseUrl,
        })
      : normalize(buffer, triage);

    const receipt = computeSettlement(effectivePrice, 0);

    // Step 3: Mark job as completed
    jobStore.complete(job.id, {
      triage,
      document: doc,
      payment: { status: 'paid', price: effectivePrice, receipt },
    });

    // Step 4: Try webhook callback
    if (webhookUrl) {
      try {
        job.webhookUrl = webhookUrl;
        const webhookOk = await tryWebhook(job);
        if (webhookOk) {
          job.webhookAttempts = job.maxWebhookRetries;
        }
      } catch {
        // Webhook delivery failure is non-fatal
      }
    }

    // Step 5: Return job ID immediately
    return c.json({
      jobId: job.id,
      status: 'completed',
      triage,
      document: doc,
      payment: { status: 'paid', price: effectivePrice, receipt },
      _metadata: {
        fileName,
        fileSize,
        processedAt: new Date().toISOString(),
        webhookDelivered: webhookUrl ? 'attempted' : 'skipped',
      },
    }, 200);
  } catch (err) {
    return c.json({ error: 'Async parse failed', details: (err as Error).message }, 500);
  }
});

// ── Job stats endpoint (MUST be before /v1/jobs/:id for Hono routing) ──

app.get('/v1/jobs/stats', (c) => {
  const stats = jobStore.stats();
  return c.json(stats);
});

// ── Job status endpoint (P008) — poll for result ─────────────────

app.get('/v1/jobs/:id', (c) => {
  const id = c.req.param('id');
  const job = jobStore.get(id);

  if (!job) {
    return c.json({ error: 'Job not found', jobId: id }, 404);
  }

  // Return lightweight status (no document content in status poll)
  return c.json({
    jobId: job.id,
    status: job.status,
    fileName: job.fileName,
    fileSize: job.fileSize,
    createdAt: new Date(job.createdAt).toISOString(),
    completedAt: job.completedAt ? new Date(job.completedAt).toISOString() : undefined,
    format: job.format,
    // Include result only if completed
    result: job.status === 'completed' && job.result ? {
      triage: job.result.triage,
      document: job.result.document,
      payment: job.result.payment,
    } : undefined,
    error: job.error ? { code: job.error.code, message: job.error.message } : undefined,
    webhookUrl: job.webhookUrl,
    webhookAttempts: job.webhookAttempts,
  });
});

// ── Discovery endpoint (P008) — free tier, agent-friendly ──────

app.get('/v1/plan', (c) => {
  return c.json({
    service: 'parsegate',
    version: '0.1.0',
    description: 'x402-native document-to-structured-data API',
    pricing: pricingTable,
    endpoints: {
      '/v1/parse': {
        method: 'POST',
        description: 'Sync parse — upload file, get parsed document (requires x402 payment)',
        contentType: 'multipart/form-data',
        requiredHeaders: ['x402-credential'],
      },
      '/v1/parse/async': {
        method: 'POST',
        description: 'Async parse — upload file, get job ID, returns immediately (supports x402 or free tier)',
        contentType: 'multipart/form-data',
        optionalHeaders: {
          'x402-credential': 'Paid tier (full access)',
          'x-wallet-address': 'Free tier (3 calls/day)',
          'x-webhook-url': 'Optional webhook callback on completion',
        },
      },
      '/v1/jobs/:id': {
        method: 'GET',
        description: 'Poll job status and retrieve result',
        pathParams: { id: 'Job ID from async response' },
      },
      '/v1/jobs/stats': {
        method: 'GET',
        description: 'Get job queue stats',
      },
      '/v1/detect': {
        method: 'POST',
        description: 'Detect file format without parsing (free, no auth required)',
        contentType: 'multipart/form-data',
        returns: 'TriageResult with format, tier, estimatedPages, needsOCR',
      },
      '/v1/pricing': {
        method: 'GET',
        description: 'Get full price table',
        auth: 'none',
      },
    },
    freeTier: {
      callsPerDay: 3,
      per: 'wallet-address',
      note: 'Free tier provides 3 calls/day per wallet address for discovery and testing. Not on the paid path — separate rate limit counter.',
    },
    formats: {
      text: ['txt', 'md'],
      structured: ['xlsx', 'csv', 'docx', 'pptx', 'epub', 'rtf'],
      scanned: ['pdf (scanned)'],
    },
    elementTypes: ['heading', 'paragraph', 'table', 'image', 'formula'],
  });
});

// ── Pricing endpoint (uses pricing engine) ──────────────────────

app.get('/v1/pricing', (c) => {
  return c.json(pricingTable);
});

// ── Format detection endpoint ───────────────────────────────────

app.post('/v1/detect', async (c) => {
  try {
    const formData = await c.req.parseBody();
    const file = formData.file;

    if (!isBlob(file)) {
      return c.json({ error: 'No file provided (expected multipart upload)' }, 400);
    }

    const buffer = Buffer.from(await file.arrayBuffer());
    const fileName = (file as { name?: string }).name ?? '';

    const triage = detectFormat(buffer, fileName);
    const doc = triage.tier === 'scanned' && triage.needsOCR
      ? await ocrPipeline(buffer, triage, {
          apiKey: config.googleCloudVisionApiKey,
          qwen3BaseUrl: config.qwen3BaseUrl,
        })
      : normalize(buffer, triage);

    return c.json({ triage, document: doc });
  } catch (err) {
    return c.json({ error: 'Detection failed', details: (err as Error).message }, 500);
  }
});

// ── Helpers ─────────────────────────────────────────────────────

function isBlob(value: unknown): value is Blob {
  return value != null && typeof (value as Blob).arrayBuffer === 'function';
}

// Export for testing
export { app };

// Export types for SDK consumers
export type { ParseResponse, PaymentChallenge, ParsedCredential, PaymentRequirement } from './payment.js';
export type { ParsedDocument, ParsedElement, ParagraphElement, HeadingElement, TableElement, ImageElement, FormulaElement, ElementBase, LocationInfo } from './schema.js';
export type { ComputedPrice, SettlementReceipt, PriceTier, PricingTable } from './pricing.js';
export type { TriageResult } from './detector.js';
