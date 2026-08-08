/**
 * Tests for async endpoints and discovery (P008).
 *
 * Covers:
 *  - POST /v1/parse/async — async parse with job creation
 *  - GET /v1/jobs/:id — job status polling
 *  - GET /v1/plan — discovery endpoint (free tier)
 *  - GET /v1/jobs/stats — job queue stats
 *  - Free tier rate limiting
 *  - Webhook callback option
 *  - Error handling (missing file, invalid params, etc.)
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { app } from '../src/index.js';
import { jobStore } from '../src/jobs.js';
import { rateLimiter } from '../src/rate-limit.js';

// ── Helpers ──────────────────────────────────────────────────────

/** Create a test file part for Hono's multipart parsing. */
function makeFilePart(name: string, content: string, fileName: string) {
  return new File([content], fileName, { type: 'text/plain' });
}

/** Create a minimal test PDF buffer. */


/** Clean up any remaining jobs between tests. */
function cleanupJobs() {
  for (const id of jobStore.get ? [...jobStore['jobs'].keys()] : []) {
    jobStore.delete(id);
  }
}

// ── Setup ────────────────────────────────────────────────────────

beforeEach(() => {
  cleanupJobs();
  // Reset rate limiter between tests
  rateLimiter['entries'].clear();
});

// ── Async Parse Endpoint ─────────────────────────────────────────

describe('POST /v1/parse/async', () => {
  it('returns 400 when no file is provided', async () => {
    const res = await app.request('/v1/parse/async', { method: 'POST' });
    expect(res.status).toBe(400);
    const body = await res.json() as unknown;
    expect(body.error).toBeDefined();
  });

  it('returns 400 when no credential or wallet is provided', async () => {
    const file = makeFilePart('file', 'test content', 'test.txt');
    const formData = new FormData();
    formData.append('file', file);
    const res = await app.request('/v1/parse/async', { method: 'POST', body: formData });
    expect(res.status).toBe(400);
  });

  it('accepts x402-credential and creates a job (test mode)', async () => {
    const file = makeFilePart('file', 'test content', 'test.txt');
    const formData = new FormData();
    formData.append('file', file);

    // Use test-mode credential
    const credential = Buffer.from(JSON.stringify({
      version: 1,
      price: 0,
    })).toString('base64');

    const res = await app.request('/v1/parse/async', {
      method: 'POST',
      body: formData,
      headers: { 'x402-credential': credential },
    });

    expect(res.status).toBe(200);
    const body = await res.json() as unknown;
    expect(body.jobId).toBeDefined();
    expect(body.status).toBe('completed');
    expect(body.triage).toBeDefined();
    expect(body.triage.format).toBe('txt');
  });

  it('accepts x-wallet-address for free tier', async () => {
    const file = makeFilePart('file', 'test content', 'test.txt');
    const formData = new FormData();
    formData.append('file', file);

    const res = await app.request('/v1/parse/async', {
      method: 'POST',
      body: formData,
      headers: { 'x-wallet-address': 'test_wallet_001' },
    });

    expect(res.status).toBe(200);
    const body = await res.json() as unknown;
    expect(body.jobId).toBeDefined();
    expect(body.status).toBe('completed');
    // Free tier: price should be 0
    expect(body.payment.price.amount).toBe(0);
  });

  it('respects free tier rate limit (3 calls/day per wallet)', async () => {
    const wallet = 'rate_limit_test_wallet';

    // Make 3 free tier calls (should all succeed)
    for (let i = 0; i < 3; i++) {
      const file = makeFilePart('file', 'test content', 'test.txt');
      const formData = new FormData();
      formData.append('file', file);

      const res = await app.request('/v1/parse/async', {
        method: 'POST',
        body: formData,
        headers: { 'x-wallet-address': wallet },
      });
      expect(res.status).toBe(200, `Call ${i + 1} should succeed`);
    }

    // 4th call should be rate limited
    const file = makeFilePart('file', 'test content', 'test.txt');
    const formData = new FormData();
    formData.append('file', file);

    const res = await app.request('/v1/parse/async', {
      method: 'POST',
      body: formData,
      headers: { 'x-wallet-address': wallet },
    });

    expect(res.status).toBe(429);
    const body = await res.json() as unknown;
    expect(body.error).toContain('exceeded');
  });

  it('includes rate limit headers on free tier responses', async () => {
    const file = makeFilePart('file', 'test content', 'test.txt');
    const formData = new FormData();
    formData.append('file', file);

    const res = await app.request('/v1/parse/async', {
      method: 'POST',
      body: formData,
      headers: { 'x-wallet-address': 'header_test_wallet' },
    });

    expect(res.headers.get('X-RateLimit-Limit')).toBe('3');
    expect(res.headers.get('X-RateLimit-Remaining')).toBe('2');
  });

  it('creates a job that can be polled via /v1/jobs/:id', async () => {
    const file = makeFilePart('file', 'test content', 'test.txt');
    const formData = new FormData();
    formData.append('file', file);

    const res = await app.request('/v1/parse/async', {
      method: 'POST',
      body: formData,
      headers: { 'x-wallet-address': 'job_poll_wallet' },
    });

    expect(res.status).toBe(200);
    const body = await res.json() as unknown;
    const jobId = body.jobId;

    // Poll the job
    const pollRes = await app.request(`/v1/jobs/${jobId}`);
    expect(pollRes.status).toBe(200);
    const pollBody = await pollRes.json() as unknown;
    expect(pollBody.jobId).toBe(jobId);
    expect(pollBody.status).toBe('completed');
    expect(pollBody.result).toBeDefined();
  });

  it('returns 404 for non-existent job', async () => {
    const res = await app.request('/v1/jobs/non-existent-job-id');
    expect(res.status).toBe(404);
    const body = await res.json() as unknown;
    expect(body.error).toBe('Job not found');
  });

  it('returns job stats via /v1/jobs/stats', async () => {
    // Create a job first
    const file = makeFilePart('file', 'test content', 'test.txt');
    const formData = new FormData();
    formData.append('file', file);

    await app.request('/v1/parse/async', {
      method: 'POST',
      body: formData,
      headers: { 'x-wallet-address': 'stats_wallet' },
    });

    // Check stats
    const res = await app.request('/v1/jobs/stats');
    expect(res.status).toBe(200);
    const stats = await res.json() as unknown;
    expect(stats.total).toBeGreaterThanOrEqual(1);
    expect(stats.completed).toBeGreaterThanOrEqual(1);
    expect(stats.pending).toBe(0);
    expect(stats.processing).toBe(0);
  });
});

// ── Discovery Endpoint ───────────────────────────────────────────

describe('GET /v1/plan', () => {
  it('returns full service discovery document', async () => {
    const res = await app.request('/v1/plan');
    expect(res.status).toBe(200);
    const body = await res.json() as unknown;

    expect(body.service).toBe('parsegate');
    expect(body.version).toBe('0.1.0');
    expect(body.description).toBe('x402-native document-to-structured-data API');
    expect(body.pricing).toBeDefined();
    expect(body.endpoints).toBeDefined();
    expect(body.freeTier).toBeDefined();
  });

  it('documents all endpoints', async () => {
    const res = await app.request('/v1/plan');
    const body = await res.json() as unknown;

    expect(body.endpoints['/v1/parse']).toBeDefined();
    expect(body.endpoints['/v1/parse/async']).toBeDefined();
    expect(body.endpoints['/v1/jobs/:id']).toBeDefined();
    expect(body.endpoints['/v1/detect']).toBeDefined();
    expect(body.endpoints['/v1/pricing']).toBeDefined();
  });

  it('documents free tier limits', async () => {
    const res = await app.request('/v1/plan');
    const body = await res.json() as unknown;

    expect(body.freeTier.callsPerDay).toBe(3);
    expect(body.freeTier.per).toBe('wallet-address');
    expect(body.freeTier.note).toBeDefined();
  });

  it('documents supported formats and element types', async () => {
    const res = await app.request('/v1/plan');
    const body = await res.json() as unknown;

    expect(body.formats.text).toContain('txt');
    expect(body.formats.text).toContain('md');
    expect(body.formats.structured).toContain('csv');
    expect(body.elementTypes).toContain('heading');
    expect(body.elementTypes).toContain('paragraph');
    expect(body.elementTypes).toContain('table');
    expect(body.elementTypes).toContain('image');
    expect(body.elementTypes).toContain('formula');
  });

  it('requires no authentication (public endpoint)', async () => {
    // No headers, no auth — should succeed
    const res = await app.request('/v1/plan');
    expect(res.status).toBe(200);
  });
});

// ── Job Store ────────────────────────────────────────────────────

describe('Job Store', () => {
  it('creates jobs with correct initial state', () => {
    const job = jobStore.create('test.txt', 1024);
    expect(job.id).toBeDefined();
    expect(job.status).toBe('pending');
    expect(job.fileName).toBe('test.txt');
    expect(job.fileSize).toBe(1024);
    expect(job.webhookAttempts).toBe(0);
  });

  it('transitions job to processing', () => {
    const job = jobStore.create('test.txt', 1024);
    const started = jobStore.start(job.id);
    expect(started).not.toBeNull();
    expect(started!.status).toBe('processing');
    expect(started!.startedAt).toBeDefined();
  });

  it('transitions job to completed', () => {
    const job = jobStore.create('test.txt', 1024);
    jobStore.start(job.id);
    const completed = jobStore.complete(job.id, {
      triage: { format: 'txt' },
      document: { elements: [] },
      payment: { status: 'paid' },
    });
    expect(completed).not.toBeNull();
    expect(completed!.status).toBe('completed');
    expect(completed!.completedAt).toBeDefined();
    expect(completed!.result).toBeDefined();
  });

  it('transitions job to failed', () => {
    const job = jobStore.create('test.txt', 1024);
    jobStore.start(job.id);
    const failed = jobStore.fail(job.id, { code: 'PARSER_ERROR', message: 'Parse failed' });
    expect(failed).not.toBeNull();
    expect(failed!.status).toBe('failed');
    expect(failed!.error).toBeDefined();
  });

  it('returns null when transitioning from invalid state', () => {
    const job = jobStore.create('test.txt', 1024);
    // Try to complete a pending job (should fail — must go through processing first)
    const completed = jobStore.complete(job.id, {
      triage: { format: 'txt' },
      document: { elements: [] },
      payment: { status: 'paid' },
    });
    expect(completed).toBeNull();
  });

  it('deletes jobs', () => {
    const job = jobStore.create('test.txt', 1024);
    expect(jobStore.size).toBe(1);
    jobStore.delete(job.id);
    expect(jobStore.size).toBe(0);
  });

  it('returns correct stats', () => {
    const jobA = jobStore.create('a.txt', 100);
    jobStore.create('b.txt', 200);
    jobStore.start(jobA.id);

    const stats = jobStore.stats();
    expect(stats.total).toBe(2);
    expect(stats.pending).toBe(1);
    expect(stats.processing).toBe(1);
    expect(stats.completed).toBe(0);
    expect(stats.failed).toBe(0);
  });
});

// ── Rate Limiter ─────────────────────────────────────────────────

describe('Rate Limiter', () => {
  it('allows first 3 calls per wallet per day', () => {
    const wallet = 'rate_test_wallet';
    expect(rateLimiter.allow(wallet)).toBe(true);
    expect(rateLimiter.allow(wallet)).toBe(true);
    expect(rateLimiter.allow(wallet)).toBe(true);
  });

  it('blocks calls after limit exceeded', () => {
    const wallet = 'rate_blocked_wallet';
    rateLimiter.allow(wallet);
    rateLimiter.allow(wallet);
    rateLimiter.allow(wallet);
    expect(rateLimiter.allow(wallet)).toBe(false);
  });

  it('reports correct remaining count', () => {
    const wallet = 'remaining_wallet';
    expect(rateLimiter.remaining(wallet)).toBe(3);
    rateLimiter.allow(wallet);
    expect(rateLimiter.remaining(wallet)).toBe(2);
    rateLimiter.allow(wallet);
    expect(rateLimiter.remaining(wallet)).toBe(1);
    rateLimiter.allow(wallet);
    expect(rateLimiter.remaining(wallet)).toBe(0);
  });
});
