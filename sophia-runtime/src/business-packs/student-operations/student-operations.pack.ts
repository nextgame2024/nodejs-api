import { z } from "zod";

export const StudentOperationsPackContractSchema = z.object({
  packId: z.literal("student-operations"),
  version: z.string().regex(/^\d+\.\d+\.\d+$/),
  enabledByDefault: z.literal(false),
  workspaceRoutes: z.tuple([
    z.literal("dashboard"),
    z.literal("students"),
    z.literal("student-case"),
    z.literal("payments-controls"),
    z.literal("sophia-assistant"),
  ]),
  externalIntegrations: z.object({
    xeroTrust: z.literal("not-configured"),
    xeroPty: z.literal("not-configured"),
  }).strict(),
  documentStorage: z.literal("not-configured"),
  assistantTools: z.literal("not-configured"),
  financialExecution: z.literal("disabled"),
}).strict();

export type StudentOperationsPackContract = z.infer<
  typeof StudentOperationsPackContractSchema
>;

export const STUDENT_OPERATIONS_PACK_CONTRACT =
  StudentOperationsPackContractSchema.parse({
    packId: "student-operations",
    version: "0.1.0",
    enabledByDefault: false,
    workspaceRoutes: [
      "dashboard",
      "students",
      "student-case",
      "payments-controls",
      "sophia-assistant",
    ],
    externalIntegrations: {
      xeroTrust: "not-configured",
      xeroPty: "not-configured",
    },
    documentStorage: "not-configured",
    assistantTools: "not-configured",
    financialExecution: "disabled",
  });
