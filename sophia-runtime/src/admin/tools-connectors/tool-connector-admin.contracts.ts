import { z } from "zod";

const key = z.string().trim().regex(/^[a-z][a-z0-9.-]{1,159}$/);
const scope = z.string().trim().regex(/^[a-z][a-z0-9:-]{1,159}$/);

export const CreateConnectorBindingSchema = z.object({
  connectorKey: key,
  externalAccountId: z.string().uuid(),
  requestedScopes: z.array(scope).min(1).max(32),
}).strict();

export const RevisionCommandSchema = z.object({
  expectedRevision: z.number().int().positive(),
}).strict();

export const PutCapabilityBindingSchema = z.object({
  connectorBindingId: z.string().uuid(),
  enabled: z.boolean(),
  expectedRevision: z.number().int().positive().nullable().optional(),
}).strict();
