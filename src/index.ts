import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { detectFormat } from './detector.js';
import { normalize } from './normalizer.js';
import { pricingTable, computePrice, computeSettlement } from './pricing.js';
import { x402Middleware, buildChallenge, buildTestCredential, validateCredential, type ParseResponse } from './payment.js';

const app = new Hono();

// Health check endpoint
app.get('/health', (c) => {
  return c.json({ status: 'ok', service: 'parsegate', version: '0.1.0' });
});

// ── x402 payment middleware on /v1/parse ──────────────────────────
// NOTE: We use global app.use() instead of app.use('/v1/parse*', ...)
// because Hono's path-based middleware matching doesn't work in vitest.
// The middleware itself checks the path internally.
app.use(x402Middleware());

// ── Parse endpoint with x402 challenge/response flow ──────────────
app.post('/v1/parse', async (c) => {
  try {
    // Parse multipart form data (file upload)
    const formData = await c.req.parseBody();
    const file = formData.file;

    if (!isBlob(file)) {
      return c.json(
        { error: 'No file provided (expected multipart upload)' },
        400,
      );
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
      // No valid credential → return 402 with detailed challenge
      const challenge = buildChallenge(triage, price);
      return c.json(challenge, 402);
    }

    // Step 4: Credential valid → process document
    const doc = normalize(buffer, triage);

    // Step 5: Compute settlement receipt
    // In v0: we eat the loss if actual cost exceeds quoted price
    const receipt = computeSettlement(price, 0);

    // Step 6: Return 200 with parsed result + settlement receipt
    const response: ParseResponse = {
      triage,
      document: doc,
      payment: {
        status: 'paid',
        price,
        receipt,
      },
    };

    return c.json(response, 200);
  } catch (err) {
    return c.json(
      { error: 'Parse failed', details: (err as Error).message },
      500,
    );
  }
});

// Pricing endpoint — uses pricing engine
app.get('/v1/pricing', (c) => {
  return c.json(pricingTable);
});

function isBlob(value: unknown): value is Blob {
  return value != null && typeof (value as Blob).arrayBuffer === 'function';
}

// ── Format detection endpoint ───────────────────────────────────
app.post('/v1/detect', async (c) => {
  try {
    const formData = await c.req.parseBody();
    const file = formData.file;

    if (!isBlob(file)) {
      return c.json(
        { error: 'No file provided (expected multipart upload)' },
        400,
      );
    }

    const buffer = Buffer.from(await file.arrayBuffer());
    // Hono's FormData exposes file as a File object with .name property
    const fileName = (file as { name?: string }).name ?? '';

    const triage = detectFormat(buffer, fileName);
    const doc = normalize(buffer, triage);

    return c.json({ triage, document: doc });
  } catch (err) {
    return c.json(
      { error: 'Detection failed', details: (err as Error).message },
      500,
    );
  }
});

// Swagger UI (optional, for documentation)
// import { swaggerUI } from '@hono/swagger-ui';
// app.get('/docs', swaggerUI({ url: '/openapi.json' }));

const PORT = parseInt(process.env.PORT || '3000', 10);

// Start server only when run directly (not when imported as module for tests)
if (import.meta.url.endsWith(process.argv[1] || '')) {
  serve({ fetch: app.fetch, port: PORT }, (info) => {
    console.log(`Parsegate listening on http://localhost:${info.port}`);
    console.log('Routes:');
    console.log('  GET    /health         — Health check');
    console.log('  GET    /v1/pricing     — Price table');
    console.log('  POST   /v1/detect      — Detect file format');
    console.log('  POST   /v1/parse      — Parse documents (TBD)');
    console.log('  GET    /docs          — Swagger UI (optional)');
  });
}
