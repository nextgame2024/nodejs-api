import { z } from "zod";

export const SOPHIA_RUNTIME_CONTRACT_VERSION = "2.0.0" as const;

const identifier = z.string().trim().min(1).max(160);
const isoDateTime = z.string().datetime({ offset: true });
const stringMap = z.record(z.string(), z.string());
const unknownMap = z.record(z.string(), z.unknown());

export const PipelineModeSchema = z.enum([
  "native-realtime",
  "orchestrated-text",
  "orchestrated-voice",
  "composite-realtime",
]);

export const ProviderEventProvenanceSchema = z.enum([
  "server-provider-connection",
  "verified-provider-webhook",
  "authenticated-user-action",
  "untrusted-client-bridge",
]);

export const V2CreateSessionRequestSchema = z.object({
  experienceId: identifier,
  deviceId: identifier,
  locale: z.string().trim().min(2).max(35).optional(),
  browserCapabilities: z.array(identifier).max(64).optional(),
}).strict();

export const V2BootstrapRequestSchema = V2CreateSessionRequestSchema;

export const V2BootstrapResponseSchema = z.object({
  bootstrapToken: z.string().min(32),
  expiresAt: isoDateTime,
}).strict();

export const ProviderBindingSchema = z.object({
  bindingId: identifier,
  providerId: identifier,
  adapterKey: identifier,
  capability: identifier,
  configurationVersion: identifier,
}).strict();

export const CapabilityBindingSchema = z.object({
  capabilityBindingId: identifier,
  capability: identifier,
  connectorKey: identifier,
  configurationVersion: identifier,
  resourceRef: identifier.optional(),
}).strict();

export const SessionPlanSchema = z.object({
  tenantId: identifier,
  agentId: identifier,
  experienceId: identifier,
  profileVersion: identifier,
  pipelineMode: PipelineModeSchema,
  capabilityOwners: stringMap,
  providerBindings: z.array(ProviderBindingSchema),
  capabilityBindings: z.array(CapabilityBindingSchema),
  policyVersion: identifier,
  toolCatalogVersion: identifier,
  languagePolicy: z.object({
    defaultLocale: identifier,
    allowedLocales: z.array(identifier).min(1),
  }).strict(),
  dataPolicy: z.object({
    policyRef: identifier,
    transcriptPersistence: z.enum(["disabled", "minimised", "enabled"]),
    audioPersistence: z.enum(["disabled", "enabled"]),
    processingRegions: z.array(identifier),
  }).strict(),
  usageLimits: z.object({
    maximumSessionSeconds: z.number().int().positive(),
    maximumToolCalls: z.number().int().nonnegative(),
  }).strict(),
  fallbackPolicy: z.object({
    mode: z.enum(["none", "pre-session-only", "explicit-reconnect"]),
    allowedProfileVersions: z.array(identifier),
  }).strict(),
}).strict();

export const ProviderCapabilityManifestSchema = z.object({
  providerId: identifier,
  adapterVersion: identifier,
  configurationSchema: unknownMap,
  capabilities: z.array(identifier).min(1),
  supportedModes: z.array(PipelineModeSchema).min(1),
  supportedInputModalities: z.array(identifier),
  supportedOutputModalities: z.array(identifier),
  languages: z.array(identifier),
  toolSchemaCapabilities: z.array(identifier),
  toolDeliveryModes: z.array(identifier),
  transportAdapters: z.array(identifier),
  interruptionCapabilities: z.array(identifier),
  inputAudioFormats: z.array(identifier),
  outputAudioFormats: z.array(identifier),
  usageDimensions: z.array(identifier),
  dataHandlingAssessmentRef: identifier,
  credentialRef: identifier,
  healthPolicy: z.object({
    checkKey: identifier,
    maximumAgeSeconds: z.number().int().positive(),
    failClosed: z.boolean(),
  }).strict(),
  compositeCapabilityOwners: stringMap.optional(),
  reasoningIsReplaceable: z.boolean().optional(),
  maxSessionDuration: z.number().int().positive().optional(),
  toolCatalogUpdateSupport: z.enum(["none", "provisioning-job"]).optional(),
  approvedModelAliases: z.array(identifier).optional(),
  concurrencyLimits: z.object({
    perTenant: z.number().int().positive().optional(),
    global: z.number().int().positive().optional(),
  }).strict().optional(),
}).strict();

export const ToolDefinitionSchema = z.object({
  toolId: identifier,
  version: identifier,
  description: z.string().trim().min(1).max(2000),
  inputSchema: unknownMap,
  outputSchema: unknownMap,
  requiredCapability: identifier,
  requiredScopes: z.array(identifier),
  riskClass: z.enum(["low", "medium", "high"]),
  sideEffectClass: z.enum([
    "read",
    "ephemeral-ui",
    "prepare-command",
    "business-mutation",
    "notification",
    "handoff",
  ]),
  confirmationPolicy: z.enum(["none", "explicit-user-review"]),
  timeoutMs: z.number().int().positive(),
  retryPolicy: z.enum(["none", "safe-read", "idempotent-command"]),
  idempotencyPolicy: z.enum(["not-applicable", "tool-call", "stable-command"]),
  presentationSchemaId: identifier.optional(),
  dataClassification: z.array(z.enum([
    "public",
    "internal",
    "personal",
    "sensitive",
  ])),
}).strict();

export const ToolInvocationSchema = z.object({
  toolId: identifier,
  arguments: unknownMap,
  context: z.object({
    tenantId: identifier,
    agentId: identifier,
    sessionId: identifier,
    deviceId: identifier,
    capabilityBindingId: identifier,
    actorRef: identifier,
    correlationId: identifier,
    toolCallId: identifier,
    providerCallId: identifier.optional(),
    providerEventProvenance: ProviderEventProvenanceSchema,
    policyVersion: identifier,
    deadline: isoDateTime,
  }).strict(),
}).strict();

export const ToolResultSchema = z.object({
  toolCallId: identifier,
  toolId: identifier,
  status: z.enum([
    "succeeded",
    "requires_confirmation",
    "accepted",
    "processing",
    "failed",
    "denied",
    "cancelled",
    "outcome_unknown",
  ]),
  capability: identifier,
  data: unknownMap.optional(),
  display: z.array(z.object({
    schemaId: identifier,
    data: unknownMap,
  }).strict()).optional(),
  spokenSummary: z.string().max(4000).optional(),
  sources: z.array(z.object({
    sourceRef: identifier,
    retrievedAt: isoDateTime,
    freshness: identifier,
    accessClassification: identifier,
  }).strict()).optional(),
  workflowRef: identifier.optional(),
  error: z.object({
    code: z.enum([
      "UNAUTHENTICATED",
      "FORBIDDEN",
      "CAPABILITY_DISABLED",
      "UNSUPPORTED_COMPOSITION",
      "INVALID_INPUT",
      "STALE_REVIEW",
      "CONFIRMATION_REQUIRED",
      "RESOURCE_UNAVAILABLE",
      "CONFLICT",
      "RATE_LIMITED",
      "PROVIDER_UNAVAILABLE",
      "OUTCOME_UNKNOWN",
    ]),
    safeMessage: z.string().max(1000),
    retryable: z.boolean(),
    correlationId: identifier,
  }).strict().optional(),
}).strict().superRefine((result, context) => {
  if (["failed", "denied", "outcome_unknown"].includes(result.status) && !result.error) {
    context.addIssue({
      code: "custom",
      message: "Terminal error results require an error object.",
      path: ["error"],
    });
  }
});

export const CanonicalConversationEventSchema = z.object({
  eventId: identifier,
  sessionId: identifier,
  sequence: z.number().int().nonnegative(),
  turnId: identifier.optional(),
  turnEpoch: z.number().int().nonnegative(),
  timestamp: isoDateTime,
  type: z.enum([
    "session.starting",
    "session.ready",
    "session.failed",
    "user.speech.started",
    "user.transcript.partial",
    "user.transcript.final",
    "assistant.text.delta",
    "assistant.audio.started",
    "assistant.audio.stopped",
    "turn.interrupted",
    "tool.requested",
    "tool.completed",
    "ui.updated",
    "session.closed",
  ]),
  payload: unknownMap,
}).strict();

export const ConnectionBootstrapEnvelopeSchema = z.object({
  bootstrapId: identifier,
  transportId: identifier,
  adapterKey: identifier,
  oneTime: z.literal(true),
  expiresAt: isoDateTime,
  payload: unknownMap,
}).strict();

export const SessionTransportDescriptorSchema = z.object({
  transportId: identifier,
  protocol: identifier,
  adapterKey: identifier,
  mediaMode: identifier,
  toolDeliveryMode: identifier,
  connectionBootstrapRef: identifier,
}).strict();

export const SessionDescriptorSchema = z.object({
  sessionId: identifier,
  experienceId: identifier,
  status: z.enum(["starting", "ready", "failed", "closed"]),
  configurationVersion: identifier,
  capabilities: z.array(identifier),
  transports: z.array(SessionTransportDescriptorSchema),
  expiresAt: isoDateTime,
  uiHints: z.object({
    themeKey: identifier.optional(),
    displayName: z.string().trim().min(1).max(120).optional(),
    enabledBlocks: z.array(identifier).optional(),
  }).strict(),
}).strict();

export const CreateSessionResponseSchema = z.object({
  descriptor: SessionDescriptorSchema,
  connectionBootstrap: ConnectionBootstrapEnvelopeSchema,
  sessionAccessToken: z.string().min(32),
  sessionAccessExpiresAt: isoDateTime,
}).strict();

export const SessionStatusResponseSchema = z.object({
  descriptor: SessionDescriptorSchema,
}).strict();

export const SophiaRuntimeV2Schemas = {
  V2CreateSessionRequest: V2CreateSessionRequestSchema,
  V2BootstrapRequest: V2BootstrapRequestSchema,
  V2BootstrapResponse: V2BootstrapResponseSchema,
  SessionPlan: SessionPlanSchema,
  ProviderCapabilityManifest: ProviderCapabilityManifestSchema,
  ToolDefinition: ToolDefinitionSchema,
  ToolInvocation: ToolInvocationSchema,
  ToolResult: ToolResultSchema,
  CanonicalConversationEvent: CanonicalConversationEventSchema,
  ConnectionBootstrapEnvelope: ConnectionBootstrapEnvelopeSchema,
  SessionDescriptor: SessionDescriptorSchema,
  CreateSessionResponse: CreateSessionResponseSchema,
  SessionStatusResponse: SessionStatusResponseSchema,
} as const;

export type V2CreateSessionRequest = z.infer<typeof V2CreateSessionRequestSchema>;
export type V2BootstrapRequest = z.infer<typeof V2BootstrapRequestSchema>;
export type V2BootstrapResponse = z.infer<typeof V2BootstrapResponseSchema>;
export type SessionPlan = z.infer<typeof SessionPlanSchema>;
export type ProviderCapabilityManifest = z.infer<typeof ProviderCapabilityManifestSchema>;
export type ToolDefinition = z.infer<typeof ToolDefinitionSchema>;
export type ToolInvocation = z.infer<typeof ToolInvocationSchema>;
export type ToolResult = z.infer<typeof ToolResultSchema>;
export type CanonicalConversationEvent = z.infer<typeof CanonicalConversationEventSchema>;
export type ConnectionBootstrapEnvelope = z.infer<typeof ConnectionBootstrapEnvelopeSchema>;
export type SessionDescriptor = z.infer<typeof SessionDescriptorSchema>;
export type CreateSessionResponse = z.infer<typeof CreateSessionResponseSchema>;
export type SessionStatusResponse = z.infer<typeof SessionStatusResponseSchema>;
