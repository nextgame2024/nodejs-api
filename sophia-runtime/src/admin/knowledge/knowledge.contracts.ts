import { z } from "zod";

const key = z.string().trim().min(1).max(120).regex(/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/);
const text = z.string().trim().min(1).max(262_144)
  .refine((value) => Buffer.byteLength(value, "utf8") <= 262_144, {
    message: "Knowledge text exceeds the 256 KiB UTF-8 limit.",
  })
  .refine((value) => !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value), {
    message: "Knowledge text contains unsupported control characters.",
  });
const opaqueRef = z.string().trim().min(1).max(512).refine((value) => !/^[a-z][a-z0-9+.-]*:\/\//i.test(value), {
  message: "Connector object references must be opaque identifiers, not URLs.",
});

export const CreateKnowledgeSourceSchema = z.object({
  sourceKey: key,
  title: z.string().trim().min(1).max(300),
  sourceType: z.enum(["managed_text", "connector_reference"]),
}).strict();

export const CreateKnowledgeRevisionSchema = z.discriminatedUnion("sourceType", [
  z.object({ sourceType: z.literal("managed_text"), mediaType: z.enum(["text/plain", "text/markdown"]), contentText: text }).strict(),
  z.object({ sourceType: z.literal("connector_reference"), connectorBindingId: z.string().uuid(), connectorObjectRef: opaqueRef }).strict(),
]);

export const IngestKnowledgeRevisionSchema = z.object({
  idempotencyKey: z.string().trim().min(8).max(160),
}).strict();

export const PublishKnowledgeRevisionSchema = z.object({
  capabilityBindingIds: z.array(z.string().uuid()).min(1).max(100),
}).strict();

export const PreviewKnowledgeSchema = z.object({
  snapshotId: z.string().uuid(),
  capabilityBindingId: z.string().uuid(),
  query: z.string().trim().min(1).max(500),
  limit: z.number().int().min(1).max(20).default(10),
}).strict();

export const InitiateKnowledgeFileSchema = z.object({
  filename: z.string().trim().min(1).max(180)
    .refine((value) => !/[\\/\u0000-\u001f\u007f]/.test(value), { message: "Filename contains unsupported characters." })
    .refine((value) => /\.(?:txt|md)$/i.test(value), { message: "Only .txt and .md files are supported." }),
  mediaType: z.enum(["text/plain", "text/markdown"]),
  contentLength: z.number().int().min(1).max(1_048_576),
  checksumSha256Base64: z.string().regex(/^[A-Za-z0-9+/]{43}=$/),
  idempotencyKey: z.string().trim().min(8).max(160),
}).strict().superRefine((value, context) => {
  const expected = value.filename.toLowerCase().endsWith(".md") ? "text/markdown" : "text/plain";
  if (value.mediaType !== expected) context.addIssue({ code: "custom", path: ["mediaType"], message: "File extension and media type do not match." });
});
