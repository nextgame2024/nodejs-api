import {
  SessionDescriptorSchema,
  SessionStatusResponseSchema,
  V2CreateSessionRequestSchema,
  type CreateSessionResponse,
  type SessionDescriptor,
  type SessionStatusResponse,
  type V2CreateSessionRequest,
} from "../../platform/contracts/v2/sophia-runtime-v2.contracts.js";

type LegacyCreateRequest = {
  experience?: unknown;
  locale?: unknown;
  browserCapabilities?: unknown;
  [key: string]: unknown;
};

type LegacySession = {
  sessionId: string;
  status: string;
};

type LegacyCreatedSession = {
  session: LegacySession;
  ai?: Record<string, unknown>;
  avatar?: Record<string, unknown>;
  tools?: unknown[];
  sessionAccessToken: string;
  sessionAccessExpiresAt: string;
};

export type V1TranslationContext = {
  deviceId: string;
  experienceId: string;
  configurationVersion: string;
  capabilities: string[];
  sessionExpiresAt: string;
  uiHints?: SessionDescriptor["uiHints"];
};

/**
 * Keeps the permissive v1 wire shape at the compatibility edge. Tenant,
 * company and provider fields are deliberately not copied into the v2 input.
 */
export function translateV1CreateRequest(
  legacy: LegacyCreateRequest,
  context: Pick<V1TranslationContext, "deviceId" | "experienceId">,
): V2CreateSessionRequest {
  return V2CreateSessionRequestSchema.parse({
    experienceId:
      typeof legacy.experience === "string"
        ? legacy.experience
        : context.experienceId,
    deviceId: context.deviceId,
    ...(typeof legacy.locale === "string" ? { locale: legacy.locale } : {}),
    ...(Array.isArray(legacy.browserCapabilities)
      ? { browserCapabilities: legacy.browserCapabilities }
      : {}),
  });
}

export function translateV1CreatedSession(
  legacy: LegacyCreatedSession,
  context: V1TranslationContext,
): CreateSessionResponse {
  const transportId = `legacy-v1:${legacy.session.sessionId}`;
  const descriptor = makeDescriptor(legacy.session, context, transportId);
  return {
    descriptor,
    connectionBootstrap: {
      bootstrapId: `legacy-v1-bootstrap:${legacy.session.sessionId}`,
      transportId,
      adapterKey: "legacy-v1-session-bridge",
      oneTime: true,
      expiresAt: legacy.sessionAccessExpiresAt,
      payload: {
        ...(legacy.ai ? { ai: legacy.ai } : {}),
        ...(legacy.avatar ? { avatar: legacy.avatar } : {}),
        ...(legacy.tools ? { tools: legacy.tools } : {}),
      },
    },
    sessionAccessToken: legacy.sessionAccessToken,
    sessionAccessExpiresAt: legacy.sessionAccessExpiresAt,
  };
}

/** Safe status translation intentionally has no credential/bootstrap input. */
export function translateV1SessionStatus(
  legacy: { session: LegacySession },
  context: V1TranslationContext,
): SessionStatusResponse {
  const transportId = `legacy-v1:${legacy.session.sessionId}`;
  return SessionStatusResponseSchema.parse({
    descriptor: makeDescriptor(legacy.session, context, transportId),
  });
}

function makeDescriptor(
  session: LegacySession,
  context: V1TranslationContext,
  transportId: string,
): SessionDescriptor {
  return SessionDescriptorSchema.parse({
    sessionId: session.sessionId,
    experienceId: context.experienceId,
    status: normalizeStatus(session.status),
    configurationVersion: context.configurationVersion,
    capabilities: context.capabilities,
    transports: [{
      transportId,
      protocol: "legacy-v1",
      adapterKey: "legacy-v1-session-bridge",
      mediaMode: "legacy-managed",
      toolDeliveryMode: "legacy-v1",
      connectionBootstrapRef: `legacy-v1-bootstrap:${session.sessionId}`,
    }],
    expiresAt: context.sessionExpiresAt,
    uiHints: context.uiHints ?? {},
  });
}

function normalizeStatus(status: string): SessionDescriptor["status"] {
  if (status === "closed") return "closed";
  if (status === "failed") return "failed";
  if (status === "created") return "starting";
  return "ready";
}
