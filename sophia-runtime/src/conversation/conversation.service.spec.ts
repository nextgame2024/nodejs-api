import { describe, expect, it, beforeEach, jest } from "@jest/globals";
import { createHash } from "node:crypto";
import { ConversationService } from "./conversation.service.js";
import type { AIProvider } from "../providers/ai/ai-provider.interface.js";
import type { AvatarProvider } from "../providers/avatar/avatar-provider.interface.js";
import { ToolRegistryService } from "../tools/tools.service.js";
import { TavusFullProvider } from "../providers/tavus/tavus-full.provider.js";
import { NativeRealtimeSessionAdapter } from "../providers/session/native-realtime-session.adapter.js";
import { CompositeRealtimeSessionAdapter } from "../providers/session/composite-realtime-session.adapter.js";
import { ProviderSessionRegistry } from "../providers/session/provider-session.registry.js";

describe("ConversationService", () => {
  beforeEach(() => {
    process.env.SOPHIA_RUNTIME_DATABASE_URL = "postgres://example";
    process.env.SOPHIA_DEFAULT_CUSTOMER_ID =
      "11111111-1111-4111-8111-111111111111";
    process.env.SOPHIA_DEFAULT_STORE_ID = "demo-store";
    process.env.SOPHIA_RUNTIME_SCHEMA = "sophia_runtime";
  });

  it("creates sessions through provider interfaces and registered tools", async () => {
    const database = {
      query: jest.fn().mockResolvedValue({
        rows: [
          {
            session_id: "22222222-2222-4222-8222-222222222222",
            customer_id: "11111111-1111-4111-8111-111111111111",
            device_id: null,
            store_id: "demo-store",
            status: "active",
            ai_provider: "test-ai",
            avatar_provider: "liveavatar",
            provider_session_id: "ai-session-1",
            avatar_session_id: "avatar-session-1",
            started_at: new Date("2026-01-01T00:00:00.000Z"),
            ended_at: null,
          },
        ],
      }),
    };
    const tools = {
      listDefinitions: jest.fn().mockReturnValue([
        { name: "getInventory", description: "Mock", parameters: {} },
      ]),
      conversationInstructions: jest.fn().mockReturnValue("legacy instructions"),
    } as unknown as ToolRegistryService;
    const aiProvider: AIProvider = {
      createSession: jest.fn().mockResolvedValue({
        provider: "test-ai",
        providerSessionId: "ai-session-1",
        model: "test-model",
        outputModality: "text",
      }),
      sendMessage: jest.fn(),
      registerTools: jest.fn(),
      closeSession: jest.fn(),
    };
    const avatarProvider: AvatarProvider = {
      providerName: "liveavatar",
      createAvatarSession: jest.fn().mockResolvedValue({
        provider: "liveavatar",
        avatarSessionId: "avatar-session-1",
      }),
      sendAudioChunk: jest.fn(),
      getVideoStream: jest.fn(),
      closeAvatarSession: jest.fn(),
    };
    const service = new ConversationService(
      tenantDatabase(database) as never,
      tools,
      sessionRegistry(aiProvider, avatarProvider),
      operations(),
    );

    const result = await service.createSession({
      storeId: "demo-store",
      experience: "professional",
    });

    expect(aiProvider.createSession).toHaveBeenCalledWith(
      expect.objectContaining({
        customerId: "11111111-1111-4111-8111-111111111111",
        tools: expect.arrayContaining([
          expect.objectContaining({ name: "getInventory" }),
        ]),
        outputModality: "text",
      }),
    );
    expect(avatarProvider.createAvatarSession).toHaveBeenCalledWith(
      expect.objectContaining({
        customerId: "11111111-1111-4111-8111-111111111111",
      }),
    );
    expect(result.session.sessionId).toBe(
      "22222222-2222-4222-8222-222222222222",
    );
    expect(result.avatar.provider).toBe("liveavatar");
  });

  it("defaults to Essential and ignores legacy browser provider overrides", async () => {
    const database = {
      query: jest.fn().mockResolvedValue({
        rows: [
          {
            session_id: "22222222-2222-4222-8222-222222222222",
            customer_id: "11111111-1111-4111-8111-111111111111",
            device_id: null,
            store_id: "demo-store",
            status: "active",
            ai_provider: "openai-realtime",
            avatar_provider: "none",
            provider_session_id: "ai-session-1",
            avatar_session_id: null,
            started_at: new Date("2026-01-01T00:00:00.000Z"),
            ended_at: null,
          },
        ],
      }),
    };
    const tools = {
      listDefinitions: jest.fn().mockReturnValue([]),
      conversationInstructions: jest.fn().mockReturnValue("legacy instructions"),
    } as unknown as ToolRegistryService;
    const aiProvider: AIProvider = {
      createSession: jest.fn().mockResolvedValue({
        provider: "openai-realtime",
        providerSessionId: "ai-session-1",
        model: "test-model",
        outputModality: "audio",
      }),
      sendMessage: jest.fn(),
      registerTools: jest.fn(),
      closeSession: jest.fn(),
    };
    const service = new ConversationService(
      tenantDatabase(database) as never,
      tools,
      sessionRegistry(aiProvider),
      operations(),
    );
    const result = await service.createSession({
      aiProvider: "tavus-full",
      avatarProvider: "liveavatar",
    });

    expect(result.avatar).toMatchObject({ provider: "none" });
  });

  it("uses text-only OpenAI output for LiveAvatar FULL sessions", async () => {
    const database = {
      query: jest.fn().mockResolvedValue({
        rows: [
          {
            session_id: "22222222-2222-4222-8222-222222222222",
            customer_id: "11111111-1111-4111-8111-111111111111",
            device_id: null,
            store_id: "demo-store",
            status: "active",
            ai_provider: "openai-realtime",
            avatar_provider: "liveavatar",
            provider_session_id: "ai-session-1",
            avatar_session_id: "avatar-session-1",
            started_at: new Date("2026-01-01T00:00:00.000Z"),
            ended_at: null,
          },
        ],
      }),
    };
    const tools = {
      listDefinitions: jest.fn().mockReturnValue([]),
      conversationInstructions: jest.fn().mockReturnValue("legacy instructions"),
    } as unknown as ToolRegistryService;
    const aiProvider: AIProvider = {
      createSession: jest.fn().mockResolvedValue({
        provider: "openai-realtime",
        providerSessionId: "ai-session-1",
        model: "test-model",
        outputModality: "text",
      }),
      sendMessage: jest.fn(),
      registerTools: jest.fn(),
      closeSession: jest.fn(),
    };
    const avatarProvider: AvatarProvider = {
      providerName: "liveavatar",
      createAvatarSession: jest.fn().mockResolvedValue({
        provider: "liveavatar",
        avatarSessionId: "avatar-session-1",
        mode: "FULL",
      }),
      sendAudioChunk: jest.fn(),
      getVideoStream: jest.fn(),
      closeAvatarSession: jest.fn(),
    };
    const service = new ConversationService(
      tenantDatabase(database) as never,
      tools,
      sessionRegistry(aiProvider, avatarProvider),
      operations(),
    );

    const result = await service.createSession({
      experience: "professional",
      avatarProvider: "liveavatar",
      avatarMode: "FULL",
    });

    expect(aiProvider.createSession).toHaveBeenCalledWith(
      expect.objectContaining({ outputModality: "text" }),
    );
    expect(avatarProvider.createAvatarSession).toHaveBeenCalledWith(
      expect.objectContaining({ mode: "FULL" }),
    );
    expect(result.ai.outputModality).toBe("text");
    expect(result.avatar.mode).toBe("FULL");
  });

  it("creates Tavus Full sessions without creating an OpenAI session", async () => {
    const database = {
      query: jest.fn().mockResolvedValue({
        rows: [
          {
            session_id: "22222222-2222-4222-8222-222222222222",
            customer_id: "11111111-1111-4111-8111-111111111111",
            device_id: null,
            store_id: "demo-store",
            status: "active",
            ai_provider: "tavus-full",
            avatar_provider: "tavus",
            provider_session_id: "tavus-conversation-1",
            avatar_session_id: "tavus-conversation-1",
            started_at: new Date("2026-01-01T00:00:00.000Z"),
            ended_at: null,
          },
        ],
      }),
    };
    const tools = {
      listDefinitions: jest.fn().mockReturnValue([]),
      conversationInstructions: jest.fn().mockReturnValue("legacy instructions"),
    } as unknown as ToolRegistryService;
    const aiProvider: AIProvider = {
      createSession: jest.fn(),
      sendMessage: jest.fn(),
      registerTools: jest.fn(),
      closeSession: jest.fn(),
    };
    const tavusProvider = {
      createSession: jest.fn().mockResolvedValue({
        provider: "tavus-full",
        providerSessionId: "tavus-conversation-1",
        model: "tavus-gpt-oss",
        outputModality: "audio",
        conversationUrl: "https://tavus.daily.co/conversation-1",
        meetingToken: "meeting-token",
      }),
      closeSession: jest.fn(),
    } as unknown as TavusFullProvider;
    const service = new ConversationService(
      tenantDatabase(database) as never,
      tools,
      sessionRegistry(aiProvider, undefined, tavusProvider),
      operations(),
    );

    const result = await service.createSession({
      experience: "premium",
      aiProvider: "tavus-full",
      storeId: "demo-store",
    });

    expect(tavusProvider.createSession).toHaveBeenCalledWith(
      expect.objectContaining({ storeId: "demo-store" }),
    );
    expect(aiProvider.createSession).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      ai: { provider: "tavus-full", model: "tavus-gpt-oss" },
      avatar: {
        provider: "tavus",
        streamUrl: "https://tavus.daily.co/conversation-1",
      },
    });
  });

  it("requires the session-specific access token without exposing stored metadata", async () => {
    const token = "session-secret";
    const database = {
      query: jest.fn().mockResolvedValue({
        rows: [{
          session_id: "22222222-2222-4222-8222-222222222222",
          customer_id: "11111111-1111-4111-8111-111111111111",
          device_id: null,
          store_id: "demo-store",
          status: "active",
          ai_provider: "openai-realtime",
          avatar_provider: "none",
          provider_session_id: "provider-session",
          avatar_session_id: null,
          started_at: new Date("2026-01-01T00:00:00.000Z"),
          ended_at: null,
          metadata: {
            sessionAccessTokenHash: createHash("sha256")
              .update(token)
              .digest("base64url"),
            sessionAccessExpiresAt: new Date(Date.now() + 60_000).toISOString(),
          },
        }],
      }),
    };
    const service = new ConversationService(
      tenantDatabase(database) as never,
      {} as ToolRegistryService,
      {} as ProviderSessionRegistry,
      operations(),
    );

    await expect(service.getSession("22222222-2222-4222-8222-222222222222"))
      .rejects.toThrow("Session access token is required");
    await expect(service.getSession("22222222-2222-4222-8222-222222222222", "wrong"))
      .rejects.toThrow("invalid or expired");
    const result = await service.getSession(
      "22222222-2222-4222-8222-222222222222",
      token,
    );
    expect(result.session).not.toHaveProperty("metadata");
  });

  it("blocks new admission for a suspended organisation before opening a provider session", async () => {
    const database = { query: jest.fn() };
    const providerSessions = { resolveExperience: jest.fn().mockReturnValue({ adapterKey: "native", open: jest.fn() }) } as unknown as ProviderSessionRegistry;
    const providerOperations = { ...operations(), begin: jest.fn().mockRejectedValue(
      new Error("This organisation is not admitting new Sophia sessions.")) };
    const service = new ConversationService(
      tenantDatabase(database) as never,
      { listDefinitions: jest.fn() } as unknown as ToolRegistryService,
      providerSessions,
      providerOperations as never,
    );
    await expect(service.createSession({ experience: "essential" }))
      .rejects.toThrow("not admitting new Sophia sessions");
    expect(providerOperations.begin).toHaveBeenCalled();
    expect(providerOperations.open).not.toHaveBeenCalled();
  });
});

function sessionRegistry(
  ai: AIProvider,
  avatar?: AvatarProvider,
  composite: TavusFullProvider = {} as TavusFullProvider,
): ProviderSessionRegistry {
  const capabilities = {
    resolve: jest.fn((adapterKey: string) => {
      if (adapterKey === "native-realtime-v1") return { adapterKey, implementation: ai };
      if (adapterKey === "live-avatar-v1" && avatar) return { adapterKey, implementation: avatar };
      if (adapterKey === "composite-realtime-v1") return { adapterKey, implementation: composite };
      throw new Error(`Unexpected test adapter ${adapterKey}`);
    }),
  };
  return new ProviderSessionRegistry([
    new NativeRealtimeSessionAdapter(capabilities as never),
    new CompositeRealtimeSessionAdapter(capabilities as never, catalogGate() as never),
  ]);
}

function catalogGate() {
  return { assertTavusReady: jest.fn().mockResolvedValue({ deploymentId: "deployment-1", catalogVersion: "test-v1",
    catalogDigest: createHash("sha256").update("[]").digest("hex") }) };
}

function operations() {
  return {
    begin: jest.fn().mockResolvedValue({ allocationId: "allocation-1", customerId: "11111111-1111-4111-8111-111111111111", adapterKey: "test" }),
    open: jest.fn(async (_allocation, adapter, request) => adapter.open(request)),
    attach: jest.fn().mockResolvedValue(undefined),
    compensate: jest.fn().mockResolvedValue(undefined),
    close: jest.fn(async (row) => row),
    heartbeat: jest.fn(async (row) => row),
    disconnect: jest.fn(async (row) => row),
  } as never;
}

function tenantDatabase<T extends { query: (...args: any[]) => any }>(database: T) {
  return Object.assign(database, {
    tenantTransaction: jest.fn((_tenantId: string, work: (client: { query: T["query"] }) => unknown) =>
      work({ query: database.query })),
  });
}
