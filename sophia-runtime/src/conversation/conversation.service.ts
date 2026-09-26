import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { ForbiddenException, Inject, Injectable, Logger, NotFoundException, UnauthorizedException } from "@nestjs/common";
import { runtimeConfig } from "../config/runtime-config.js";
import { DatabaseService } from "../database/database.service.js";
import { ProviderSessionRegistry } from "../providers/session/provider-session.registry.js";
import { ProviderOperationsService, type OperationalSessionRow } from "../providers/session/provider-operations.service.js";
import type { PublicExperience } from "../providers/session/provider-session.interface.js";
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
  last_seen_at?: Date | null;
  disconnect_expires_at?: Date | null;
  hard_expires_at?: Date | null;
  metadata?: Record<string, unknown>;
};

@Injectable()
export class ConversationService {
  private readonly logger = new Logger(ConversationService.name);

  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(ToolRegistryService) private readonly tools: ToolRegistryService,
    @Inject(ProviderSessionRegistry) private readonly providerSessions: ProviderSessionRegistry,
    @Inject(ProviderOperationsService) private readonly providerOperations: ProviderOperationsService,
  ) {}

  async createSession(dto: CreateSessionDto) {
    const startedAt = Date.now();
    const config = runtimeConfig();
    const customerId = config.defaultCustomerId;
    if (!customerId) {
      throw new Error("customerId is required until SOPHIA_DEFAULT_CUSTOMER_ID is configured.");
    }

    const experience = resolveExperience(dto);
    if (!config.allowedExperiences.includes(experience)) {
      throw new ForbiddenException("This Sophia experience is not enabled.");
    }
    const accessToken = randomBytes(32).toString("base64url");
    const accessExpiresAt = new Date(
      Date.now() + config.sessionAccessTtlSeconds * 1000,
    );
    const storeId = config.defaultStoreId;
    const toolDefinitions = this.tools.listDefinitions();
    const adapter = this.providerSessions.resolveExperience(experience);
    const allocation = await this.providerOperations.begin(customerId, adapter.adapterKey, experience);
    const opened = await this.providerOperations.open(allocation, adapter, {
      experience,
      customerId,
      deviceId: config.defaultDeviceId,
      storeId,
      tools: toolDefinitions,
      instructions: this.tools.conversationInstructions("legacy"),
    });
    let persistedSessionId: string | undefined;
    try {
      const { rows } = await this.database.tenantTransaction(customerId, (client) => client.query<SessionRow>(`
        WITH inserted_session AS (
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
          metadata,
          last_seen_at,
          disconnect_expires_at,
          hard_expires_at,
          runtime_api_version
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'active', $9::jsonb,
                now(), now() + make_interval(secs => $10), now() + make_interval(secs => $11), 'v1')
        RETURNING *
        ), privacy_defaults AS (
          INSERT INTO ${config.schema}.session_privacy_controls (session_id, customer_id)
          SELECT session_id, customer_id FROM inserted_session
          RETURNING session_id
        )
        SELECT inserted_session.* FROM inserted_session JOIN privacy_defaults USING (session_id)
      `, [
        customerId,
        config.defaultDeviceId ?? null,
        storeId ?? null,
        null,
        opened.persistence.aiProvider,
        opened.persistence.avatarProvider,
        opened.persistence.providerSessionId,
        opened.persistence.avatarSessionId ?? null,
        JSON.stringify({
          ...opened.persistence.metadata,
          sessionAccessTokenHash: hashAccessToken(accessToken),
          sessionAccessExpiresAt: accessExpiresAt.toISOString(),
          providerAllocationId: allocation.allocationId,
        }),
        config.disconnectGraceSeconds,
        config.providerSessionMaxSeconds,
      ]));

      persistedSessionId = rows[0].session_id;
      await this.providerOperations.attach(allocation, rows[0].session_id);

      this.logger.log(`Created ${adapter.adapterKey} session in ${Date.now() - startedAt}ms.`);

      return {
        session: normalizeSession(rows[0]),
        ai: opened.ai,
        avatar: opened.avatar,
        tools: opened.tools,
        sessionAccessToken: accessToken,
        sessionAccessExpiresAt: accessExpiresAt.toISOString(),
      };
    } catch (error) {
      await this.providerOperations.compensate(allocation, adapter, opened.persistence);
      if (persistedSessionId) {
        await this.database.query(
          `UPDATE ${config.schema}.sessions
           SET status = 'failed', ended_at = COALESCE(ended_at, now()), updated_at = now()
           WHERE session_id = $1 AND status = 'active'`,
          [persistedSessionId],
        ).catch(() => undefined);
      }
      throw error;
    }
  }

  async getSession(sessionId: string, accessToken?: string) {
    const row = await this.loadSession(sessionId);
    assertSessionAccess(row, accessToken);
    return { session: normalizeSession(row) };
  }

  private async loadSession(sessionId: string): Promise<SessionRow> {
    const config = runtimeConfig();
    const { rows } = await this.database.query<SessionRow>(
      `SELECT * FROM ${config.schema}.sessions WHERE session_id = $1 AND runtime_api_version = 'v1'`,
      [sessionId],
    );
    if (!rows[0]) throw new NotFoundException("Session not found");
    return rows[0];
  }

  async executeTool(sessionId: string, dto: ExecuteToolDto, accessToken?: string) {
    const row = await this.loadSession(sessionId);
    assertSessionAccess(row, accessToken);
    const session = normalizeSession(row);
    const output = await this.tools.execute(dto.toolName, dto.input, {
      customerId: session.customerId,
      sessionId,
      storeId: session.storeId ?? undefined,
      providerCallId: dto.providerCallId,
      providerEventId: dto.providerEventId,
      eventSource: dto.eventSource ?? "browser",
      correlationId: dto.correlationId,
    }, accessToken);

    return { toolName: dto.toolName, output };
  }

  async confirmActionReview(sessionId: string, reviewId: string, accessToken?: string) {
    const row = await this.loadSession(sessionId);
    assertSessionAccess(row, accessToken);
    await this.tools.confirmActionReview(
      { sessionId, customerId: row.customer_id },
      reviewId,
    );
    return { reviewId, status: "confirmed" };
  }

  async getCurrentActionReview(sessionId: string, accessToken?: string) {
    const row = await this.loadSession(sessionId);
    assertSessionAccess(row, accessToken);
    return { review: await this.tools.currentActionReview({ sessionId, customerId: row.customer_id }) };
  }

  async cancelActionReview(sessionId: string, reviewId: string, accessToken?: string) {
    const row = await this.loadSession(sessionId);
    assertSessionAccess(row, accessToken);
    await this.tools.cancelActionReview({ sessionId, customerId: row.customer_id }, reviewId);
    return { reviewId, status: "cancelled" };
  }

  async closeSession(sessionId: string, accessToken?: string) {
    const row = await this.loadSession(sessionId);
    assertSessionAccess(row, accessToken);
    await this.tools.clearActionReviews({ sessionId, customerId: row.customer_id });
    const closed = await this.providerOperations.close(row as OperationalSessionRow);
    return { session: normalizeSession(closed as SessionRow) };
  }

  async heartbeatSession(sessionId: string, accessToken?: string) {
    const row = await this.loadSession(sessionId);
    assertSessionAccess(row, accessToken);
    const updated = await this.providerOperations.heartbeat(row as OperationalSessionRow);
    return { session: normalizeSession(updated as SessionRow) };
  }

  async disconnectSession(sessionId: string, accessToken?: string) {
    const row = await this.loadSession(sessionId);
    assertSessionAccess(row, accessToken);
    await this.tools.clearActionReviews({ sessionId, customerId: row.customer_id });
    const updated = await this.providerOperations.disconnect(row as OperationalSessionRow);
    return { session: normalizeSession(updated as SessionRow) };
  }

}

function resolveExperience(dto: CreateSessionDto): PublicExperience {
  if (dto.experience) return dto.experience;
  return "essential";
}

function hashAccessToken(token: string): string {
  return createHash("sha256").update(token).digest("base64url");
}

function assertSessionAccess(row: SessionRow, token?: string): void {
  if (!token) throw new UnauthorizedException("Session access token is required.");
  const expected = String(row.metadata?.["sessionAccessTokenHash"] || "");
  const expiresAt = Date.parse(
    String(row.metadata?.["sessionAccessExpiresAt"] || ""),
  );
  const actual = hashAccessToken(token);
  const expectedBuffer = Buffer.from(expected);
  const actualBuffer = Buffer.from(actual);
  if (
    !expected ||
    !Number.isFinite(expiresAt) ||
    expiresAt <= Date.now() ||
    expectedBuffer.length !== actualBuffer.length ||
    !timingSafeEqual(expectedBuffer, actualBuffer)
  ) {
    throw new UnauthorizedException("Session access token is invalid or expired.");
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
