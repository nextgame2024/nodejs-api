import { z } from "zod";

const uuid = z.string().uuid();
const identifier = z.string().trim().min(1).max(160);

export const PLATFORM_SAFETY_POLICY_VERSION = "sophia-safety-1" as const;

export const InstructionRevisionInputSchema = z.object({
  content: z.string().trim().min(1).max(50_000),
  tone: z.string().trim().max(500).optional(),
  greeting: z.string().trim().max(2_000).optional(),
  variableSchema: z.object({
    type: z.literal("object"),
    properties: z.record(z.string().regex(/^[a-z][a-zA-Z0-9_]{0,63}$/), z.object({
      type: z.enum(["string", "number", "boolean"]),
      description: z.string().max(500).optional(),
    }).strict()),
    additionalProperties: z.literal(false),
  }).strict(),
}).strict().superRefine((value, context) => {
  const declared = new Set(Object.keys(value.variableSchema.properties));
  for (const [field, text] of [["content", value.content], ["tone", value.tone], ["greeting", value.greeting]] as const) {
    for (const match of (text ?? "").matchAll(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g)) {
      if (!declared.has(match[1])) {
        context.addIssue({ code: "custom", path: [field], message: `Unsupported instruction variable: ${match[1]}` });
      }
    }
  }
});

export const AgentDraftConfigurationSchema = z.object({
  displayName: z.string().trim().min(1).max(120),
  defaultLocale: identifier,
  allowedLocales: z.array(identifier).min(1).max(20),
  instructionRevisionId: uuid,
  businessProfileVersionId: uuid,
  experienceProfileVersionIds: z.array(uuid).min(1).max(20),
  capabilityBindingIds: z.array(uuid).max(100),
  knowledgeRevisionIds: z.array(uuid).max(100),
  workflowVersionIds: z.array(uuid).max(100),
  escalationPolicyVersionId: uuid.optional(),
}).strict();

export const UpdateAgentDraftSchema = z.object({
  expectedRevision: z.number().int().positive(),
  configuration: AgentDraftConfigurationSchema,
}).strict();

export const CreateAgentSchema = z.object({
  agentKey: identifier.regex(/^[a-z0-9][a-z0-9-]{0,79}$/),
  configuration: AgentDraftConfigurationSchema,
}).strict();

export const CreateInstructionSetSchema = z.object({
  instructionKey: identifier.regex(/^[a-z0-9][a-z0-9-]{0,79}$/),
}).strict();

export const PublishAgentDraftSchema = z.object({
  expectedRevision: z.number().int().positive(),
  releaseNotes: z.string().trim().max(2_000).optional(),
}).strict();

const previewScalar = z.union([
  z.string().max(1_000),
  z.number().finite(),
  z.boolean(),
]);

export const PreviewAgentDraftSchema = z.object({
  variables: z.record(z.string().regex(/^[a-z][a-zA-Z0-9_]{0,63}$/), previewScalar),
}).strict().refine((value) => Object.keys(value.variables).length <= 50, {
  message: "At most 50 preview variables are supported.",
  path: ["variables"],
});

export type AgentDraftConfiguration = z.infer<typeof AgentDraftConfigurationSchema>;

export type PublicationCheck = {
  checkId: string;
  status: "passed" | "failed" | "blocked";
  message: string;
};
