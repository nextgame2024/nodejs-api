import { z } from "zod";

const key = z.string().trim().regex(/^[a-z][a-z0-9.-]{1,159}$/);
const uuid = z.string().uuid();
export const EscalationReasonCodeSchema = z.enum([
  "user_requested_human", "safety_concern", "capability_unavailable", "operation_failed", "other",
]);
export const EscalationPrioritySchema = z.enum(["low", "normal", "high", "urgent"]);

export const CreateEscalationDestinationSchema = z.object({
  destinationKey: key,
  displayName: z.string().trim().min(1).max(160),
  channel: z.enum(["operations_inbox", "callback", "notification", "live_transfer"]),
  connectorBindingId: uuid.optional(),
}).strict();

export const UpdateEscalationDestinationSchema = z.object({
  displayName: z.string().trim().min(1).max(160),
  status: z.enum(["active", "inactive"]),
  expectedRevision: z.number().int().positive(),
}).strict();

const escalationRule = z.object({
  ruleKey: key,
  reasonCodes: z.array(EscalationReasonCodeSchema).min(1).max(5),
  destinationId: uuid,
  priority: EscalationPrioritySchema,
  responseTargetMinutes: z.number().int().min(1).max(10_080),
}).strict();

export const EscalationPolicyConfigurationSchema = z.object({
  defaultDestinationId: uuid,
  rules: z.array(escalationRule).max(25),
  contextFields: z.array(z.enum(["reason", "summary", "contactPreference"])).min(2).max(3),
}).strict().superRefine((value, context) => {
  const keys = value.rules.map((rule) => rule.ruleKey);
  if (new Set(keys).size !== keys.length) context.addIssue({ code: "custom", message: "Escalation rule keys must be unique." });
});

export const CreateEscalationPolicySchema = z.object({
  policyKey: key,
  configuration: EscalationPolicyConfigurationSchema,
}).strict();

export const CreateEscalationPolicyVersionSchema = z.object({
  configuration: EscalationPolicyConfigurationSchema,
}).strict();

export const CreateEscalationCaseSchema = z.object({
  escalationPolicyVersionId: uuid,
  sourceSessionId: uuid.optional(),
  reasonCode: EscalationReasonCodeSchema,
  summary: z.string().trim().min(1).max(2_000),
  contactPreference: z.string().trim().min(1).max(240).optional(),
}).strict();

export const AssignEscalationCaseSchema = z.object({
  assignedToIdentity: z.string().trim().min(1).max(240),
  expectedRevision: z.number().int().positive(),
}).strict();

export const CaseRevisionSchema = z.object({ expectedRevision: z.number().int().positive() }).strict();

export const ResolveEscalationCaseSchema = CaseRevisionSchema.extend({
  resolutionCode: key,
  resolutionNote: z.string().trim().min(1).max(2_000),
}).strict();
