/**
 * Shared types for async job system and discover endpoint.
 */

export type JobStatus = 'pending' | 'processing' | 'completed' | 'failed';

export interface Job {
  id: string;
  status: JobStatus;
  createdAt: number;
  updatedAt: number;
  // Input
  file?: string; // base64-encoded file data
  fileMime?: string;
  url?: string;
  // Processing
  format?: string;
  pages?: number;
  tierUsed?: string;
  // Output
  elements?: unknown[];
  metadata?: Record<string, string | number>;
  result?: Record<string, unknown>;
  // Errors
  error?: string;
  // Cost (x402)
  estimatedCost?: number;
  actualCost?: number;
  x402PaymentStatus?: 'pending' | 'paid' | 'failed';
  // Webhook
  webhookUrl?: string;
  webhookAttempted?: boolean;
  webhookAttempts?: number;
}

export interface JobResponse {
  jobId: string;
  status: JobStatus;
  createdAt: string;
  updatedAt?: string;
  result?: Record<string, unknown>;
  error?: string;
}

export interface DiscoverResponse {
  service: string;
  version: string;
  description: string;
  endpoints: {
    sync: string;
    async: string;
    poll: string;
    discover: string;
  };
  tiers: {
    free: {
      callsPerDay: number;
      walletAddress?: string;
      note: string;
    };
    paid: {
      currency: string;
      perPage: { min: number; max: number };
      per100kb: { min: number; max: number };
      x402: string;
    };
  };
  features: string[];
}

export interface RateLimitInfo {
  walletAddress: string;
  callsToday: number;
  limitPerDay: number;
  remaining: number;
  resetAt: string; // ISO 8601 midnight UTC
}
