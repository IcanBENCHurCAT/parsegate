import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { x402 } from '@x402/hono';

const app = new Hono();

// Health check endpoint
app.get('/health', (c) => {
  return c.json({ status: 'ok', service: 'parsegate', version: '0.1.0' });
});

// x402 middleware placeholder — configure after testing facilitator integration
// app.use('/v1/parse*', x402({ /* config */ }));

// Parse endpoint (boilerplate — to be implemented)
app.post('/v1/parse', async (c) => {
  return c.json({ error: 'Not implemented', message: 'Parse endpoint coming soon' }, 501);
});

// Pricing endpoint (boilerplate)
app.get('/v1/pricing', (c) => {
  return c.json({
    'per-page': { min: 0.004, max: 0.008, currency: 'USDC' },
    'per-100kb': { min: 0.002, max: 0.002, currency: 'USDC' },
    note: 'Prices are per-page for paginated formats, per-100KB for text-based formats'
  });
});

// Swagger UI (optional, for documentation)
// import { swaggerUI } from '@hono/swagger-ui';
// app.get('/docs', swaggerUI({ url: '/openapi.json' }));

const PORT = parseInt(process.env.PORT || '3000', 10);

serve({ fetch: app.fetch, port: PORT }, (info) => {
  console.log(`Parsegate listening on http://localhost:${info.port}`);
  console.log('Routes:');
  console.log('  GET  /health          — Health check');
  console.log('  GET  /v1/pricing      — Price table');
  console.log('  POST /v1/parse        — Parse documents (TBD)');
  console.log('  GET  /docs            — Swagger UI (optional)');
});
