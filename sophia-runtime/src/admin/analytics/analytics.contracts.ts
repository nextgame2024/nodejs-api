import { z } from "zod";

const timestamp = z.iso.datetime({ offset: true });

export const AnalyticsQuerySchema = z.object({
  from: timestamp.optional(),
  to: timestamp.optional(),
  agentId: z.string().uuid().optional(),
  agentReleaseId: z.string().uuid().optional(),
  channel: z.enum(["voice", "avatar", "unknown"]).optional(),
}).strict().refine((value) => !value.from || !value.to || Date.parse(value.from) <= Date.parse(value.to), {
  message: "Analytics date range is invalid.", path: ["from"],
});

export type AnalyticsQuery = z.infer<typeof AnalyticsQuerySchema>;

export const CreateAnalyticsExportSchema = z.object({
  format: z.literal("json"),
  filters: AnalyticsQuerySchema.default({}),
  maxPoints: z.number().int().min(1).max(5000).default(1000),
}).strict();
