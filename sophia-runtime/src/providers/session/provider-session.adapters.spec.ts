import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import { createHash } from "node:crypto";
import type { AIProvider } from "../ai/ai-provider.interface.js";
import type { AvatarProvider } from "../avatar/avatar-provider.interface.js";
import type { TavusFullProvider } from "../tavus/tavus-full.provider.js";
import { CompositeRealtimeSessionAdapter } from "./composite-realtime-session.adapter.js";
import { NativeRealtimeSessionAdapter } from "./native-realtime-session.adapter.js";
import { GeminiLiveSessionAdapter } from "./gemini-live-session.adapter.js";
import type { NativeRealtimeProvider } from "../realtime/native-realtime-provider.interface.js";
import type { ProviderSessionAdapter } from "./provider-session.interface.js";
import { ProviderPartialOpenError } from "./provider-session.interface.js";
import { ProviderSessionRegistry } from "./provider-session.registry.js";

describe("provider session lifecycle adapters", () => {
  beforeEach(() => {
    process.env.SOPHIA_RUNTIME_DATABASE_URL = "postgres://example";
    process.env.OPENAI_REALTIME_MODEL = "test-native-model";
    process.env.OPENAI_REALTIME_VOICE = "test-voice";
    process.env.GEMINI_LIVE_MODEL = "gemini-3.8-live";
  });

  it("opens Professional with one text-output reasoning session and one FULL avatar", async () => {
    const ai: AIProvider = {
      createSession: jest.fn().mockResolvedValue({
        provider: "native-test", providerSessionId: "ai-1", model: "test-native-model", outputModality: "text",
      }),
      sendMessage: jest.fn(), registerTools: jest.fn(), closeSession: jest.fn(),
    };
    const avatar: AvatarProvider = {
      providerName: "liveavatar",
      createAvatarSession: jest.fn().mockResolvedValue({
        provider: "liveavatar", avatarSessionId: "avatar-1", mode: "FULL",
      }),
      sendAudioChunk: jest.fn(), getVideoStream: jest.fn(), closeAvatarSession: jest.fn(),
    };
    const adapter = new NativeRealtimeSessionAdapter(capabilities({
      "native-realtime-v1": ai, "live-avatar-v1": avatar,
    }) as never);
    const opened = await adapter.open({
      experience: "professional", customerId: "tenant-1", tools: [],
    });
    expect(ai.createSession).toHaveBeenCalledWith(expect.objectContaining({ outputModality: "text" }));
    expect(avatar.createAvatarSession).toHaveBeenCalledWith(expect.objectContaining({ mode: "FULL" }));
    expect(opened.persistence.metadata).toMatchObject({
      lifecycleAdapterKey: "native-realtime-experience-v1",
      avatarAdapterKey: "live-avatar-v1",
    });
  });

  it("keeps provider-native research inside the composite path", async () => {
    const composite = {
      createSession: jest.fn().mockResolvedValue({
        provider: "composite-test", providerSessionId: "composite-1", model: "native-model",
        outputModality: "audio", conversationUrl: "https://example.test/room", meetingToken: "token",
      }),
      closeSession: jest.fn(),
    } as unknown as TavusFullProvider;
    const provisionedTools = [{ name: "getInventory", description: "inventory", parameters: {} }];
    const catalog = { assertTavusReady: jest.fn().mockResolvedValue({ deploymentId: "deployment-1", catalogVersion: "v1",
      catalogDigest: createHash("sha256").update(JSON.stringify(provisionedTools)).digest("hex") }) };
    const adapter = new CompositeRealtimeSessionAdapter(capabilities({
      "composite-realtime-v1": composite,
    }) as never, catalog as never);
    const opened = await adapter.open({
      experience: "premium", customerId: "tenant-1",
      tools: [
        { name: "researchBusiness", description: "external research", parameters: {} },
        { name: "getInventory", description: "inventory", parameters: {} },
      ],
    });
    expect(composite.createSession).toHaveBeenCalledWith(expect.objectContaining({
      tools: [expect.objectContaining({ name: "getInventory" })],
    }));
    expect(catalog.assertTavusReady).toHaveBeenCalledWith("tenant-1");
    expect(opened.tools.map(({ name }) => name)).toEqual(["getInventory"]);
    expect(opened.persistence.metadata).toMatchObject({
      lifecycleAdapterKey: "composite-realtime-experience-v1",
      openAiSessionCreated: false,
    });
  });

  it("fails closed when a composite session requests a different catalog than the active deployment", async () => {
    const composite = { createSession: jest.fn() } as unknown as TavusFullProvider;
    const catalog = { assertTavusReady: jest.fn().mockResolvedValue({ deploymentId: "deployment-1", catalogVersion: "v1",
      catalogDigest: "0".repeat(64) }) };
    const adapter = new CompositeRealtimeSessionAdapter(capabilities({ "composite-realtime-v1": composite }) as never, catalog as never);
    await expect(adapter.open({ experience: "premium", customerId: "tenant-1",
      tools: [{ name: "catalog.search", description: "catalog", parameters: {} }] }))
      .rejects.toThrow("does not match");
    expect(composite.createSession).not.toHaveBeenCalled();
  });

  it("closes an avatar opened in parallel when native realtime creation fails", async () => {
    const ai = {
      createSession: jest.fn().mockRejectedValue(new Error("native unavailable")),
    } as unknown as AIProvider;
    const avatar = {
      providerName: "liveavatar",
      createAvatarSession: jest.fn().mockResolvedValue({
        provider: "liveavatar", avatarSessionId: "avatar-orphan", mode: "FULL",
      }),
      closeAvatarSession: jest.fn().mockResolvedValue(undefined),
    } as unknown as AvatarProvider;
    const adapter = new NativeRealtimeSessionAdapter(capabilities({
      "native-realtime-v1": ai, "live-avatar-v1": avatar,
    }) as never);
    await expect(adapter.open({
      experience: "professional", customerId: "tenant-1", tools: [],
    })).rejects.toThrow("native unavailable");
    expect(avatar.closeAvatarSession).toHaveBeenCalledWith("avatar-orphan");
  });

  it("surfaces a recoverable allocation when partial-start compensation fails", async () => {
    const ai = { createSession: jest.fn().mockRejectedValue(new Error("native unavailable")) } as unknown as AIProvider;
    const avatar = {
      providerName: "liveavatar",
      createAvatarSession: jest.fn().mockResolvedValue({ provider: "liveavatar", avatarSessionId: "avatar-orphan" }),
      closeAvatarSession: jest.fn().mockRejectedValue(new Error("cleanup unavailable")),
    } as unknown as AvatarProvider;
    const adapter = new NativeRealtimeSessionAdapter(capabilities({
      "native-realtime-v1": ai, "live-avatar-v1": avatar,
    }) as never);

    const failure = await adapter.open({ experience: "professional", customerId: "tenant-1", tools: [] })
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ProviderPartialOpenError);
    expect((failure as ProviderPartialOpenError).recoverableSession).toMatchObject({
      avatarSessionId: "avatar-orphan", metadata: { lifecycleAdapterKey: "native-realtime-experience-v1" },
    });
  });

  it("fails Premium before provider allocation when no tenant catalog is active", async () => {
    const composite = { createSession: jest.fn() } as unknown as TavusFullProvider;
    const catalog = { assertTavusReady: jest.fn().mockRejectedValue(new Error("catalog missing")) };
    const adapter = new CompositeRealtimeSessionAdapter(capabilities({
      "composite-realtime-v1": composite,
    }) as never, catalog as never);

    await expect(adapter.open({ experience: "premium", customerId: "tenant-1", tools: [] }))
      .rejects.toThrow("catalog missing");
    expect(composite.createSession).not.toHaveBeenCalled();
  });

  it("resolves adapters by persisted lifecycle key with bounded v1 fallback", () => {
    const native = mockSessionAdapter("native-realtime-experience-v1", ["essential", "professional"]);
    const composite = mockSessionAdapter("composite-realtime-experience-v1", ["premium"]);
    const registry = new ProviderSessionRegistry([native, composite]);
    expect(registry.resolveExperience("premium")).toBe(composite);
    expect(registry.resolveStoredSession({
      aiProvider: "legacy-native", avatarProvider: "none", metadata: {},
    })).toBe(native);
    expect(registry.resolveStoredSession({
      aiProvider: "tavus-full", avatarProvider: "tavus", metadata: {},
    })).toBe(composite);
  });

  it("opens Gemini Live only through an explicit v2 plan adapter", async () => {
    const live: NativeRealtimeProvider = {
      createSession: jest.fn().mockResolvedValue({ provider: "gemini-live", providerSessionId: "live-1",
        model: "gemini-3.8-live", outputModality: "audio", clientSecret: "ephemeral",
        transportBootstrap: { protocol: "gemini-live-websocket" } }),
      closeSession: jest.fn(),
    };
    const adapter = new GeminiLiveSessionAdapter(capabilities({ "gemini-live-v1": live }) as never);
    const opened = await adapter.open({ experience: "essential", customerId: "tenant-1", tools: [], instructions: "Safe." });
    expect(opened.ai).toMatchObject({ provider: "gemini-live", clientSecret: "ephemeral",
      transportBootstrap: { protocol: "gemini-live-websocket" } });
    expect(opened.avatar.provider).toBe("none");
    expect(adapter.experiences).toEqual([]);
  });

  it("selects the lifecycle adapter from the published plan rather than an experience switch", () => {
    const native = mockSessionAdapter("native-realtime-experience-v1", ["essential", "professional"]);
    const composite = mockSessionAdapter("composite-realtime-experience-v1", ["premium"]);
    const registry = new ProviderSessionRegistry([native, composite]);
    expect(registry.resolvePlan({
      tenantId: "tenant", agentId: "agent", experienceId: "custom", profileVersion: "profile",
      pipelineMode: "composite-realtime", capabilityOwners: { "native-realtime": "main" },
      providerBindings: [{ bindingId: "main", providerId: "provider", adapterKey: "composite-realtime-v1", capability: "native-realtime", configurationVersion: "1" }],
      capabilityBindings: [], policyVersion: "policy", toolCatalogVersion: "catalog",
      languagePolicy: { defaultLocale: "en-AU", allowedLocales: ["en-AU"] },
      dataPolicy: { policyRef: "policy", transcriptPersistence: "disabled", audioPersistence: "disabled", processingRegions: [] },
      usageLimits: { maximumSessionSeconds: 60, maximumToolCalls: 1 },
      fallbackPolicy: { mode: "none", allowedProfileVersions: [] },
    })).toBe(composite);
  });
});

function capabilities(implementations: Record<string, object>) {
  return {
    resolve(adapterKey: string) {
      const implementation = implementations[adapterKey];
      if (!implementation) throw new Error(`Missing test adapter ${adapterKey}`);
      return { adapterKey, implementation };
    },
  };
}

function mockSessionAdapter(
  adapterKey: string,
  experiences: ProviderSessionAdapter["experiences"],
): ProviderSessionAdapter {
  const providerAdapterKeys = adapterKey.startsWith("composite")
    ? ["composite-realtime-v1"]
    : ["native-realtime-v1"];
  return { adapterKey, providerAdapterKeys, experiences, open: jest.fn() as never, close: jest.fn() };
}
