import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { runtimeConfig } from "../config/runtime-config.js";
import { DatabaseService } from "../database/database.service.js";
import {
  AI_PROVIDER,
} from "../providers/ai/openai-realtime.provider.js";
import type { AIProvider } from "../providers/ai/ai-provider.interface.js";
import {
  AVATAR_PROVIDER,
} from "../providers/avatar/simli-avatar.provider.js";
import type { AvatarProvider } from "../providers/avatar/avatar-provider.interface.js";
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
    @Inject(AVATAR_PROVIDER) private readonly avatarProvider: AvatarProvider,
  ) {}

  async createSession(dto: CreateSessionDto) {
    const config = runtimeConfig();
    const customerId = dto.customerId || config.defaultCustomerId;
    if (!customerId) {
      throw new Error("customerId is required until SOPHIA_DEFAULT_CUSTOMER_ID is configured.");
    }

    const storeId = dto.storeId || config.defaultStoreId;
    const toolDefinitions = this.tools.listDefinitions();
    const aiSession = await this.aiProvider.createSession({
      customerId,
      deviceId: dto.deviceId,
      storeId,
      model: config.openAi.realtimeModel,
      voice: config.openAi.voice,
      tools: toolDefinitions,
    });
    const avatarSession = await this.avatarProvider.createAvatarSession({
      customerId,
      deviceId: dto.deviceId,
      avatarId: config.simli.avatarId,
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
        avatarSession.provider,
        aiSession.providerSessionId,
        avatarSession.avatarSessionId,
        JSON.stringify({ model: aiSession.model, voice: aiSession.voice }),
      ],
    );

    return {
      session: normalizeSession(rows[0]),
      ai: {
        provider: aiSession.provider,
        model: aiSession.model,
        voice: aiSession.voice,
        clientSecret: aiSession.clientSecret,
        expiresAt: aiSession.expiresAt,
      },
      avatar: {
        provider: avatarSession.provider,
        sessionToken: avatarSession.sessionToken,
        transportMode: avatarSession.transportMode,
        streamUrl: avatarSession.streamUrl,
        expiresAt: avatarSession.expiresAt,
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
    await this.aiProvider.closeSession(current.session.providerSessionId ?? sessionId);
    await this.avatarProvider.closeAvatarSession(
      current.session.avatarSessionId ?? sessionId,
    );

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
