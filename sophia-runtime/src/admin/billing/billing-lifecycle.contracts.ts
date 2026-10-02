import { z } from "zod";

export const hostedCheckoutSchema = z.object({
  requestId: z.string().uuid(),
  planVersionId: z.string().uuid(),
}).strict();

export const hostedActionSchema = z.object({ requestId: z.string().uuid() }).strict();

export const liveCustomerBindingSchema = z.object({
  requestId: z.string().uuid(),
  customerRef: z.string().regex(/^cus_[A-Za-z0-9]{8,236}$/),
}).strict();

export const deploymentMilestoneAcceptanceSchema = z.object({
  requestId: z.string().uuid(),
  evidenceRef: z.string().trim().min(1).max(240),
}).strict();
