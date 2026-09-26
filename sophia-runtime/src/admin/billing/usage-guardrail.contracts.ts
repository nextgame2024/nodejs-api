import { z } from "zod";

export const UsageGuardrailUpdateSchema = z.object({
  expectedRevision: z.number().int().nonnegative(),
  maxConcurrentSessions: z.number().int().positive().nullable(),
  maxToolCallsPerMinute: z.number().int().positive().nullable(),
  providerCostAlert: z.object({
    thresholdMicrounits: z.string().regex(/^[1-9]\d*$/),
    currency: z.string().regex(/^[A-Z]{3}$/),
  }).strict().nullable(),
}).strict();
