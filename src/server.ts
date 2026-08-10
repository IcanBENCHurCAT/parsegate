import { serve } from '@hono/node-server';
import { app } from './index.js';

const PORT = parseInt(process.env.PORT || '3000', 10);

if (import.meta.url.endsWith(process.argv[1] || '')) {
  serve({ fetch: app.fetch, port: PORT }, (info) => {
    console.log(`Parsegate listening on http://localhost:${info.port}`);
    console.log('Routes:');
    console.log('  GET    /health              — Health check');
    console.log('  GET    /v1/plan             — Discovery (free tier, no auth)');
    console.log('  GET    /v1/pricing          — Price table');
    console.log('  POST   /v1/detect           — Detect file format');
    console.log('  POST   /v1/parse             — Sync parse (x402)');
    console.log('  POST   /v1/parse/async      — Async parse (x402 or free tier)');
    console.log('  GET    /v1/jobs/:id          — Poll job status');
    console.log('  GET    /v1/jobs/stats        — Job queue stats');
  });
}
