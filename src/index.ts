import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { detectFormat } from './detector.js';
import { normalize } from './normalizer.js';
import { pricingTable } from './pricing.js';

const app = new Hono();

// Health check endpoint
app.get('/health', (c) => {
  return c.json({ status: 'ok', service: 'parsegate', version: '0.1.0' });
});

// x402 middleware placeholder — configure after testing facilitator integration
// app.use('/v1/parse*', paymentMiddleware({ /* config */ }));

// Parse endpoint (boilerplate — to be implemented)
app.post('/v1/parse', async (c) => {
  return c.json({ error: 'Not implemented', message: 'Parse endpoint coming soon' }, 501);
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

serve({ fetch: app.fetch, port: PORT }, (info) => {
  console.log(`Parsegate listening on http://localhost:${info.port}`);
  console.log('Routes:');
  console.log('  GET    /health         — Health check');
  console.log('  GET    /v1/pricing     — Price table');
  console.log('  POST   /v1/detect      — Detect file format');
  console.log('  POST   /v1/parse      — Parse documents (TBD)');
  console.log('  GET    /docs          — Swagger UI (optional)');
});
