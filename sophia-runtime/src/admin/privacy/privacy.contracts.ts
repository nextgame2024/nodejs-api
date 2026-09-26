import { z } from "zod";

const uuid = z.string().uuid();
const key = z.string().trim().min(1).max(120).regex(/^[a-z0-9][a-z0-9.-]*$/);
const reference = z.string().trim().min(3).max(240);
const digest = z.string().regex(/^[a-f0-9]{64}$/);

export const CreatePrivacyNoticeSchema = z.object({
  noticeKey: key,
  purposeManifest: z.object({
    recording: z.boolean(),
    transcription: z.boolean(),
    marketing: z.boolean(),
    aiIdentityDisclosed: z.boolean(),
  }).strict(),
  contentDigest: digest,
}).strict();

export const ApprovePrivacyNoticeSchema = z.object({
  counselReference: reference,
}).strict();

export const CreateRetentionPolicySchema = z.object({
  datasetKey: z.enum([
    "session_content", "review_payloads", "generated_personal_documents",
    "provider_data", "backups", "audit_evidence",
  ]),
  retentionDays: z.number().int().positive().max(36_500),
  disposalMethod: z.enum(["delete", "deidentify", "provider_request", "backup_expiry"]),
  policyReference: reference,
}).strict();

export const UpsertDataFlowSchema = z.object({
  flowKey: key,
  ownerKey: key,
  capability: key,
  dataCategories: z.array(key).min(1).max(32),
  processingJurisdictions: z.array(key).max(32),
  storageJurisdictions: z.array(key).max(32),
  retentionControl: z.enum(["unverified", "provider_configured", "contractual", "zero_data_retention"]),
  deletionControl: z.enum(["unverified", "manual", "api_verified", "not_stored"]),
  status: z.enum(["draft", "blocked"]).default("draft"),
}).strict();

export const ApproveDataFlowSchema = z.object({
  assessmentReference: reference,
  failoverEligible: z.boolean(),
}).strict();

export const UpdateLegalReviewSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("required") }).strict(),
  z.object({ status: z.literal("pending"), reviewReference: reference.optional() }).strict(),
  z.object({
    status: z.literal("approved"),
    reviewReference: reference,
    reviewerIdentity: reference,
  }).strict(),
]);

export const CreateSubjectRequestSchema = z.object({
  requestType: z.enum(["access", "deletion"]),
  subjectReference: z.string().trim().min(16).max(240)
    .regex(/^[A-Za-z0-9_-]+$/, "Use an opaque subject reference, not an email address or name."),
  sessionIds: z.array(uuid).min(1).max(50),
}).strict();

export const VerifySubjectRequestSchema = z.discriminatedUnion("verificationStatus", [
  z.object({
    verificationStatus: z.literal("verified"),
    verificationMethod: z.enum(["authenticated_customer", "verified_operator", "documented_manual_check"]),
    verificationEvidenceReference: reference,
  }).strict(),
  z.object({
    verificationStatus: z.literal("rejected"),
    verificationMethod: z.enum(["authenticated_customer", "verified_operator", "documented_manual_check"]),
    verificationEvidenceReference: reference,
  }).strict(),
]);

export const CreateLegalHoldSchema = z.object({
  subjectReference: z.string().trim().min(16).max(240).regex(/^[A-Za-z0-9_-]+$/),
  reasonReference: reference,
}).strict();

export const ExternalTargetEvidenceSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.enum(["completed", "not_applicable"]),
    evidenceReference: reference,
    evidenceDigest: digest,
    detail: z.string().trim().min(1).max(500).optional(),
  }).strict(),
  z.object({
    status: z.literal("blocked"),
    evidenceReference: reference.optional(),
    evidenceDigest: digest.optional(),
    detail: z.string().trim().min(1).max(500),
  }).strict(),
]);

export const RetentionRunSchema = z.object({
  privacyRetentionPolicyId: uuid,
  execute: z.boolean().default(false),
  limit: z.number().int().min(1).max(100).default(100),
}).strict();
