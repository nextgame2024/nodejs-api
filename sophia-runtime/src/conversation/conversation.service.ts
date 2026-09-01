import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { runtimeConfig } from "../config/runtime-config.js";
import { DatabaseService } from "../database/database.service.js";
import {
  AI_PROVIDER,
} from "../providers/ai/openai-realtime.provider.js";
import type { AIProvider } from "../providers/ai/ai-provider.interface.js";
import { AvatarProviderRegistry } from "../providers/avatar/avatar-provider.registry.js";
import type {
  AvatarProviderSession,
  AvatarProviderSessionRequest,
  AvatarProviderSelection,
} from "../providers/avatar/avatar-provider.interface.js";
import { TavusFullProvider } from "../providers/tavus/tavus-full.provider.js";
import { ToolRegistryService } from "../tools/tools.service.js";
import { CreateSessionDto } from "./dto/create-session.dto.js";
import { ExecuteToolDto } from "./dto/execute-tool.dto.js";

type SessionRow = {
  session_id: string;
  customer_id: string;
  device_id: string | null;
  store_id: string | null;
  status: string;
  ai_provider: string;
  avatar_provider: string;
  provider_session_id: string | null;
  avatar_session_id: string | null;
  started_at: Date;
  ended_at: Date | null;
};

@Injectable()
export class ConversationService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(ToolRegistryService) private readonly tools: ToolRegistryService,
    @Inject(AI_PROVIDER) private readonly aiProvider: AIProvider,
    @Inject(AvatarProviderRegistry)
    private readonly avatarProviders: AvatarProviderRegistry,
    @Inject(TavusFullProvider)
    private readonly tavusProvider: TavusFullProvider,
  ) {}

  async createSession(dto: CreateSessionDto) {
    const config = runtimeConfig();
    const customerId = dto.customerId || config.defaultCustomerId;
    if (!customerId) {
      throw new Error("customerId is required until SOPHIA_DEFAULT_CUSTOMER_ID is configured.");
    }

    const storeId = dto.storeId || config.defaultStoreId;
    if (dto.aiProvider === "tavus-full") {
      return this.createTavusSession(dto, customerId, storeId);
    }

    const avatarProviderName = dto.avatarProvider || config.avatarProvider;
    const avatarMode =
      avatarProviderName === "liveavatar"
        ? dto.avatarMode || config.liveAvatar.mode
        : undefined;
    const outputModality =
      avatarProviderName === "liveavatar" && avatarMode === "FULL"
        ? "text"
        : "audio";
    const toolDefinitions = this.tools.listDefinitions();
    const aiSession = await this.aiProvider.createSession({
      customerId,
      deviceId: dto.deviceId,
      storeId,
      model: config.openAi.realtimeModel,
      voice: config.openAi.voice,
      outputModality,
      tools: toolDefinitions,
    });
    const { session: avatarSession, error: avatarError } =
      await this.createAvatarSession(avatarProviderName, {
        customerId,
        deviceId: dto.deviceId,
        avatarId:
          avatarProviderName === "liveavatar"
            ? config.liveAvatar.avatarId
            : config.simli.avatarId,
        mode: avatarMode,
      });

    const { rows } = await this.database.query<SessionRow>(
      `
        INSERT INTO ${config.schema}.sessions (
          customer_id,
          device_id,
          store_id,
          created_by_user_id,
          ai_provider,
          avatar_provider,
          provider_session_id,
          avatar_session_id,
          status,
          metadata
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'active', $9::jsonb)
        RETURNING *
      `,
      [
        customerId,
        dto.deviceId ?? null,
        storeId ?? null,
        dto.createdByUserId ?? null,
        aiSession.provider,
        avatarSession?.provider || avatarProviderName,
        aiSession.providerSessionId,
        avatarSession?.avatarSessionId ?? null,
        JSON.stringify({
          model: aiSession.model,
          voice: aiSession.voice,
          outputModality: aiSession.outputModality,
          ...(avatarMode ? { avatarMode } : {}),
          ...(avatarError ? { avatarError } : {}),
        }),
      ],
    );

    return {
      session: normalizeSession(rows[0]),
      ai: {
        provider: aiSession.provider,
        model: aiSession.model,
        voice: aiSession.voice,
        outputModality: aiSession.outputModality,
        clientSecret: aiSession.clientSecret,
        expiresAt: aiSession.expiresAt,
      },
      avatar: {
        provider: avatarSession?.provider || avatarProviderName,
        sessionToken: avatarSession?.sessionToken,
        transportMode: avatarSession?.transportMode,
        mode: avatarSession?.mode || avatarMode,
        streamUrl: avatarSession?.streamUrl,
        expiresAt: avatarSession?.expiresAt,
        error: avatarError,
      },
      tools: toolDefinitions,
    };
  }

  async getSession(sessionId: string) {
    const config = runtimeConfig();
    const { rows } = await this.database.query<SessionRow>(
      `SELECT * FROM ${config.schema}.sessions WHERE session_id = $1`,
      [sessionId],
    );
    if (!rows[0]) throw new NotFoundException("Session not found");
    return { session: normalizeSession(rows[0]) };
  }

  async executeTool(sessionId: string, dto: ExecuteToolDto) {
    const { session } = await this.getSession(sessionId);
    const output = await this.tools.execute(dto.toolName, dto.input, {
      customerId: session.customerId,
      sessionId,
      storeId: session.storeId ?? undefined,
    });

    return { toolName: dto.toolName, output };
  }

  async closeSession(sessionId: string) {
    const config = runtimeConfig();
    const current = await this.getSession(sessionId);
    if (current.session.aiProvider === "tavus-full") {
      if (!current.session.providerSessionId) {
        throw new Error("Tavus session is missing its conversation ID.");
      }
      await this.tavusProvider.closeSession(current.session.providerSessionId);
    } else {
      await this.aiProvider.closeSession(
        current.session.providerSessionId ?? sessionId,
      );
      if (
        current.session.avatarProvider !== "none" &&
        current.session.avatarSessionId
      ) {
        const avatarProvider = this.avatarProviders.resolve(
          current.session.avatarProvider as Exclude<
            AvatarProviderSelection,
            "none"
          >,
        );
        await avatarProvider.closeAvatarSession(current.session.avatarSessionId);
      }
    }

    const { rows } = await this.database.query<SessionRow>(
      `
        UPDATE ${config.schema}.sessions
        SET status = 'closed', ended_at = now(), updated_at = now()
        WHERE session_id = $1
        RETURNING *
      `,
      [sessionId],
    );

    return { session: normalizeSession(rows[0]) };
  }

  private async createTavusSession(
    dto: CreateSessionDto,
    customerId: string,
    storeId: string | undefined,
  ) {
    const config = runtimeConfig();
    const tavusSession = await this.tavusProvider.createSession({
      customerId,
      deviceId: dto.deviceId,
      storeId,
    });
    const toolDefinitions = this.tools.listDefinitions();
    try {
      const { rows } = await this.database.query<SessionRow>(
        `
        INSERT INTO ${config.schema}.sessions (
          customer_id,
          device_id,
          store_id,
          created_by_user_id,
          ai_provider,
          avatar_provider,
          provider_session_id,
          avatar_session_id,
          status,
          metadata
        )
        VALUES ($1, $2, $3, $4, 'tavus-full', 'tavus', $5, $5, 'active', $6::jsonb)
        RETURNING *
      `,
        [
          customerId,
          dto.deviceId ?? null,
          storeId ?? null,
          dto.createdByUserId ?? null,
          tavusSession.providerSessionId,
          JSON.stringify({
            model: tavusSession.model,
            outputModality: tavusSession.outputModality,
            billingPath: "tavus-only",
            openAiSessionCreated: false,
          }),
        ],
      );

      return {
        session: normalizeSession(rows[0]),
        ai: {
          provider: tavusSession.provider,
          model: tavusSession.model,
          outputModality: tavusSession.outputModality,
        },
        avatar: {
          provider: "tavus",
          sessionToken: tavusSession.meetingToken,
          streamUrl: tavusSession.conversationUrl,
        },
        tools: toolDefinitions,
      };
    } catch (error) {
      await this.tavusProvider
        .closeSession(tavusSession.providerSessionId)
        .catch(() => undefined);
      throw error;
    }
  }

  private async createAvatarSession(
    providerName: AvatarProviderSelection,
    request: AvatarProviderSessionRequest,
  ): Promise<{ session: AvatarProviderSession | null; error?: string }> {
    if (providerName === "none") return { session: null };

    try {
      const provider = this.avatarProviders.resolve(providerName);
      return { session: await provider.createAvatarSession(request) };
    } catch (error) {
      return {
        session: null,
        error:
          error instanceof Error
            ? error.message
            : `${providerName} avatar session could not be created.`,
      };
    }
  }
}

function normalizeSession(row: SessionRow) {
  return {
    sessionId: row.session_id,
    customerId: row.customer_id,
    deviceId: row.device_id,
    storeId: row.store_id,
    status: row.status,
    aiProvider: row.ai_provider,
    avatarProvider: row.avatar_provider,
    providerSessionId: row.provider_session_id,
    avatarSessionId: row.avatar_session_id,
    startedAt: row.started_at,
    endedAt: row.ended_at,
  };
}
