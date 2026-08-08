/**
 * Job Store — In-memory async job store for Parsegate (P008).
 *
 * Tracks async parse jobs with states, callbacks, and cleanup.
 * Designed for Workers compatibility: no persistent storage.
 * For multi-worker deployments, replace with an external store (Redis, DB).
 */

// ─────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────

export type JobStatus = 'pending' | 'processing' | 'completed' | 'failed';

export interface JobError {
  code: string;
  message: string;
}

export interface JobResult {
  triage: unknown;
  document: unknown;
  payment: unknown;
}

/** A single async parse job. */
export interface AsyncJob {
  id: string;
  status: JobStatus;
  createdAt: number;
  startedAt?: number;
  completedAt?: number;
  webhookUrl?: string;
  webhookAttempts: number;
  maxWebhookRetries: number;
  error?: JobError;
  result?: JobResult;
  fileName: string;
  fileSize: number;
  format?: string;
}

// ─────────────────────────────────────────────────────────────────
// Job Store
// ─────────────────────────────────────────────────────────────────

class JobStore {
  private jobs = new Map<string, AsyncJob>();

  /** Create a new job. */
  create(fileName: string, fileSize: number): AsyncJob {
    const id = crypto.randomUUID();
    const job: AsyncJob = {
      id,
      status: 'pending',
      createdAt: Date.now(),
      fileName,
      fileSize,
      webhookAttempts: 0,
      maxWebhookRetries: 3,
    };
    this.jobs.set(id, job);
    return job;
  }

  /** Get a job by ID. */
  get(id: string): AsyncJob | undefined {
    return this.jobs.get(id);
  }

  /** Transition a job to processing. */
  start(id: string): AsyncJob | null {
    const job = this.jobs.get(id);
    if (!job || job.status !== 'pending') return null;
    job.status = 'processing';
    job.startedAt = Date.now();
    return job;
  }

  /** Mark a job as completed. */
  complete(id: string, result: JobResult): AsyncJob | null {
    const job = this.jobs.get(id);
    if (!job || job.status !== 'processing') return null;
    job.status = 'completed';
    job.result = result;
    job.completedAt = Date.now();
    return job;
  }

  /** Mark a job as failed. */
  fail(id: string, error: JobError): AsyncJob | null {
    const job = this.jobs.get(id);
    if (!job || job.status !== 'processing') return null;
    job.status = 'failed';
    job.error = error;
    job.completedAt = Date.now();
    return job;
  }

  /** Get status-only snapshot (lightweight, for polling). */
  getStatus(id: string): { id: string; status: JobStatus } | null {
    const job = this.jobs.get(id);
    if (!job) return null;
    return { id: job.id, status: job.status };
  }

  /** Count jobs by status. */
  stats(): { total: number; pending: number; processing: number; completed: number; failed: number } {
    const counts = { total: 0, pending: 0, processing: 0, completed: 0, failed: 0 };
    for (const job of this.jobs.values()) {
      counts.total++;
      counts[job.status]++;
    }
    return counts;
  }

  /** Delete a job by ID. */
  delete(id: string): void {
    this.jobs.delete(id);
  }

  /** Clean up completed/failed jobs older than maxAgeMs. */
  cleanup(maxAgeMs: number): number {
    let cleaned = 0;
    const cutoff = Date.now() - maxAgeMs;
    for (const [id, job] of this.jobs.entries()) {
      if ((job.status === 'completed' || job.status === 'failed') && job.completedAt! < cutoff) {
        this.jobs.delete(id);
        cleaned++;
      }
    }
    return cleaned;
  }

  get size(): number {
    return this.jobs.size;
  }
}

// ─────────────────────────────────────────────────────────────────
// Webhook delivery
// ─────────────────────────────────────────────────────────────────

/**
 * Deliver a webhook to a URL.
 * Returns true on success (2xx), false on failure.
 */
export async function deliverWebhook(
  url: string,
  jobId: string,
  status: JobStatus,
  result?: JobResult,
  error?: JobError,
): Promise<boolean> {
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Parsegate-Job-Id': jobId,
        'X-Parsegate-Event': 'job.completed',
      },
      body: JSON.stringify({
        event: 'job.completed',
        jobId,
        status,
        completedAt: new Date().toISOString(),
        result: status === 'completed' ? result : undefined,
        error: status === 'failed' ? error : undefined,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * Try delivering webhook for a completed job.
 * Returns true if fully delivered (or no webhook), false if retry needed.
 */
export async function tryWebhook(job: AsyncJob): Promise<boolean> {
  if (!job.webhookUrl || !job.result) return true;
  if (job.webhookAttempts >= job.maxWebhookRetries) return true;

  const success = await deliverWebhook(
    job.webhookUrl,
    job.id,
    job.status,
    job.result,
    job.error,
  );

  if (success) {
    job.webhookAttempts = job.maxWebhookRetries;
  } else {
    job.webhookAttempts++;
  }

  return success;
}

// ─────────────────────────────────────────────────────────────────
// Singleton instance
// ─────────────────────────────────────────────────────────────────

export const jobStore = new JobStore();
