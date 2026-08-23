import { describe, it, expect } from 'vitest';
import { app } from '../src/index.js';

describe('Parsegate Health Check', () => {
  it('should return 200 on /health', async () => {
    const res = await app.request('/health');
    expect(res.status).toBe(200);
    
    const data = await res.json();
    expect(data.status).toBe('ok');
    expect(data.service).toBe('parsegate');
  });

  it('should return pricing table', async () => {
    const res = await app.request('/v1/pricing');
    expect(res.status).toBe(200);
    
    const data = await res.json();
    expect(data.tiers).toBeDefined();
    expect(data.currency).toBeDefined();

  });
});
