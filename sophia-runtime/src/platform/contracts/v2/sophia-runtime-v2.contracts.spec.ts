import { describe, expect, it } from "@jest/globals";
import {
  CreateSessionResponseSchema,
  ProviderCapabilityManifestSchema,
  SessionPlanSchema,
  SessionStatusResponseSchema,
  ToolDefinitionSchema,
  ToolInvocationSchema,
  ToolResultSchema,
  V2CreateSessionRequestSchema,
} from "./sophia-runtime-v2.contracts.js";
import {
  translateV1CreatedSession,
  translateV1CreateRequest,
  translateV1SessionStatus,
} from "../../../compatibility/v1/v1-to-v2-session.adapter.js";

const timestamp = "2026-09-23T00:00:00.000Z";
const context = {
  deviceId: "device-demo",
  experienceId: "essential",
  configurationVersion: "profile-1",
  capabilities: ["catalog.search"],
  sessionExpiresAt: timestamp,
};

describe("Sophia Runtime v2 contracts", () => {
  it.each([
    "tenantId",
    "companyId",
    "providerId",
    "aiProvider",
    "avatarProvider",
    "modelName",
    "modelId",
    "voiceName",
    "providerApiKey",
    "personaId",
    "replicaId",
    "toolAllowlist",
  ])("rejects the forbidden public session field %s", (field) => {
    expect(() => V2CreateSessionRequestSchema.parse({
      experienceId: "essential",
      deviceId: "device-demo",
      [field]: "browser-controlled",
    })).toThrow();
  });

  it("translates v1 input without copying browser authority or provider choices", () => {
    const translated = translateV1CreateRequest({
      experience: "professional",
      deviceId: "untrusted-device",
      customerId: "untrusted-tenant",
      companyId: "untrusted-company",
      aiProvider: "untrusted-provider",
      avatarProvider: "untrusted-avatar",
    }, context);

    expect(translated).toEqual({
      experienceId: "professional",
      deviceId: "device-demo",
    });
  });

  it("keeps one-time native details out of the safe session status", () => {
    const legacy = {
      session: { sessionId: "session-1", status: "active" },
      ai: { provider: "example-ai", clientSecret: "one-time-ai-secret" },
      avatar: { provider: "example-avatar", sessionToken: "one-time-avatar-secret" },
      sessionAccessToken: "a".repeat(32),
      sessionAccessExpiresAt: timestamp,
    };
    const created = translateV1CreatedSession(legacy, context);
    const status = translateV1SessionStatus(legacy, context);

    expect(CreateSessionResponseSchema.parse(created).connectionBootstrap.payload)
      .toEqual(expect.objectContaining({ ai: legacy.ai, avatar: legacy.avatar }));
    expect(SessionStatusResponseSchema.parse(status)).toEqual({ descriptor: created.descriptor });
    expect(JSON.stringify(status)).not.toContain("secret");
    expect(() => SessionStatusResponseSchema.parse({
      ...status,
      connectionBootstrap: created.connectionBootstrap,
    })).toThrow();
  });

  it("validates provider-neutral plans, manifests and tool contracts", () => {
    expect(SessionPlanSchema.parse({
      tenantId: "tenant-1",
      agentId: "agent-1",
      experienceId: "essential",
      profileVersion: "profile-1",
      pipelineMode: "native-realtime",
      capabilityOwners: { reasoning: "binding-1" },
      providerBindings: [{
        bindingId: "binding-1",
        providerId: "provider-example",
        adapterKey: "adapter-example",
        capability: "reasoning",
        configurationVersion: "1",
      }],
      capabilityBindings: [],
      policyVersion: "policy-1",
      toolCatalogVersion: "tools-1",
      languagePolicy: { defaultLocale: "en-AU", allowedLocales: ["en-AU"] },
      dataPolicy: {
        policyRef: "data-1",
        transcriptPersistence: "disabled",
        audioPersistence: "disabled",
        processingRegions: ["AU"],
      },
      usageLimits: { maximumSessionSeconds: 900, maximumToolCalls: 30 },
      fallbackPolicy: { mode: "none", allowedProfileVersions: [] },
    }).pipelineMode).toBe("native-realtime");

    expect(ProviderCapabilityManifestSchema.parse({
      providerId: "provider-example",
      adapterVersion: "1",
      configurationSchema: {},
      capabilities: ["reasoning"],
      supportedModes: ["native-realtime"],
      supportedInputModalities: ["audio"],
      supportedOutputModalities: ["audio"],
      languages: ["en-AU"],
      toolSchemaCapabilities: ["object"],
      toolDeliveryModes: ["server-sideband"],
      transportAdapters: ["webrtc-example"],
      interruptionCapabilities: ["cancel-turn"],
      inputAudioFormats: ["pcm16"],
      outputAudioFormats: ["pcm16"],
      usageDimensions: ["audio-seconds"],
      dataHandlingAssessmentRef: "assessment-1",
      credentialRef: "secret-ref-1",
      healthPolicy: { checkKey: "health-example", maximumAgeSeconds: 60, failClosed: true },
    }).providerId).toBe("provider-example");

    const definition = ToolDefinitionSchema.parse({
      toolId: "catalog.search",
      version: "1",
      description: "Search an authorised catalog.",
      inputSchema: { type: "object" },
      outputSchema: { type: "object" },
      requiredCapability: "catalog.search",
      requiredScopes: ["catalog:read"],
      riskClass: "low",
      sideEffectClass: "read",
      confirmationPolicy: "none",
      timeoutMs: 5000,
      retryPolicy: "safe-read",
      idempotencyPolicy: "tool-call",
      dataClassification: ["internal"],
    });
    expect(definition.toolId).toBe("catalog.search");

    expect(ToolInvocationSchema.parse({
      toolId: definition.toolId,
      arguments: { query: "example" },
      context: {
        tenantId: "tenant-1",
        agentId: "agent-1",
        sessionId: "session-1",
        deviceId: "device-1",
        capabilityBindingId: "capability-1",
        actorRef: "anonymous-1",
        correlationId: "correlation-1",
        toolCallId: "call-1",
        providerEventProvenance: "server-provider-connection",
        policyVersion: "policy-1",
        deadline: timestamp,
      },
    }).arguments).toEqual({ query: "example" });

    expect(() => ToolResultSchema.parse({
      toolCallId: "call-1",
      toolId: definition.toolId,
      status: "failed",
      capability: "catalog.search",
    })).toThrow("Terminal error results require an error object");
  });
});
