import { z } from "zod";
import { AdminRoleKeySchema } from "../contracts/admin-contracts.js";

const boundedText = z.string().trim().min(1).max(200);

export const OrganisationSettingsUpdateSchema = z.object({
  expectedRevision: z.number().int().positive(),
  name: boundedText.optional(),
  timezone: z.string().trim().min(1).max(80).optional(),
  defaultLocale: z.string().trim().min(2).max(35).optional(),
  branding: z.object({
    displayName: boundedText.optional(),
    primaryColour: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  }).strict().optional(),
}).strict().refine((value) => Object.keys(value).some((key) => key !== "expectedRevision"), {
  message: "At least one organisation setting is required.",
});

export const OrganisationSuspensionSchema = z.object({
  expectedRevision: z.number().int().positive(),
  reason: z.string().trim().min(3).max(1_000),
}).strict();

export const InvitationIssueSchema = z.object({
  email: z.string().trim().email().max(320).transform((value) => value.toLowerCase()),
  role: AdminRoleKeySchema,
  expiresInHours: z.number().int().min(1).max(168).default(48),
  deliveryMode: z.literal("dry-run"),
}).strict();

export const InvitationRedeemSchema = z.object({
  token: z.string().min(32).max(512),
}).strict();

export const RevisionCheckSchema = z.object({ expectedRevision: z.number().int().positive() }).strict();

export const MembershipUpdateSchema = z.object({
  expectedRevision: z.number().int().positive(),
  role: AdminRoleKeySchema.optional(),
  status: z.enum(["active", "suspended", "revoked"]).optional(),
}).strict().refine((value) => value.role !== undefined || value.status !== undefined, {
  message: "A role or membership status change is required.",
});
