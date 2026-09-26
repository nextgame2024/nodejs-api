import { z } from "zod";
import { AGENT_PUBLICATION_CHECK_IDS } from "../agents/agent-publication-checks.js";

const uuid = z.string().uuid();
const key = z.string().trim().min(1).max(120).regex(/^[a-z0-9][a-z0-9.-]*$/);

export const CreateEvaluationDatasetSchema = z.object({
  datasetKey: key,
  displayName: z.string().trim().min(1).max(160),
}).strict();

export const EvaluationCaseSchema = z.object({
  caseKey: key,
  publicationCheckId: z.enum(AGENT_PUBLICATION_CHECK_IDS),
  expectedStatus: z.literal("passed"),
}).strict();

export const CreateEvaluationVersionSchema = z.object({
  cases: z.array(EvaluationCaseSchema).min(1).max(100),
}).strict().superRefine((value, context) => {
  const keys = value.cases.map((item) => item.caseKey);
  if (new Set(keys).size !== keys.length) context.addIssue({ code: "custom", path: ["cases"], message: "Case keys must be unique." });
});

export const BindEvaluationRequirementSchema = z.object({
  agentId: uuid,
  datasetVersionId: uuid,
  requiredForPublication: z.boolean(),
}).strict();

export const RunEvaluationSchema = z.object({
  agentId: uuid,
  datasetVersionId: uuid,
  target: z.discriminatedUnion("type", [
    z.object({ type: z.literal("draft") }).strict(),
    z.object({ type: z.literal("release"), releaseId: uuid }).strict(),
  ]),
}).strict();

export const EVALUATOR_KEY = "deterministic-publication-checks" as const;
export const EVALUATOR_VERSION = 1 as const;
export const EVIDENCE_MODE = "deterministic" as const;

export type EvaluationCase = z.infer<typeof EvaluationCaseSchema>;
