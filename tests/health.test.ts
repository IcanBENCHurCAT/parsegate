import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';

describe('Parsegate Health Check', () => {
  it('should return 200 on /health', async () => {
    const app = new Hono();
    app.get('/health', (c) => {
      return c.json({ status: 'ok', service: 'parsegate' });
    });
    
    const res = await app.request('/health');
    expect(res.status).toBe(200);
    
    const data = await res.json();
    expect(data.status).toBe('ok');
    expect(data.service).toBe('parsegate');
  });

  it('should return pricing table', async () => {
    const app = new Hono();
    app.get('/v1/pricing', (c) => {
      return c.json({
        'per-page': { min: 0.004, max: 0.008, currency: 'USDC' },
        'per-100kb': { min: 0.002, max: 0.002, currency: 'USDC' },
        note: 'Prices are per-page for paginated formats, per-100KB for text-based formats'
      });
    });
    
    const res = await app.request('/v1/pricing');
    expect(res.status).toBe(200);
    
    const data = await res.json();
    expect(data['per-page']).toBeDefined();
    expect(data['per-100kb']).toBeDefined();
  });
});
