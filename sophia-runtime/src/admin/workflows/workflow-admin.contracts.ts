import { z } from "zod";

const key = z.string().trim().regex(/^[a-z][a-z0-9.-]{1,159}$/);
const uuid = z.string().uuid();

export const CreateWorkflowSchema = z.object({
  workflowKey: key,
  templateKey: key,
  configuration: z.record(z.string(), z.unknown()),
}).strict();

export const CreateWorkflowVersionSchema = z.object({
  configuration: z.record(z.string(), z.unknown()),
}).strict();

export const PinWorkflowRunSchema = z.object({
  workflowVersionId: uuid,
  capabilityBindingId: uuid,
  externalRunRef: z.string().trim().min(1).max(500),
  sourceSessionId: uuid.optional(),
}).strict();

export const RetryWorkflowRunSchema = z.object({
  idempotencyKey: z.string().trim().min(8).max(200),
}).strict();
