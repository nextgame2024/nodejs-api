import { describe, expect, it, beforeEach, jest } from "@jest/globals";
import { ConversationService } from "./conversation.service.js";
import type { AIProvider } from "../providers/ai/ai-provider.interface.js";
import type { AvatarProvider } from "../providers/avatar/avatar-provider.interface.js";
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
            avatar_provider: "test-avatar",
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
      }),
      sendMessage: jest.fn(),
      registerTools: jest.fn(),
      closeSession: jest.fn(),
    };
    const avatarProvider: AvatarProvider = {
      createAvatarSession: jest.fn().mockResolvedValue({
        provider: "test-avatar",
        avatarSessionId: "avatar-session-1",
      }),
      sendAudioChunk: jest.fn(),
      getVideoStream: jest.fn(),
      closeAvatarSession: jest.fn(),
    };

    const service = new ConversationService(
      database as never,
      tools,
      aiProvider,
      avatarProvider,
    );

    const result = await service.createSession({ storeId: "demo-store" });

    expect(aiProvider.createSession).toHaveBeenCalledWith(
      expect.objectContaining({
        customerId: "11111111-1111-4111-8111-111111111111",
        tools: expect.arrayContaining([
          expect.objectContaining({ name: "getInventory" }),
        ]),
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
  });
});
