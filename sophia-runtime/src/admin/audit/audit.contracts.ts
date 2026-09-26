import { z } from "zod";

const text = z.string().trim().min(1).max(160);
export const AuditFiltersSchema = z.object({
  eventType: text.optional(),
  outcome: z.enum(["allowed", "denied", "failed"]).optional(),
  identityUserId: text.optional(),
  resourceType: text.optional(),
  correlationId: text.optional(),
  from: z.iso.datetime({ offset: true }).optional(),
  to: z.iso.datetime({ offset: true }).optional(),
}).strict().refine((value) => !value.from || !value.to || Date.parse(value.from) <= Date.parse(value.to), {
  message: "Audit date range is invalid.", path: ["from"],
});

export const AuditListQuerySchema = AuditFiltersSchema.extend({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  before: z.iso.datetime({ offset: true }).optional(),
  beforeId: z.string().uuid().optional(),
}).strict().refine((value) => Boolean(value.before) === Boolean(value.beforeId), {
  message: "Both before and beforeId are required for cursor pagination.", path: ["before"],
});

export const CreateAuditExportSchema = z.object({
  format: z.literal("json"),
  filters: AuditFiltersSchema.default({}),
  maxRows: z.number().int().min(1).max(5000).default(1000),
}).strict();
