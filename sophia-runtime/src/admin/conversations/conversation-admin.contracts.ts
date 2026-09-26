import { z } from "zod";

const uuid = z.string().uuid();
const timestamp = z.iso.datetime({ offset: true });

export const ConversationFiltersSchema = z.object({
  from: timestamp.optional(),
  to: timestamp.optional(),
  agentId: uuid.optional(),
  agentReleaseId: uuid.optional(),
  channel: z.enum(["voice", "avatar", "unknown"]).optional(),
  outcome: z.enum(["in_progress", "completed", "failed"]).optional(),
  escalationStatus: z.enum(["none", "open", "assigned", "in_progress", "resolved"]).optional(),
}).strict().refine((value) => !value.from || !value.to || Date.parse(value.from) <= Date.parse(value.to), {
  message: "Conversation date range is invalid.", path: ["from"],
});

export const ConversationListQuerySchema = ConversationFiltersSchema.extend({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  before: timestamp.optional(),
  beforeId: uuid.optional(),
}).strict().refine((value) => Boolean(value.before) === Boolean(value.beforeId), {
  message: "Both before and beforeId are required for cursor pagination.", path: ["before"],
});

export const CreateConversationNoteSchema = z.object({
  note: z.string().trim().min(1).max(4000),
}).strict();

export const CreateConversationExportSchema = z.object({
  format: z.literal("json"),
  scope: z.enum(["metadata", "content"]),
  maxItems: z.number().int().min(1).max(5000).default(1000),
}).strict();
