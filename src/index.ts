import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { x402 } from '@x402/hono';
import { processQueue, submitJob, jobStore } from './async';
import { discoverApp } from './discover';
import { webhookApp } from './webhook';

const app = new Hono();

// Mount sub-apps (order matters — specific routes first, then catch-alls)
app.route('/', discoverApp);
app.route('/', webhookApp);

// Health check endpoint
app.get('/health', (c) => {
  const counts = jobStore.statusCounts();
  return c.json({
    status: 'ok',
    service: 'parsegate',
    version: '0.2.0',
    jobs: counts,
  });
});

// x402 middleware placeholder — configure after testing facilitator integration
// app.use('/v1/parse*', x402({ /* config */ }));

// ── Sync Parse Endpoint ──────────────────────────────────────────────
// POST /v1/parse
// Accepts file upload, processes synchronously, returns result immediately.
// x402 payment settles at submission time.
app.post('/v1/parse', async (c) => {
  return c.json({ error: 'Not implemented', message: 'Sync parse coming soon' }, 501);
});

// ── Async Parse Endpoint ─────────────────────────────────────────────
// POST /v1/parse/async
// Accepts file upload, returns job ID immediately.
// Processing happens in background. Poll GET /v1/jobs/:id for status.
// x402 payment settles at submission time.
app.post('/v1/parse/async', async (c) => {
  try {
    // Parse multipart form data for file upload
    const formData = await c.req.parseBody();

    const file = formData.file as File | undefined;
    const webhookUrl = (formData.webhook_url as string) || undefined;
    const x402Signature = (formData.x402_signature as string) || undefined;

    let fileMime: string | undefined;
    let fileData: string | undefined;

    if (file && typeof file.arrayBuffer === 'function') {
      fileMime = file.type || undefined;
      // In production, convert to base64 or process directly
      fileData = `[file: ${file.name}, mime: ${fileMime}, size: ${file.size} bytes]`;
    }

    // Submit async job
    const job = submitJob({
      file: fileData,
      fileMime,
      webhookUrl,
    });

    // Kick off async processing (non-blocking)
    setImmediate(async () => {
      await processQueue();
    });

    // x402 settlement placeholder — if x402 signature provided, settle payment
    if (x402Signature) {
      // In production, verify and settle x402 payment here
      // jobStore.update(job.id, { x402PaymentStatus: 'paid' });
    }

    return c.json({
      jobId: job.id,
      status: job.status,
      createdAt: new Date(job.createdAt).toISOString(),
      webhookUrl: job.webhookUrl ? true : false,
    });
  } catch (error) {
    return c.json({
      error: 'Failed to submit async job',
      message: error instanceof Error ? error.message : 'Unknown error',
    }, 400);
  }
});

// ── Job Poll Endpoint ────────────────────────────────────────────────
// GET /v1/jobs/:id
// Returns current job status and result if completed.
app.get('/v1/jobs/:id', (c) => {
  const jobId = c.req.param('id');
  const job = jobStore.get(jobId);

  if (!job) {
    return c.json({ error: 'Job not found' }, 404);
  }

  return c.json({
    jobId: job.id,
    status: job.status,
    createdAt: new Date(job.createdAt).toISOString(),
    updatedAt: new Date(job.updatedAt).toISOString(),
    result: job.result,
    error: job.error,
    estimatedCost: job.estimatedCost,
    actualCost: job.actualCost,
    x402PaymentStatus: job.x402PaymentStatus,
    webhookUrl: job.webhookUrl,
    webhookAttempted: job.webhookAttempted,
  });
});

// ── Pricing Endpoint ─────────────────────────────────────────────────
// GET /v1/pricing
// Returns price table for parsed documents.
app.get('/v1/pricing', (c) => {
  return c.json({
    'per-page': { min: 0.004, max: 0.008, currency: 'USDC' },
    'per-100kb': { min: 0.002, max: 0.002, currency: 'USDC' },
    note: 'Prices are per-page for paginated formats, per-100KB for text-based formats',
  });
});

// ── Job List Endpoint ────────────────────────────────────────────────
// GET /v1/jobs
// Returns all jobs (useful for debugging/testing).
app.get('/v1/jobs', (c) => {
  const jobs = jobStore.getAll().map(job => ({
    jobId: job.id,
    status: job.status,
    createdAt: new Date(job.createdAt).toISOString(),
    updatedAt: new Date(job.updatedAt).toISOString(),
  }));

  return c.json({ jobs, total: jobs.length });
});

// Start the server (only when run directly, not when imported for tests)
export function startServer(): void {
  const PORT = parseInt(process.env.PORT || '3000', 10);

  serve({ fetch: app.fetch, port: PORT }, (info) => {
    console.log(`Parsegate listening on http://localhost:${info.port}`);
    console.log('Routes:');
    console.log('  GET  /health              — Health check');
    console.log('  GET  /v1/pricing          — Price table');
    console.log('  GET  /v1/discover         — Service discovery (free tier)');
    console.log('  POST /v1/parse            — Sync parse (TBD)');
    console.log('  POST /v1/parse/async      — Async parse (returns job ID)');
    console.log('  GET  /v1/jobs/:id         — Poll job status');
    console.log('  GET  /v1/jobs             — List all jobs');
    console.log('  POST /v1/webhooks/receive — Webhook receiver');
    console.log('  GET  /v1/webhooks/status  — Webhook status');
  });
}

if (import.meta.main) {
  startServer();
}

export { app };
