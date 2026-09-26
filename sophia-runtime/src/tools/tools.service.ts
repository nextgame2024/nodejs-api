import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, UnauthorizedException } from "@nestjs/common";
import { z } from "zod";
import { runtimeConfig } from "../config/runtime-config.js";
import { DatabaseService } from "../database/database.service.js";
import type { SessionPlan, ToolResult } from "../platform/contracts/v2/sophia-runtime-v2.contracts.js";
import { ToolResultSchema } from "../platform/contracts/v2/sophia-runtime-v2.contracts.js";
import { ProviderCapabilityRegistry } from "../providers/capability/provider-capability.registry.js";
import { PostgresActionReviewStore } from "./action-review.store.js";
import { BusinessPackRegistry } from "../business-packs/business-pack.registry.js";
import { sophiaConversationInstructions } from "../knowledge/sophia-profile.js";
import { createResearchBusinessTool, type BusinessResearchCapability } from "./research/research-business.tool.js";
import { minimiseToolOutput } from "./tool-policy.js";
import { ToolRegistry, type RuntimeTool, type RuntimeToolContext, type RuntimeToolDefinition, type RuntimeToolPolicy } from "./tool-registry.js";
import { AdmissionLimitExceededException, RuntimeAdmissionService } from "../platform/admission/runtime-admission.service.js";

type SessionRow = {
  session_id: string;
  customer_id: string;
  store_id: string | null;
  status: string;
  runtime_api_version: "v1" | "v2";
  metadata: Record<string, unknown>;
  hard_expires_at: Date | null;
  session_plan_snapshot: SessionPlan | null;
  agent_release_id: string | null;
  release_revoked: boolean;
  agent_release_manifest: unknown | null;
};

type DispatchResult = { invocationId: string; policy: RuntimeToolPolicy; output: unknown };

@Injectable()
export class ToolRegistryService {
  private readonly registry = new ToolRegistry();

  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(PostgresActionReviewStore) private readonly actionReviews: PostgresActionReviewStore,
    @Inject(ProviderCapabilityRegistry) providerCapabilities: ProviderCapabilityRegistry,
    @Inject(BusinessPackRegistry) private readonly businessPacks: BusinessPackRegistry,
    @Inject(RuntimeAdmissionService) private readonly admission: RuntimeAdmissionService,
  ) {
    for (const tool of businessPacks.tools()) this.registry.register(tool);
    const research = providerCapabilities.resolve<BusinessResearchCapability>("business-research-v1", "research").implementation;
    this.registry.register(createResearchBusinessTool(research));
  }

  listDefinitions(): RuntimeToolDefinition[] { return this.registry.listDefinitions(); }

  listDefinitionsForMode(mode: "canonical" | "legacy"): RuntimeToolDefinition[] {
    return mode === "legacy"
      ? this.registry.listDefinitions()
      : this.registry.listDefinitionsForCapabilities(
          new Set(this.registry.listPolicies().map(({ requiredCapability }) => requiredCapability)),
          true,
        );
  }

  listDefinitionsForPlan(plan: SessionPlan): RuntimeToolDefinition[] {
    const capabilities = new Set(plan.capabilityBindings.map(({ capability }) => capability));
    capabilities.add("presentation");
    return this.registry.listDefinitionsForCapabilities(capabilities, true);
  }

  catalogVersion(): string { return this.businessPacks.catalogVersion(); }

  conversationInstructions(mode: "canonical" | "legacy"): string {
    return sophiaConversationInstructions(this.businessPacks.instructions(mode));
  }

  async execute(name: string, input: unknown, context: RuntimeToolContext, sessionAccessToken?: string): Promise<unknown> {
    return (await this.dispatch(name, input, context, sessionAccessToken)).output;
  }

  async executeV2(name: string, input: unknown, context: RuntimeToolContext, sessionAccessToken?: string): Promise<ToolResult> {
    try {
      const result = await this.dispatch(name, input, context, sessionAccessToken);
      const data = result.output && typeof result.output === "object" && !Array.isArray(result.output)
        ? result.output as Record<string, unknown> : { value: result.output };
      return ToolResultSchema.parse({
        toolCallId: result.invocationId, toolId: result.policy.toolId, status: "succeeded",
        capability: result.policy.requiredCapability, data,
      });
    } catch (error) {
      if (error instanceof AdmissionLimitExceededException) throw error;
      const policy = this.registry.resolve(name)?.policy;
      const failure = classifyFailure(error, policy);
      const status = failure.status === "outcome_unknown" ? "outcome_unknown"
        : failure.status === "denied" ? "denied"
          : failure.status === "cancelled" ? "cancelled" : "failed";
      return ToolResultSchema.parse({
        toolCallId: invocationFrom(error) ?? randomUUID(),
        toolId: policy?.toolId ?? name,
        status,
        capability: policy?.requiredCapability ?? "unknown",
        error: {
          code: canonicalErrorCode(error, failure),
          safeMessage: failure.message,
          retryable: policy?.retryPolicy === "safe-read" && failure.status !== "denied",
          correlationId: context.correlationId ?? randomUUID(),
        },
      });
    }
  }

  confirmActionReview(context: { sessionId: string; customerId: string }, reviewId: string) {
    return this.actionReviews.confirm(context, reviewId);
  }

  currentActionReview(context: { sessionId: string; customerId: string }) {
    return this.actionReviews.current(context);
  }

  cancelActionReview(context: { sessionId: string; customerId: string }, reviewId: string) {
    return this.actionReviews.cancel(context, reviewId);
  }

  clearActionReviews(context: { sessionId: string; customerId: string }) {
    return this.actionReviews.clear(context);
  }

  private async dispatch(requestedName: string, input: unknown, callerContext: RuntimeToolContext, sessionAccessToken?: string): Promise<DispatchResult> {
    if (!callerContext.sessionId) throw new UnauthorizedException("An authenticated session is required for tool execution.");
    const config = runtimeConfig();
    const tenantId = config.defaultCustomerId ?? callerContext.customerId;
    const session = await this.loadSession(tenantId, callerContext.sessionId);
    assertSessionAccess(session, sessionAccessToken);

    const invocationId = randomUUID();
    const correlationId = callerContext.correlationId || randomUUID();
    const providerEventId = callerContext.providerCallId ?? callerContext.providerEventId;
    const deduplicationKey = providerEventId ? `provider:${providerEventId}` : null;
    const sessionTotalLimit = session.runtime_api_version === "v2"
      ? session.session_plan_snapshot?.usageLimits?.maximumToolCalls ?? 0 : null;
    await this.admission.reserveToolAttempt({ tenantId, sessionId: session.session_id, invocationId,
      deduplicationKey, maximumSessionToolCalls: sessionTotalLimit });
    const provenance = callerContext.provenance ?? "untrusted-client-bridge";
    const startedAt = Date.now();
    const tool = this.registry.resolve(requestedName);
    const policy = tool?.policy;
    const deadlineAt = new Date(startedAt + (policy?.timeoutMs ?? 5_000));
    let parsedInput: unknown = input;
    let capabilityBindingId: string | undefined;
    let commandId: string | undefined;

    try {
      if (!tool || !policy || !tool.outputSchema) throw new ForbiddenException("This tool is not in the approved runtime catalog.");
      assertCatalogName(session.runtime_api_version, requestedName, tool);
      parsedInput = tool.inputSchema.parse(input);
      capabilityBindingId = resolveCapabilityGrant(session, policy);
      if (capabilityBindingId) {
        await this.assertCapabilityBindingAvailable(tenantId, capabilityBindingId, policy);
      }
      if (policy.confirmationPolicy === "explicit-user-review") {
        if (!tool.reviewAuthorization) throw new Error(`Tool ${policy.toolId} is missing its review authorisation binding.`);
        commandId = await this.actionReviews.consume(
          { sessionId: session.session_id, customerId: session.customer_id }, reviewIdFrom(parsedInput),
          tool.reviewAuthorization.mode, tool.reviewAuthorization.payload(parsedInput),
        );
      }
    } catch (error) {
      await this.recordDenied({ tenantId, session, invocationId, correlationId, requestedName, input,
        policy, capabilityBindingId, provenance, deadlineAt, error });
      throw attachInvocation(error, invocationId);
    }

    const accepted = await this.insertAccepted({ tenantId, session, invocationId, correlationId, requestedName,
      input, policy, capabilityBindingId, commandId, provenance, providerEventId, deduplicationKey, deadlineAt });
    if (!accepted) {
      const existing = await this.findDuplicate(tenantId, session.session_id, policy.toolId, commandId, deduplicationKey);
      if (existing?.status === "succeeded") return { invocationId: existing.invocation_id, policy, output: existing.output };
      if (existing?.status === "outcome_unknown" || existing?.status === "unknown") {
        throw attachInvocation(new ConflictException("The command outcome is unknown and must be reconciled; it was not retried."), existing.invocation_id);
      }
      throw attachInvocation(new ConflictException("This tool call is already being processed or has completed."), existing?.invocation_id ?? invocationId);
    }

    const context: RuntimeToolContext = {
      customerId: session.customer_id, sessionId: session.session_id, storeId: session.store_id ?? undefined,
      providerCallId: callerContext.providerCallId, providerEventId: callerContext.providerEventId,
      eventSource: callerContext.eventSource, correlationId, capabilityBindingId, commandId, provenance,
      workflowVersions: workflowVersions(session),
    };
    const maximumAttempts = policy.retryPolicy === "safe-read" ? 2 : 1;
    let attempts = 0;
    try {
      let output: unknown;
      while (attempts < maximumAttempts) {
        attempts += 1;
        await this.markExecuting(tenantId, invocationId, attempts);
        try {
          output = await executeWithDeadline(tool, parsedInput, context, deadlineAt, maximumAttempts - attempts + 1);
          break;
        } catch (error) {
          if (attempts >= maximumAttempts || !isRetryableReadFailure(error, policy)) throw error;
        }
      }
      const validated = tool.outputSchema.parse(output);
      const minimised = minimiseToolOutput(validated);
      await this.complete(tenantId, invocationId, minimised, attempts, startedAt);
      return { invocationId, policy, output: minimised };
    } catch (error) {
      const failure = classifyFailure(error, policy);
      await this.fail(tenantId, invocationId, failure, attempts, startedAt);
      throw attachInvocation(error, invocationId);
    }
  }

  private async loadSession(tenantId: string, sessionId: string): Promise<SessionRow> {
    const config = runtimeConfig();
    const result = await this.database.tenantTransaction(tenantId, (client) => client.query<SessionRow>(
      `SELECT s.*, (x.agent_release_id IS NOT NULL) AS release_revoked,
              r.manifest AS agent_release_manifest
       FROM ${config.schema}.sessions s
       LEFT JOIN ${config.schema}.agent_release_manifests r ON r.agent_release_id = s.agent_release_id
       LEFT JOIN ${config.schema}.agent_release_revocations x ON x.agent_release_id = s.agent_release_id
       WHERE s.session_id = $1 AND s.customer_id = $2`, [sessionId, tenantId],
    ));
    const session = result.rows[0];
    if (!session || session.status !== "active" || (session.hard_expires_at && new Date(session.hard_expires_at).getTime() <= Date.now())) {
      throw new UnauthorizedException("The Sophia session is unavailable or expired.");
    }
    if (session.runtime_api_version === "v2" && session.release_revoked) throw new ForbiddenException("The session's agent release has been revoked.");
    return session;
  }

  private async assertCapabilityBindingAvailable(
    tenantId: string,
    capabilityBindingId: string,
    policy: RuntimeToolPolicy,
  ): Promise<void> {
    const schema = runtimeConfig().schema;
    const result = await this.database.tenantTransaction(tenantId, (client) => client.query<{
      enabled: boolean; connector_binding_id: string | null; connector_status: string | null;
    }>(
      `SELECT b.enabled, b.connector_binding_id, c.status AS connector_status
       FROM ${schema}.capability_bindings b
       JOIN ${schema}.business_profile_versions v ON v.business_profile_version_id = b.business_profile_version_id
       JOIN ${schema}.business_profiles p ON p.business_profile_id = v.business_profile_id
       LEFT JOIN ${schema}.connector_bindings c ON c.connector_binding_id = b.connector_binding_id
       WHERE b.capability_binding_id = $1 AND p.customer_id = $2`,
      [capabilityBindingId, tenantId],
    ));
    const binding = result.rows[0];
    if (!binding?.enabled) throw new ForbiddenException("Capability binding is disabled or unavailable.");
    if (!binding.connector_binding_id) return; // Compatibility window for pre-P3-A02 published bindings.
    if (binding.connector_status === "active") return;
    if (binding.connector_status === "disconnecting" && policy.retryPolicy === "safe-read") return;
    throw new ForbiddenException("Connector binding is unavailable for this operation.");
  }

  private async recordDenied(input: AuditInput & { error: unknown }): Promise<void> {
    const config = runtimeConfig();
    const failure = classifyFailure(input.error, input.policy);
    await this.database.tenantTransaction(input.tenantId, (client) => client.query(
      `INSERT INTO ${config.schema}.tool_calls (
         invocation_id, correlation_id, session_id, customer_id, tool_name, canonical_tool_id,
         tool_version, capability_binding_id, status, input, event_source, execution_owner,
         policy_decision, provenance, deadline_at, error_code, error_message, outcome_class,
         accepted_at, completed_at, duration_ms
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'denied',$9::jsonb,$10,'sophia-runtime','deny',$11,$12,$13,$14,'denied',now(),now(),0)`,
      [input.invocationId, input.correlationId, input.session.session_id, input.session.customer_id,
        input.requestedName, input.policy?.toolId ?? null, input.policy?.version ?? null,
        input.capabilityBindingId ?? null, JSON.stringify(redactPayload(input.input ?? {})),
        auditEventSource(input.provenance), input.provenance, input.deadlineAt, failure.errorCode, failure.message],
    ));
  }

  private async insertAccepted(input: AuditInput & { commandId?: string; providerEventId?: string; deduplicationKey: string | null }): Promise<boolean> {
    const config = runtimeConfig();
    const result = await this.database.tenantTransaction(input.tenantId, (client) => client.query(
      `INSERT INTO ${config.schema}.tool_calls (
         invocation_id, correlation_id, session_id, customer_id, tool_name, canonical_tool_id,
         tool_version, capability_binding_id, command_id, status, input, provider_call_id,
         provider_event_id, event_source, deduplication_key, execution_owner, policy_decision,
         provenance, deadline_at, accepted_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'accepted',$10::jsonb,$11,$12,$13,$14,
         'sophia-runtime','allow',$15,$16,now()) ON CONFLICT DO NOTHING RETURNING tool_call_id`,
      [input.invocationId, input.correlationId, input.session.session_id, input.session.customer_id,
        input.requestedName, input.policy!.toolId, input.policy!.version, input.capabilityBindingId ?? null,
        input.commandId ?? null, JSON.stringify(redactPayload(input.input ?? {})), input.providerEventId ?? null,
        input.providerEventId ?? null, auditEventSource(input.provenance), input.deduplicationKey, input.provenance, input.deadlineAt],
    ));
    return result.rowCount === 1 || result.rows.length === 1;
  }

  private async findDuplicate(tenantId: string, sessionId: string, toolId: string, commandId?: string, dedupe?: string | null) {
    const config = runtimeConfig();
    const result = await this.database.tenantTransaction(tenantId, (client) => client.query<{
      invocation_id: string; status: string; output: unknown;
    }>(
      `SELECT invocation_id, status, output FROM ${config.schema}.tool_calls
       WHERE session_id=$1 AND (($2::text IS NOT NULL AND deduplication_key=$2)
         OR ($3::uuid IS NOT NULL AND command_id=$3 AND canonical_tool_id=$4))
       ORDER BY created_at DESC LIMIT 1`, [sessionId, dedupe ?? null, commandId ?? null, toolId],
    ));
    return result.rows[0];
  }

  private markExecuting(tenantId: string, invocationId: string, attempts: number) {
    const config = runtimeConfig();
    return this.database.tenantTransaction(tenantId, (client) => client.query(
      `UPDATE ${config.schema}.tool_calls SET status='executing', executing_at=COALESCE(executing_at,now()),
         attempt_count=$2 WHERE invocation_id=$1`, [invocationId, attempts],
    ));
  }

  private complete(tenantId: string, invocationId: string, output: unknown, attempts: number, startedAt: number) {
    const config = runtimeConfig();
    return this.database.tenantTransaction(tenantId, (client) => client.query(
      `UPDATE ${config.schema}.tool_calls SET status='succeeded', policy_decision='allow', outcome_class='success',
         output=$2::jsonb, attempt_count=$3, completed_at=now(), duration_ms=$4 WHERE invocation_id=$1`,
      [invocationId, JSON.stringify(redactPayload(output)), attempts, Date.now() - startedAt],
    ));
  }

  private fail(tenantId: string, invocationId: string, failure: Failure, attempts: number, startedAt: number) {
    const config = runtimeConfig();
    return this.database.tenantTransaction(tenantId, (client) => client.query(
      `UPDATE ${config.schema}.tool_calls SET status=$2, policy_decision=$3, outcome_class=$4,
         error_code=$5, error_message=$6, attempt_count=$7, completed_at=now(), duration_ms=$8 WHERE invocation_id=$1`,
      [invocationId, failure.status, failure.policyDecision, failure.outcomeClass,
        failure.errorCode, failure.message, attempts, Date.now() - startedAt],
    ));
  }
}

function workflowVersions(session: SessionRow): readonly { templateKey: string; workflowVersionId: string }[] {
  if (session.runtime_api_version !== "v2" || !session.agent_release_manifest ||
      typeof session.agent_release_manifest !== "object") return [];
  const bindings = (session.agent_release_manifest as { workflowBindings?: unknown }).workflowBindings;
  if (!Array.isArray(bindings)) return [];
  return bindings.flatMap((binding) => {
    if (!binding || typeof binding !== "object") return [];
    const value = binding as Record<string, unknown>;
    return typeof value["templateKey"] === "string" && typeof value["workflowVersionId"] === "string"
      ? [{ templateKey: value["templateKey"], workflowVersionId: value["workflowVersionId"] }] : [];
  });
}

function assertCatalogName(version: "v1" | "v2", requestedName: string, tool: RuntimeTool<unknown, unknown>): void {
  const expected = version === "v2" ? tool.policy!.toolId : tool.definition.name;
  if (requestedName !== expected) {
    throw new ForbiddenException(`Tool name is not available in the ${version} session catalog.`);
  }
}

type AuditInput = {
  tenantId: string; session: SessionRow; invocationId: string; correlationId: string;
  requestedName: string; input: unknown; policy?: RuntimeToolPolicy; capabilityBindingId?: string;
  provenance: RuntimeToolContext["provenance"]; deadlineAt: Date;
};

type Failure = {
  status: "failed" | "denied" | "timed_out" | "cancelled" | "outcome_unknown";
  policyDecision: "allow" | "deny";
  outcomeClass: "denied" | "failed" | "cancelled" | "outcome_unknown";
  errorCode: string;
  message: string;
};

function auditEventSource(provenance: RuntimeToolContext["provenance"]): "browser" | "provider_sideband" {
  return provenance === "server-provider-connection" || provenance === "verified-provider-webhook"
    ? "provider_sideband"
    : "browser";
}

function resolveCapabilityGrant(session: SessionRow, policy: RuntimeToolPolicy): string | undefined {
  if (session.runtime_api_version === "v1") return undefined;
  if (policy.requiredCapability === "presentation") return undefined;
  const binding = session.session_plan_snapshot?.capabilityBindings.find((candidate) => candidate.capability === policy.requiredCapability);
  if (!binding) throw new ForbiddenException(`Capability ${policy.requiredCapability} is not granted to this session.`);
  return binding.capabilityBindingId;
}

function reviewIdFrom(input: unknown): string {
  if (!input || typeof input !== "object" || typeof (input as Record<string, unknown>)["reviewId"] !== "string") {
    throw new BadRequestException("A reviewed command requires reviewId.");
  }
  return z.string().uuid().parse((input as Record<string, unknown>)["reviewId"]);
}

function assertSessionAccess(session: SessionRow, token?: string): void {
  if (!token) throw new UnauthorizedException("Session access token is required.");
  const expected = String(session.metadata?.["sessionAccessTokenHash"] ?? "");
  const expiresAt = Date.parse(String(session.metadata?.["sessionAccessExpiresAt"] ?? ""));
  const actual = createHash("sha256").update(token).digest("base64url");
  const left = Buffer.from(expected); const right = Buffer.from(actual);
  if (!expected || !Number.isFinite(expiresAt) || expiresAt <= Date.now() || left.length !== right.length || !timingSafeEqual(left, right)) {
    throw new UnauthorizedException("Session access token is invalid or expired.");
  }
}

async function executeWithDeadline(tool: RuntimeTool<unknown, unknown>, input: unknown, context: RuntimeToolContext, deadlineAt: Date, remainingAttempts: number): Promise<unknown> {
  const remaining = deadlineAt.getTime() - Date.now();
  if (remaining <= 0) throw new ToolDeadlineError();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1, Math.floor(remaining / remainingAttempts)));
  try {
    return await Promise.race([
      tool.execute(input, { ...context, abortSignal: controller.signal }),
      new Promise<never>((_, reject) => controller.signal.addEventListener("abort", () => reject(new ToolDeadlineError()), { once: true })),
    ]);
  } finally { clearTimeout(timer); }
}

class ToolDeadlineError extends Error {
  constructor() { super("Tool execution timed out."); this.name = "ToolDeadlineError"; }
}

function isRetryableReadFailure(error: unknown, policy: RuntimeToolPolicy): boolean {
  if (policy.retryPolicy !== "safe-read") return false;
  const message = error instanceof Error ? `${error.name} ${error.message}` : String(error);
  return /ToolDeadlineError|timeout|timed out|ECONNRESET|ETIMEDOUT|temporar|\b(?:429|502|503|504)\b/i.test(message);
}

function classifyFailure(error: unknown, policy?: RuntimeToolPolicy): Failure {
  const message = safeError(error);
  if (error instanceof ForbiddenException || error instanceof BadRequestException || error instanceof z.ZodError || /unknown runtime tool|not granted|review/i.test(message)) {
    return { status: "denied", policyDecision: "deny", outcomeClass: "denied", errorCode: "TOOL_NOT_ALLOWED", message };
  }
  if (error instanceof ToolDeadlineError || (error instanceof Error && error.name === "ToolDeadlineError")) {
    if (policy && ["business-mutation", "notification", "handoff"].includes(policy.sideEffectClass)) {
      return { status: "outcome_unknown", policyDecision: "allow", outcomeClass: "outcome_unknown", errorCode: "OUTCOME_UNKNOWN", message };
    }
    return { status: "timed_out", policyDecision: "allow", outcomeClass: "failed", errorCode: "TOOL_TIMEOUT", message };
  }
  if (error instanceof Error && error.name === "AbortError") {
    return { status: "cancelled", policyDecision: "allow", outcomeClass: "cancelled", errorCode: "TOOL_CANCELLED", message };
  }
  return { status: "failed", policyDecision: "allow", outcomeClass: "failed", errorCode: "TOOL_FAILED", message };
}

function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : "Tool execution failed.";
  return message.replace(/[\r\n\t]+/g, " ").slice(0, 1_000);
}

function redactPayload(value: unknown, key = ""): unknown {
  if (/email|phone|token|secret|password|authorization|audio|transcript/i.test(key)) return "[REDACTED]";
  if (Array.isArray(value)) return value.map((item) => redactPayload(item));
  if (value && typeof value === "object") return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([childKey, childValue]) => [childKey, redactPayload(childValue, childKey)]),
  );
  return value;
}

function attachInvocation(error: unknown, invocationId: string): Error & { toolInvocationId?: string } {
  const target = (error instanceof Error ? error : new Error(safeError(error))) as Error & { toolInvocationId?: string };
  target.toolInvocationId = invocationId;
  return target;
}

function invocationFrom(error: unknown): string | undefined {
  return error instanceof Error && "toolInvocationId" in error
    ? String((error as Error & { toolInvocationId?: string }).toolInvocationId ?? "") || undefined
    : undefined;
}

function canonicalErrorCode(error: unknown, failure: Failure): "UNAUTHENTICATED" | "FORBIDDEN" | "INVALID_INPUT" | "OUTCOME_UNKNOWN" | "CONFLICT" | "PROVIDER_UNAVAILABLE" {
  if (error instanceof UnauthorizedException) return "UNAUTHENTICATED";
  if (error instanceof z.ZodError || error instanceof BadRequestException) return "INVALID_INPUT";
  if (failure.errorCode === "OUTCOME_UNKNOWN") return "OUTCOME_UNKNOWN";
  if (error instanceof ConflictException) return "CONFLICT";
  if (failure.policyDecision === "deny") return "FORBIDDEN";
  return "PROVIDER_UNAVAILABLE";
}
