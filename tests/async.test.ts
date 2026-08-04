import { describe, it, expect, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { app } from '../src/index';
import { jobStore, submitJob, processQueue } from '../src/async';
import { freeTierLimiter } from '../src/discover';

describe('Parsegate Async Endpoints', () => {
  beforeEach(() => {
    // Clear job store between tests
    jobStore['jobs'].clear();
    // Clear rate limit store between tests
    freeTierLimiter['stores'].clear();
  });

  describe('GET /health', () => {
    it('should return health status with job counts', async () => {
      const res = await app.request('/health');
      expect(res.status).toBe(200);

      const data = await res.json();
      expect(data.status).toBe('ok');
      expect(data.service).toBe('parsegate');
      expect(data.version).toBe('0.2.0');
      expect(data.jobs).toBeDefined();
    });
  });

  describe('GET /v1/pricing', () => {
    it('should return pricing table', async () => {
      const res = await app.request('/v1/pricing');
      expect(res.status).toBe(200);

      const data = await res.json();
      expect(data['per-page']).toBeDefined();
      expect(data['per-100kb']).toBeDefined();
      expect(data['per-page'].currency).toBe('USDC');
    });
  });

  describe('GET /v1/discover', () => {
    it('should return service discovery info', async () => {
      const res = await app.request('/v1/discover');
      expect(res.status).toBe(200);

      const data = await res.json();
      expect(data.service).toBe('parsegate');
      expect(data.version).toBe('0.2.0');
      expect(data.description).toBeDefined();
      expect(data.endpoints).toBeDefined();
      expect(data.endpoints.sync).toBe('/v1/parse');
      expect(data.endpoints.async).toBe('/v1/parse/async');
      expect(data.endpoints.poll).toBe('/v1/jobs/:id');
      expect(data.endpoints.discover).toBe('/v1/discover');
      expect(data.tiers).toBeDefined();
      expect(data.tiers.free.callsPerDay).toBe(3);
      expect(data.tiers.paid.currency).toBe('USDC');
      expect(data.features).toBeDefined();
      expect(data.features.length).toBeGreaterThan(0);
    });

    it('should include rate limit info when wallet is provided', async () => {
      const res = await app.request('/v1/discover?wallet=0x1234');
      expect(res.status).toBe(200);

      const data = await res.json();
      expect(data.tiers.free.walletAddress).toBe('0x1234');
    });
  });

  describe('GET /v1/discover/rate-limit', () => {
    it('should return rate limit info for wallet', async () => {
      const res = await app.request('/v1/discover/rate-limit?wallet=0x1234');
      expect(res.status).toBe(200);

      const data = await res.json();
      expect(data.walletAddress).toBe('0x1234');
      expect(data.callsToday).toBe(0);
      expect(data.limitPerDay).toBe(3);
      expect(data.remaining).toBe(3);
      expect(data.resetAt).toBeDefined();
    });

    it('should return 400 when wallet is missing', async () => {
      const res = await app.request('/v1/discover/rate-limit');
      expect(res.status).toBe(400);

      const data = await res.json();
      expect(data.error).toBe('wallet query parameter required');
    });
  });

  describe('POST /v1/discover/consume', () => {
    it('should consume a free tier call', async () => {
      const res = await app.request('/v1/discover/consume', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ wallet: '0x1234' }),
      });
      expect(res.status).toBe(200);

      const data = await res.json();
      expect(data.allowed).toBe(true);
      expect(data.rateLimit.remaining).toBe(2);
    });

    it('should reject when wallet is missing', async () => {
      const res = await app.request('/v1/discover/consume', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(400);
    });

    it('should reject when rate limit exceeded', async () => {
      // Consume 3 calls
      await app.request('/v1/discover/consume', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ wallet: '0x5678' }),
      });
      await app.request('/v1/discover/consume', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ wallet: '0x5678' }),
      });
      await app.request('/v1/discover/consume', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ wallet: '0x5678' }),
      });

      // 4th call should fail
      const res = await app.request('/v1/discover/consume', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ wallet: '0x5678' }),
      });
      expect(res.status).toBe(429);

      const data = await res.json();
      expect(data.error).toBe('Rate limit exceeded');
      expect(data.rateLimit.remaining).toBe(0);
    });
  });

  describe('POST /v1/parse/async', () => {
    it('should submit an async job and return job ID', async () => {
      const res = await app.request('/v1/parse/async', {
        method: 'POST',
      });
      expect(res.status).toBe(200);

      const data = await res.json();
      expect(data.jobId).toBeDefined();
      expect(typeof data.jobId).toBe('string');
      expect(data.status).toBe('pending');
      expect(data.createdAt).toBeDefined();
    });

    it('should return job ID with valid format (UUID)', async () => {
      const res = await app.request('/v1/parse/async', {
        method: 'POST',
      });
      const data = await res.json();
      // UUID format: 8-4-4-4-12 hex chars
      const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      expect(uuidRegex.test(data.jobId)).toBe(true);
    });
  });

  describe('GET /v1/jobs/:id', () => {
    it('should return job status after submission', async () => {
      // Submit job first
      const submitRes = await app.request('/v1/parse/async', {
        method: 'POST',
      });
      const submitData = await submitRes.json();
      const jobId = submitData.jobId;

      // Poll job status
      const res = await app.request(`/v1/jobs/${jobId}`);
      expect(res.status).toBe(200);

      const data = await res.json();
      expect(data.jobId).toBe(jobId);
      expect(['pending', 'processing', 'completed']).toContain(data.status);
      expect(data.createdAt).toBeDefined();
      expect(data.updatedAt).toBeDefined();
    });

    it('should return 404 for non-existent job', async () => {
      const res = await app.request('/v1/jobs/non-existent-id');
      expect(res.status).toBe(404);

      const data = await res.json();
      expect(data.error).toBe('Job not found');
    });

    it('should return result after job completion', async () => {
      // Directly create a completed job for testing
      const job = submitJob({ fileMime: 'application/pdf' });
      jobStore.update(job.id, {
        status: 'completed',
        updatedAt: Date.now(),
        result: { document: { format: 'pdf', pages: 5 } },
      });

      const res = await app.request(`/v1/jobs/${job.id}`);
      expect(res.status).toBe(200);

      const data = await res.json();
      expect(data.jobId).toBe(job.id);
      expect(data.status).toBe('completed');
      expect(data.result).toBeDefined();
      expect(data.result.document).toBeDefined();
    });

    it('should return error for failed job', async () => {
      const job = submitJob({ fileMime: 'image/tiff' });
      jobStore.update(job.id, {
        status: 'failed',
        updatedAt: Date.now(),
        error: 'Unsupported format',
      });

      const res = await app.request(`/v1/jobs/${job.id}`);
      expect(res.status).toBe(200);

      const data = await res.json();
      expect(data.status).toBe('failed');
      expect(data.error).toBe('Unsupported format');
    });
  });

  describe('GET /v1/jobs', () => {
    it('should return list of all jobs', async () => {
      // Create a few jobs
      submitJob({ fileMime: 'application/pdf' });
      submitJob({ fileMime: 'application/docx' });
      submitJob({ fileMime: 'text/plain' });

      const res = await app.request('/v1/jobs');
      expect(res.status).toBe(200);

      const data = await res.json();
      expect(data.jobs).toBeDefined();
      expect(Array.isArray(data.jobs)).toBe(true);
      expect(data.jobs.length).toBe(3);
      expect(data.total).toBe(3);

      // Check job structure
      expect(data.jobs[0]).toHaveProperty('jobId');
      expect(data.jobs[0]).toHaveProperty('status');
      expect(data.jobs[0]).toHaveProperty('createdAt');
    });

    it('should return empty list when no jobs exist', async () => {
      const res = await app.request('/v1/jobs');
      expect(res.status).toBe(200);

      const data = await res.json();
      expect(data.jobs).toEqual([]);
      expect(data.total).toBe(0);
    });
  });

  describe('Job Store', () => {
    it('should create and retrieve jobs', () => {
      const job = submitJob({ fileMime: 'application/pdf' });
      const retrieved = jobStore.get(job.id);

      expect(retrieved).toBeDefined();
      expect(retrieved!.id).toBe(job.id);
      expect(retrieved!.status).toBe('pending');
    });

    it('should update job status', () => {
      const job = submitJob({ fileMime: 'application/pdf' });
      const updated = jobStore.update(job.id, {
        status: 'processing',
        updatedAt: Date.now(),
      });

      expect(updated!.status).toBe('processing');
      expect(updated!.updatedAt).toBeDefined();

      // Verify in store
      const retrieved = jobStore.get(job.id);
      expect(retrieved!.status).toBe('processing');
    });

    it('should return undefined for non-existent job', () => {
      const retrieved = jobStore.get('non-existent-id');
      expect(retrieved).toBeUndefined();
    });

    it('should return status counts', () => {
      submitJob({ fileMime: 'application/pdf' });
      submitJob({ fileMime: 'text/plain' });
      const job3 = submitJob({ fileMime: 'application/docx' });
      jobStore.update(job3.id, { status: 'completed' });

      const counts = jobStore.statusCounts();
      expect(counts.pending).toBe(2);
      expect(counts.completed).toBe(1);
    });
  });

  describe('Async Processing (processQueue)', () => {
    it('should process pending jobs', async () => {
      const job = submitJob({ fileMime: 'application/pdf' });
      expect(job.status).toBe('pending');

      // Process the queue
      await processQueue();

      // Verify job was processed
      const updatedJob = jobStore.get(job.id);
      expect(updatedJob).toBeDefined();
      expect(updatedJob!.status).toBe('completed');
      expect(updatedJob!.result).toBeDefined();
    });

    it('should process multiple jobs in order', async () => {
      const job1 = submitJob({ fileMime: 'application/pdf' });
      const job2 = submitJob({ fileMime: 'text/plain' });
      const job3 = submitJob({ fileMime: 'application/docx' });

      await processQueue();

      const j1 = jobStore.get(job1.id);
      const j2 = jobStore.get(job2.id);
      const j3 = jobStore.get(job3.id);

      expect(j1!.status).toBe('completed');
      expect(j2!.status).toBe('completed');
      expect(j3!.status).toBe('completed');
    });
  });

  describe('Integration: Async Submit -> Poll -> Complete', () => {
    it('should flow from submission to completion', async () => {
      // 1. Submit async job
      const submitRes = await app.request('/v1/parse/async', {
        method: 'POST',
      });
      const submitData = await submitRes.json();
      const jobId = submitData.jobId;

      expect(submitData.status).toBe('pending');

      // 2. Process the queue (simulate background processing)
      await processQueue();

      // 3. Poll for result
      const pollRes = await app.request(`/v1/jobs/${jobId}`);
      expect(pollRes.status).toBe(200);

      const pollData = await pollRes.json();
      expect(pollData.status).toBe('completed');
      expect(pollData.result).toBeDefined();
      expect(pollData.result.document).toBeDefined();
    });
  });
});
