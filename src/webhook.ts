/**
 * Webhook callback endpoint for Parsegate.
 * Receives webhook events from external systems (optional).
 * Also triggers outgoing webhooks when jobs complete.
 */

import { Hono } from 'hono';
import { z } from 'zod';
import { jobStore } from './async';

const WebhookEventSchema = z.object({
  jobId: z.string(),
  status: z.enum(['completed', 'failed', 'processing']),
  result: z.record(z.unknown()).optional(),
  error: z.string().optional(),
});

export const webhookApp = new Hono();

// Webhook receiver — accepts status updates from external systems
webhookApp.post('/v1/webhooks/receive', async (c) => {
  try {
    const body = await c.req.json();
    const validated = WebhookEventSchema.parse(body);

    // Update job status if we have this job
    if (validated.jobId) {
      const job = jobStore.get(validated.jobId);
      if (job) {
        jobStore.update(job.id, {
          status: validated.status,
          updatedAt: Date.now(),
          result: validated.result,
          error: validated.error,
        });
      }
    }

    return c.json({ received: true, jobId: validated.jobId });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return c.json({ error: 'Invalid webhook payload', details: error.errors }, 400);
    }
    return c.json({ error: 'Internal server error' }, 500);
  }
});

// Webhook status — check if a webhook was sent for a job
webhookApp.get('/v1/webhooks/status/:jobId', (c) => {
  const jobId = c.req.param('jobId');
  const job = jobStore.get(jobId);

  if (!job) {
    return c.json({ error: 'Job not found' }, 404);
  }

  return c.json({
    jobId,
    webhookUrl: job.webhookUrl,
    webhookAttempted: job.webhookAttempted,
    webhookAttempts: job.webhookAttempts,
    status: job.status,
  });
});
