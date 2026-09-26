import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { ForbiddenException, Inject, Injectable, NotFoundException, UnauthorizedException } from "@nestjs/common";
import { runtimeConfig } from "../../config/runtime-config.js";
import { DatabaseService } from "../../database/database.service.js";
import { ProviderOperationsService, type OperationalSessionRow } from "../../providers/session/provider-operations.service.js";
import { ToolRegistryService } from "../../tools/tools.service.js";
import { ExecuteToolDto } from "../../conversation/dto/execute-tool.dto.js";
import { CreateSessionResponseSchema, SessionStatusResponseSchema, type SessionDescriptor } from "../contracts/v2/sophia-runtime-v2.contracts.js";
import { V2BootstrapService } from "./v2-bootstrap.service.js";
import { sessionPlanDigest, V2SessionPlanResolver } from "./v2-session-plan.resolver.js";

type V2SessionRow = OperationalSessionRow & {
  device_id: string | null; store_id: string | null; ended_at: Date | null;
  hard_expires_at: Date; agent_release_id: string; session_plan_snapshot: Record<string, unknown>;
};

@Injectable()
export class V2SessionService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(ToolRegistryService) private readonly tools: ToolRegistryService,
    @Inject(ProviderOperationsService) private readonly operations: ProviderOperationsService,
    @Inject(V2BootstrapService) private readonly bootstrap: V2BootstrapService,
    @Inject(V2SessionPlanResolver) private readonly plans: V2SessionPlanResolver,
  ) {}

  async create(input: unknown, bootstrapToken?: string) {
    const grant = await this.bootstrap.redeem(bootstrapToken, input);
    const resolved = await this.plans.resolve(grant.customerId, grant.experienceId, grant.locale);
    assertPrivacyDefaults(resolved.profile.plan.dataPolicy);
    const config = runtimeConfig();
    const accessToken = randomBytes(32).toString("base64url");
    const accessExpiresAt = new Date(Date.now() + config.sessionAccessTtlSeconds * 1000);
    const nativeOwner = resolved.profile.plan.capabilityOwners["native-realtime"];
    const primary = resolved.profile.providers.find((provider) => provider.bindingId === nativeOwner);
    if (!primary) throw new Error("The provider bootstrap owner is missing.");
    const maximumSeconds = Math.min(config.providerSessionMaxSeconds, resolved.profile.plan.usageLimits.maximumSessionSeconds,
      primary.manifest.maxSessionDuration ?? Number.POSITIVE_INFINITY);
    const allocation = await this.operations.begin(grant.customerId, resolved.adapter.adapterKey, grant.experienceId);
    const opened = await this.operations.open(allocation, resolved.adapter, {
      experience: grant.experienceId,
      plan: resolved.profile.plan,
      customerId: grant.customerId,
      deviceId: grant.deviceId,
      storeId: grant.storeId,
      tools: this.tools.listDefinitionsForPlan(resolved.profile.plan),
      instructions: this.tools.conversationInstructions("canonical"),
    });
    let sessionId: string | undefined;
    try {
      const bootstrapId = randomUUID();
      const bootstrapExpiresAt = earliestDate(accessExpiresAt, opened.ai.expiresAt, opened.avatar.expiresAt);
      const descriptorBase = {
        experienceId: grant.experienceId,
        status: "ready" as const,
        configurationVersion: resolved.profile.experienceProfileVersionId,
        capabilities: [...new Set(resolved.profile.plan.providerBindings.map(({ capability }) => capability))],
        transports: [{
          transportId: randomUUID(),
          protocol: primary.manifest.transportAdapters[0] ?? "provider-native",
          adapterKey: primary.adapterKey,
          mediaMode: resolved.profile.plan.pipelineMode,
          toolDeliveryMode: primary.manifest.toolDeliveryModes[0] ?? "session-provisioning",
          connectionBootstrapRef: bootstrapId,
        }],
        expiresAt: new Date(Date.now() + maximumSeconds * 1000).toISOString(),
        uiHints: {},
      };
      const metadata = {
        ...opened.persistence.metadata,
        sessionAccessTokenHash: hashToken(accessToken),
        sessionAccessExpiresAt: accessExpiresAt.toISOString(),
        providerAllocationId: allocation.allocationId,
        agentReleaseDigest: resolved.agentReleaseDigest,
        v2Descriptor: descriptorBase,
      };
      const result = await this.database.tenantTransaction(grant.customerId, (client) => client.query<V2SessionRow>(
        `WITH inserted_session AS (
         INSERT INTO ${config.schema}.sessions (
           customer_id, device_id, store_id, ai_provider, avatar_provider,
           provider_session_id, avatar_session_id, status, metadata,
           last_seen_at, disconnect_expires_at, hard_expires_at,
           runtime_api_version, bootstrap_id, experience_profile_version_id,
           agent_release_id, session_plan_snapshot, session_plan_digest
         ) VALUES ($1, $2::uuid, $3, $4, $5, $6, $7, 'active', $8::jsonb,
           now(), now() + make_interval(secs => $9), now() + make_interval(secs => $10),
           'v2', $11, $12, $13, $14::jsonb, $15)
         RETURNING *
         ), privacy_defaults AS (
           INSERT INTO ${config.schema}.session_privacy_controls (session_id, customer_id)
           SELECT session_id, customer_id FROM inserted_session
           RETURNING session_id
         )
         SELECT inserted_session.* FROM inserted_session JOIN privacy_defaults USING (session_id)`,
        [grant.customerId, grant.deviceId, grant.storeId ?? null, opened.persistence.aiProvider,
          opened.persistence.avatarProvider, opened.persistence.providerSessionId,
          opened.persistence.avatarSessionId ?? null, JSON.stringify(metadata), config.disconnectGraceSeconds,
          maximumSeconds, grant.bootstrapId, resolved.profile.experienceProfileVersionId,
          resolved.agentReleaseId, JSON.stringify(resolved.profile.plan), sessionPlanDigest(resolved.profile.plan)],
      ));
      const row = result.rows[0];
      sessionId = row.session_id;
      await this.operations.attach(allocation, sessionId);
      const descriptor = descriptorFrom(row);
      return CreateSessionResponseSchema.parse({
        descriptor,
        connectionBootstrap: {
          bootstrapId,
          transportId: descriptor.transports[0].transportId,
          adapterKey: descriptor.transports[0].adapterKey,
          oneTime: true,
          expiresAt: bootstrapExpiresAt.toISOString(),
          payload: clean({ ai: opened.ai, avatar: opened.avatar, tools: opened.tools }),
        },
        sessionAccessToken: accessToken,
        sessionAccessExpiresAt: accessExpiresAt.toISOString(),
      });
    } catch (error) {
      await this.operations.compensate(allocation, resolved.adapter, opened.persistence);
      if (sessionId) await this.database.tenantTransaction(grant.customerId, (client) => client.query(
        `UPDATE ${config.schema}.sessions SET status = 'failed', ended_at = COALESCE(ended_at, now()), updated_at = now()
         WHERE session_id = $1 AND customer_id = $2 AND status = 'active'`, [sessionId, grant.customerId],
      )).catch(() => undefined);
      throw error;
    }
  }

  async get(sessionId: string, token?: string) {
    const row = await this.load(sessionId);
    assertAccess(row, token);
    return SessionStatusResponseSchema.parse({ descriptor: descriptorFrom(row) });
  }

  async executeTool(sessionId: string, dto: ExecuteToolDto, token?: string) {
    const row = await this.load(sessionId, true);
    assertAccess(row, token);
    return this.tools.executeV2(dto.toolName, dto.input, {
      customerId: row.customer_id, sessionId, storeId: row.store_id ?? undefined,
      providerCallId: dto.providerCallId, providerEventId: dto.providerEventId,
      eventSource: dto.eventSource ?? "browser", correlationId: dto.correlationId,
    }, token);
  }

  async confirmReview(sessionId: string, reviewId: string, token?: string) {
    const row = await this.load(sessionId, true);
    assertAccess(row, token);
    await this.tools.confirmActionReview({ sessionId, customerId: row.customer_id }, reviewId);
    return { reviewId, status: "confirmed" };
  }

  async close(sessionId: string, token?: string) { return this.lifecycle(sessionId, token, "close"); }
  async heartbeat(sessionId: string, token?: string) { return this.lifecycle(sessionId, token, "heartbeat"); }
  async disconnect(sessionId: string, token?: string) { return this.lifecycle(sessionId, token, "disconnect"); }

  private async lifecycle(sessionId: string, token: string | undefined, action: "close" | "heartbeat" | "disconnect") {
    const row = await this.load(sessionId);
    assertAccess(row, token);
    const updated = await this.operations[action](row);
    return SessionStatusResponseSchema.parse({ descriptor: descriptorFrom(updated as V2SessionRow) });
  }

  private async load(sessionId: string, requireUsableRelease = false): Promise<V2SessionRow> {
    const config = runtimeConfig();
    const customerId = config.defaultCustomerId;
    if (!customerId || !config.v2CanaryTenantIds.includes(customerId)) throw new ForbiddenException("Sophia Runtime v2 is not enabled.");
    const result = await this.database.tenantTransaction(customerId, (client) => client.query<V2SessionRow>(
      `SELECT s.* FROM ${config.schema}.sessions s
       ${requireUsableRelease ? `LEFT JOIN ${config.schema}.agent_release_revocations x ON x.agent_release_id = s.agent_release_id` : ""}
       WHERE s.session_id = $1 AND s.customer_id = $2 AND s.runtime_api_version = 'v2'
       ${requireUsableRelease ? "AND x.agent_release_id IS NULL" : ""}`, [sessionId, customerId],
    ));
    if (!result.rows[0]) throw new NotFoundException("Session not found or its agent release is unavailable.");
    return result.rows[0];
  }
}

function assertPrivacyDefaults(dataPolicy: { transcriptPersistence: string; audioPersistence: string }): void {
  if (dataPolicy.audioPersistence !== "disabled" || dataPolicy.transcriptPersistence === "enabled") {
    throw new ForbiddenException(
      "This experience requests recording or full transcript persistence without a session consent activation path.",
    );
  }
}

function descriptorFrom(row: V2SessionRow): SessionDescriptor {
  const stored = row.metadata?.["v2Descriptor"] as Omit<SessionDescriptor, "sessionId" | "status"> | undefined;
  if (!stored) throw new Error("The v2 session descriptor snapshot is missing.");
  const status = row.status === "active" ? "ready" : row.status === "failed" || row.status === "cleanup_pending" ? "failed" : "closed";
  return { ...stored, sessionId: row.session_id, status };
}

function assertAccess(row: V2SessionRow, token?: string) {
  if (!token) throw new UnauthorizedException("Session access token is required.");
  const expected = String(row.metadata?.["sessionAccessTokenHash"] ?? "");
  const expiresAt = Date.parse(String(row.metadata?.["sessionAccessExpiresAt"] ?? ""));
  const actual = hashToken(token);
  const left = Buffer.from(expected); const right = Buffer.from(actual);
  if (!expected || !Number.isFinite(expiresAt) || expiresAt <= Date.now() || left.length !== right.length || !timingSafeEqual(left, right)) {
    throw new UnauthorizedException("Session access token is invalid or expired.");
  }
}

function hashToken(token: string) { return createHash("sha256").update(token).digest("base64url"); }
function earliestDate(fallback: Date, ...values: Array<string | undefined>): Date {
  return new Date(Math.min(fallback.getTime(), ...values.map((value) => Date.parse(value ?? "")).filter(Number.isFinite)));
}
function clean(value: unknown): Record<string, unknown> {
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
}
