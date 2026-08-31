import { describe, expect, it, beforeEach, jest } from "@jest/globals";
import { ConversationService } from "./conversation.service.js";
import type { AIProvider } from "../providers/ai/ai-provider.interface.js";
import type { AvatarProvider } from "../providers/avatar/avatar-provider.interface.js";
import { AvatarProviderRegistry } from "../providers/avatar/avatar-provider.registry.js";
import { ToolRegistryService } from "../tools/tools.service.js";

describe("ConversationService", () => {
  beforeEach(() => {
    process.env.SOPHIA_RUNTIME_DATABASE_URL = "postgres://example";
    process.env.SOPHIA_DEFAULT_CUSTOMER_ID =
      "11111111-1111-4111-8111-111111111111";
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
            avatar_provider: "simli",
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
    } as unknown as ToolRegistryService;
    const aiProvider: AIProvider = {
      createSession: jest.fn().mockResolvedValue({
        provider: "test-ai",
        providerSessionId: "ai-session-1",
        model: "test-model",
        outputModality: "audio",
      }),
      sendMessage: jest.fn(),
      registerTools: jest.fn(),
      closeSession: jest.fn(),
    };
    const avatarProvider: AvatarProvider = {
      providerName: "simli",
      createAvatarSession: jest.fn().mockResolvedValue({
        provider: "simli",
        avatarSessionId: "avatar-session-1",
      }),
      sendAudioChunk: jest.fn(),
      getVideoStream: jest.fn(),
      closeAvatarSession: jest.fn(),
    };
    const avatarProviders = {
      resolve: jest.fn().mockReturnValue(avatarProvider),
    } as unknown as AvatarProviderRegistry;

    const service = new ConversationService(
      database as never,
      tools,
      aiProvider,
      avatarProviders,
    );

    const result = await service.createSession({
      storeId: "demo-store",
      avatarProvider: "simli",
    });

    expect(aiProvider.createSession).toHaveBeenCalledWith(
      expect.objectContaining({
        customerId: "11111111-1111-4111-8111-111111111111",
        tools: expect.arrayContaining([
          expect.objectContaining({ name: "getInventory" }),
        ]),
        outputModality: "audio",
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
    expect(result.avatar.provider).toBe("simli");
  });

  it("creates an OpenAI-only session without resolving an avatar provider", async () => {
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
    const avatarProviders = {
      resolve: jest.fn(),
    } as unknown as AvatarProviderRegistry;

    const service = new ConversationService(
      database as never,
      tools,
      aiProvider,
      avatarProviders,
    );
    const result = await service.createSession({ avatarProvider: "none" });

    expect(avatarProviders.resolve).not.toHaveBeenCalled();
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
    const avatarProviders = {
      resolve: jest.fn().mockReturnValue(avatarProvider),
    } as unknown as AvatarProviderRegistry;
    const service = new ConversationService(
      database as never,
      tools,
      aiProvider,
      avatarProviders,
    );

    const result = await service.createSession({
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
});
