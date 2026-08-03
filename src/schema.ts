import { z } from 'zod';

export const ParseRequestSchema = z.object({
  file: z.string().optional(), // base64 or multipart
  url: z.string().url().optional(), // presigned URL
});

export const ParseResponseSchema = z.object({
  document: z.object({
    format: z.string(),
    pages: z.number(),
    tier_used: z.enum(['deterministic', 'vlm_assisted', 'hybrid']),
    confidence: z.number(),
  }),
  elements: z.array(z.any()),
  metadata: z.record(z.union([z.string(), z.number()])),
});

export const PricingResponseSchema = z.object({
  'per-page': z.object({
    min: z.number(),
    max: z.number(),
    currency: z.string(),
  }),
  'per-100kb': z.object({
    min: z.number(),
    max: z.number(),
    currency: z.string(),
  }),
  note: z.string(),
});
