/**
 * Async job system for Parsegate.
 * In-memory job store with async processing capability.
 */

import crypto from 'crypto';
import type { Job } from './types';

function generateId(): string {
  return crypto.randomUUID();
}

/**
 * Job store — in-memory Map.
 * In production, replace with Redis or database.
 */
export class JobStore {
  private jobs = new Map<string, Job>();
  private retentionMs = 3600_000; // 1 hour retention

  create(job: Job): Job {
    this.jobs.set(job.id, job);
    return job;
  }

  get(id: string): Job | undefined {
    return this.jobs.get(id);
  }

  update(id: string, partial: Partial<Job>): Job | undefined {
    const existing = this.jobs.get(id);
    if (!existing) return undefined;
    const updated = { ...existing, ...partial, updatedAt: Date.now() };
    this.jobs.set(id, updated);
    return updated;
  }

  getAll(): Job[] {
    return Array.from(this.jobs.values());
  }

  /**
   * Remove jobs older than retention period.
   */
  cleanup(): void {
    const cutoff = Date.now() - this.retentionMs;
    for (const [id, job] of this.jobs) {
      if (job.updatedAt < cutoff) {
        this.jobs.delete(id);
      }
    }
  }

  /**
   * Get count of jobs by status.
   */
  statusCounts(): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const job of this.jobs.values()) {
      counts[job.status] = (counts[job.status] || 0) + 1;
    }
    return counts;
  }
}

// Singleton job store
export const jobStore = new JobStore();

/**
 * Simulate async document parsing.
 * In production, this would call the actual parsing pipeline.
 * Returns a mock result for now (sync parse already works in the full pipeline).
 */
export async function processJob(job: Job): Promise<void> {
  // Simulate processing time (100-500ms)
  await new Promise(resolve => setTimeout(resolve, 100 + Math.random() * 400));

  // Mock result — in production, call the real parsing pipeline
  const mockResult = {
    document: {
      format: job.fileMime || 'unknown',
      pages: 1,
      tier_used: 'deterministic',
      confidence: 0.95,
    },
    elements: [],
    metadata: {},
  };

  jobStore.update(job.id, {
    status: 'completed',
    updatedAt: Date.now(),
    result: mockResult,
    actualCost: 0.004, // $0.004 USDC per page
  });
}

/**
 * Submit a new async job.
 */
export function submitJob(options: {
  file?: string;
  fileMime?: string;
  url?: string;
  webhookUrl?: string;
  estimatedCost?: number;
}): Job {
  const job: Job = {
    id: generateId(),
    status: 'pending',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    file: options.file,
    fileMime: options.fileMime,
    url: options.url,
    webhookUrl: options.webhookUrl,
    estimatedCost: options.estimatedCost,
  };

  jobStore.create(job);
  return job;
}

/**
 * Process all pending jobs sequentially.
 * Called by the async endpoint after job submission.
 */
export async function processQueue(): Promise<void> {
  const pendingJobs = jobStore
    .getAll()
    .filter(j => j.status === 'pending')
    .sort((a, b) => a.createdAt - b.createdAt);

  for (const job of pendingJobs) {
    // Mark as processing
    jobStore.update(job.id, { status: 'processing', updatedAt: Date.now() });

    try {
      await processJob(job);

      // Send webhook if configured and job completed successfully
      if (job.webhookUrl && job.status === 'completed') {
        await sendWebhook(job.webhookUrl, {
          jobId: job.id,
          status: 'completed',
          result: job.result,
        });
      }
    } catch (error) {
      jobStore.update(job.id, {
        status: 'failed',
        error: error instanceof Error ? error.message : 'Unknown error',
        updatedAt: Date.now(),
      });

      // Send failure webhook if configured
      if (job.webhookUrl) {
        await sendWebhook(job.webhookUrl, {
          jobId: job.id,
          status: 'failed',
          error: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    }
  }
}

/**
 * Send webhook callback to configured URL.
 */
export async function sendWebhook(url: string, payload: unknown): Promise<void> {
  try {
    await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Parsegate-Event': 'job.completed',
      },
      body: JSON.stringify(payload),
    });
  } catch (error) {
    // Log but don't fail the job if webhook fails
    console.error('Webhook delivery failed:', error);
  }
}
