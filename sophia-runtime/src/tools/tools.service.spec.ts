import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import { createHash } from "node:crypto";
import type { DatabaseService } from "../database/database.service.js";
import type { ProviderCapabilityRegistry } from "../providers/capability/provider-capability.registry.js";
import type { ActionReviewStore } from "./action-review.store.js";
import type { BusinessManagerClient } from "../business-packs/real-estate/business-manager.client.js";
import { BusinessPackRegistry } from "../business-packs/business-pack.registry.js";
import { createRealEstateBusinessPack } from "../business-packs/real-estate/real-estate.pack.js";
import { ToolRegistryService } from "./tools.service.js";

const tenantId = "11111111-1111-4111-8111-111111111111";
const sessionId = "22222222-2222-4222-8222-222222222222";
const bindingId = "33333333-3333-4333-8333-333333333333";
const token = "session-secret";

describe("safe tool execution pipeline", () => {
  beforeEach(() => {
    process.env.SOPHIA_RUNTIME_DATABASE_URL = "postgresql://test:test@localhost/test";
    process.env.SOPHIA_DEFAULT_CUSTOMER_ID = tenantId;
  });

  it("publishes a real-estate catalog without quarantined tools", () => {
    const { service } = setup();
    const names = service.listDefinitions().map((tool) => tool.name);
    expect(names).toContain("searchProperties");
    expect(names).not.toContain("searchStudentAgencyKnowledge");
    expect(names).not.toContain("bookStudentConsultation");
  });

  it("boots the core catalog without the optional real-estate pack", () => {
    const database = databaseMock();
    const reviews = reviewStore();
    const providers = providerRegistry();
    const service = new ToolRegistryService(
      database as unknown as DatabaseService,
      reviews as unknown as ActionReviewStore as never,
      providers,
      new BusinessPackRegistry(),
      admission(),
    );
    expect(service.listDefinitions().map(({ name }) => name)).toEqual(["researchBusiness"]);
    expect(service.catalogVersion()).toBe("core-tools-v1");
    expect(service.conversationInstructions("canonical")).not.toMatch(/property|inspection|sale booking|rental/i);
  });

  it("publishes only canonical tools granted by the immutable v2 session plan", () => {
    const { service } = setup();
    const definitions = service.listDefinitionsForPlan({
      capabilityBindings: [{
        capabilityBindingId: bindingId, capability: "catalog", connectorKey: "test", configurationVersion: "1",
      }],
    } as never);
    const names = definitions.map(({ name }) => name);
    expect(names).toEqual(expect.arrayContaining(["catalog.search", "catalog.get", "catalog.media", "ui.dismiss"]));
    expect(names).not.toContain("booking.commit");
    expect(names).not.toContain("research.public");
    expect(names).not.toContain("searchProperties");
  });

  it("reserves shared admission with the immutable v2 session-total limit", async () => {
    const database = databaseMock({ session: sessionRow("v2") });
    const gate = { reserveToolAttempt: jest.fn().mockResolvedValue(undefined) };
    const reviews = reviewStore();
    const service = new ToolRegistryService(database as never, reviews as never, providerRegistry(),
      new BusinessPackRegistry(), gate as never);
    await expect(run(service, "unknown", {})).rejects.toThrow("approved runtime catalog");
    expect(gate.reserveToolAttempt).toHaveBeenCalledWith(expect.objectContaining({
      tenantId, sessionId, maximumSessionToolCalls: 20,
    }));
  });

  it.each(["searchStudentAgencyKnowledge", "verifyStudentRules", "bookStudentConsultation"])(
    "audits and rejects deprecated or forged tool id %s", async (name) => {
      const { service, queries } = setup();
      await expect(run(service, name, {})).rejects.toThrow("approved runtime catalog");
      const denied = queries.mock.calls.find(([sql]) => String(sql).includes("'denied'"));
      expect(denied).toBeDefined();
    },
  );

  it("derives untrusted provenance and redacts personal input in denied audit", async () => {
    const { service, queries } = setup();
    await expect(run(service, "unknownTool", { customerEmail: "private@example.com" }, {
      eventSource: "provider_sideband", providerEventId: "forged-event",
    })).rejects.toThrow();
    const insert = queries.mock.calls.find(([sql]) => String(sql).includes("'denied'"));
    expect(insert).toBeDefined();
    expect(JSON.stringify(insert?.[1])).toContain("[REDACTED]");
    expect(insert?.[1]).toEqual(expect.arrayContaining(["untrusted-client-bridge"]));
  });

  it("rejects a hidden v2 capability even when the caller forges a known tool name", async () => {
    const research = jest.fn();
    const { service, queries } = setup({
      session: sessionRow("v2", [{
        capabilityBindingId: bindingId, capability: "catalog", connectorKey: "test",
        configurationVersion: "1",
      }]),
      research,
    });
    await expect(run(service, "research.public", { businessName: "Example Co" }))
      .rejects.toThrow("not granted");
    expect(research).not.toHaveBeenCalled();
    expect(queries.mock.calls.some(([sql]) => String(sql).includes("'denied'"))).toBe(true);
  });

  it("retries a transient read only within its declared bound", async () => {
    const searchProperties = jest.fn()
      .mockRejectedValueOnce(new Error("503 temporarily unavailable"))
      .mockResolvedValueOnce({ properties: [] });
    const { service } = setup({ business: { searchProperties } });
    await expect(run(service, "searchProperties", {})).resolves.toEqual({ properties: [] });
    expect(searchProperties).toHaveBeenCalledTimes(2);
  });

  it("keeps legacy and canonical names in separate session catalogs", async () => {
    const bookInspection = jest.fn().mockResolvedValue({ status: "confirmed" });
    const database = databaseMock({ duplicateSecondAccepted: true });
    const reviews = reviewStore();
    const service = serviceWith(database, { bookInspection }, reviews);
    const input = bookingInput();

    await expect(run(service, "bookInspection", input)).resolves.toEqual({ status: "confirmed" });
    await expect(run(service, "booking.commit", input)).rejects.toThrow("not available in the v1 session catalog");

    expect(bookInspection).toHaveBeenCalledTimes(1);
    expect(reviews.consume).toHaveBeenCalledTimes(1);
  });

  it("rejects a legacy alias in a v2 session even when its capability is granted", async () => {
    const searchProperties = jest.fn();
    const { service } = setup({
      session: sessionRow("v2", [{
        capabilityBindingId: bindingId, capability: "catalog", connectorKey: "test", configurationVersion: "1",
      }]),
      business: { searchProperties },
    });
    await expect(run(service, "searchProperties", {})).rejects.toThrow("not available in the v2 session catalog");
    expect(searchProperties).not.toHaveBeenCalled();
  });

  it("does not retry an ambiguous write and audits outcome_unknown", async () => {
    const error = new Error("Tool execution timed out.");
    error.name = "ToolDeadlineError";
    const bookInspection = jest.fn().mockRejectedValue(error);
    const database = databaseMock();
    const service = serviceWith(database, { bookInspection }, reviewStore());

    await expect(run(service, "bookInspection", bookingInput())).rejects.toThrow("timed out");

    expect(bookInspection).toHaveBeenCalledTimes(1);
    const terminal = database.queries.mock.calls.find(([sql]) => String(sql).includes("outcome_class=$4"));
    expect(terminal?.[1]).toEqual(expect.arrayContaining(["outcome_unknown", "OUTCOME_UNKNOWN"]));
  });

  it.each([
    { name: "ordinary connector failure", errorName: "Error", status: "failed", outcome: "failed" },
    { name: "cancelled connector call", errorName: "AbortError", status: "cancelled", outcome: "cancelled" },
  ])("audits $name", async ({ errorName, status, outcome }) => {
    const error = new Error("connector stopped");
    error.name = errorName;
    const searchProperties = jest.fn().mockRejectedValue(error);
    const database = databaseMock();
    const service = serviceWith(database, { searchProperties }, reviewStore());

    await expect(run(service, "searchProperties", {})).rejects.toThrow("connector stopped");

    const terminal = database.queries.mock.calls.find(([sql]) => String(sql).includes("outcome_class=$4"));
    expect(terminal?.[1]).toEqual(expect.arrayContaining([status, outcome]));
  });

  it("returns the canonical v2 result shape after binding enforcement", async () => {
    const searchProperties = jest.fn().mockResolvedValue({ properties: [] });
    const database = databaseMock({ session: sessionRow("v2", [{
      capabilityBindingId: bindingId, capability: "catalog", connectorKey: "test", configurationVersion: "1",
    }]) });
    const service = serviceWith(database, { searchProperties }, reviewStore());

    await expect(service.executeV2(
      "catalog.search", {}, { customerId: tenantId, sessionId }, token,
    )).resolves.toMatchObject({
      toolId: "catalog.search", status: "succeeded", capability: "catalog",
      data: { properties: [] },
    });
  });

  it("blocks a new v2 mutation immediately when its connector is disconnecting", async () => {
    const bookInspection = jest.fn();
    const database = databaseMock({
      session: sessionRow("v2", [{
        capabilityBindingId: bindingId, capability: "booking", connectorKey: "test", configurationVersion: "1",
      }]),
      bindingAuthority: { enabled: true, connector_binding_id: "44444444-4444-4444-8444-444444444444", connector_status: "disconnecting" },
    });
    const reviews = reviewStore();
    const service = serviceWith(database, { bookInspection }, reviews);
    await expect(run(service, "booking.commit", bookingInput())).rejects.toThrow("Connector binding is unavailable");
    expect(bookInspection).not.toHaveBeenCalled();
    expect(reviews.consume).not.toHaveBeenCalled();
  });

  it("returns a canonical denied result for a forged v2 tool outside the binding grant", async () => {
    const database = databaseMock({ session: sessionRow("v2", [{
      capabilityBindingId: bindingId, capability: "catalog", connectorKey: "test", configurationVersion: "1",
    }]) });
    const service = serviceWith(database, {}, reviewStore());

    await expect(service.executeV2(
      "research.public", { businessName: "Example Co" }, { customerId: tenantId, sessionId }, token,
    )).resolves.toMatchObject({
      toolId: "research.public",
      status: "denied",
      capability: "research",
      error: { code: "FORBIDDEN", retryable: false },
    });
  });

  it("deduplicates browser and provider observations under one execution owner", async () => {
    const database = databaseMock({ duplicateSecondAccepted: true });
    const research = jest.fn().mockResolvedValue({ status: "ok" });
    const service = serviceWith(database, {}, reviewStore(), research);
    const context = { providerCallId: "event-1", eventSource: "browser" as const };
    await run(service, "researchBusiness", { businessName: "Example Co" }, context);
    await expect(run(service, "researchBusiness", { businessName: "Example Co" }, {
      providerEventId: "event-1", eventSource: "provider_sideband",
    })).resolves.toEqual({ status: "ok" });
    expect(research).toHaveBeenCalledTimes(1);
  });
});

function setup(input: {
  session?: ReturnType<typeof sessionRow>;
  business?: Record<string, unknown>;
  research?: jest.Mock;
} = {}) {
  const database = databaseMock({ session: input.session });
  const service = serviceWith(database, input.business ?? {}, reviewStore(), input.research);
  return { service, queries: database.queries };
}

function serviceWith(
  database: ReturnType<typeof databaseMock>,
  business: Record<string, unknown>,
  reviews: ReturnType<typeof reviewStore>,
  research = jest.fn().mockResolvedValue({ status: "ok" }),
) {
  const providers = providerRegistry(research);
  const packs = new BusinessPackRegistry([
    createRealEstateBusinessPack(
      business as unknown as BusinessManagerClient,
      reviews as unknown as ActionReviewStore,
      {} as never,
    ),
  ]);
  return new ToolRegistryService(
    database as unknown as DatabaseService,
    reviews as unknown as ActionReviewStore as never,
    providers,
    packs,
    admission(),
  );
}

function admission() {
  return { reserveToolAttempt: jest.fn().mockResolvedValue(undefined) } as never;
}

function providerRegistry(research = jest.fn().mockResolvedValue({ status: "ok" })) {
  return { resolve: jest.fn().mockReturnValue({ implementation: { research } }) } as unknown as ProviderCapabilityRegistry;
}

function databaseMock(options: {
  session?: ReturnType<typeof sessionRow>;
  duplicateSecondAccepted?: boolean;
  bindingAuthority?: { enabled: boolean; connector_binding_id: string | null; connector_status: string | null };
} = {}) {
  let acceptedInserts = 0;
  let completedOutput: unknown = { status: "ok" };
  const queries = jest.fn(async (sql: string, params?: unknown[]) => {
    if (sql.includes("SELECT s.*")) return { rows: [options.session ?? sessionRow("v1")], rowCount: 1 };
    if (sql.includes("SELECT b.enabled, b.connector_binding_id")) {
      return { rows: [options.bindingAuthority ?? { enabled: true, connector_binding_id: null, connector_status: null }], rowCount: 1 };
    }
    if (sql.includes("ON CONFLICT DO NOTHING")) {
      acceptedInserts += 1;
      if (options.duplicateSecondAccepted && acceptedInserts > 1) return { rows: [], rowCount: 0 };
      return { rows: [{ tool_call_id: "call-1" }], rowCount: 1 };
    }
    if (sql.includes("SELECT invocation_id, status, output")) {
      return { rows: [{ invocation_id: "existing-call", status: "succeeded", output: completedOutput }], rowCount: 1 };
    }
    if (sql.includes("outcome_class='success'")) {
      completedOutput = params?.[1] ? JSON.parse(String(params[1])) : null;
    }
    return { rows: [{ tool_call_id: "call-1" }], rowCount: 1 };
  });
  return {
    queries,
    tenantTransaction: jest.fn((_tenant: string, work: (client: { query: typeof queries }) => unknown) => work({ query: queries })),
  };
}

function sessionRow(version: "v1" | "v2", capabilityBindings: unknown[] = []) {
  return {
    session_id: sessionId,
    customer_id: tenantId,
    store_id: "store-1",
    status: "active",
    runtime_api_version: version,
    metadata: {
      sessionAccessTokenHash: createHash("sha256").update(token).digest("base64url"),
      sessionAccessExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    },
    hard_expires_at: new Date(Date.now() + 60_000),
    session_plan_snapshot: version === "v2" ? { capabilityBindings, usageLimits: { maximumToolCalls: 20 } } : null,
    agent_release_id: version === "v2" ? "release-1" : null,
    release_revoked: false,
  };
}

function reviewStore() {
  return {
    create: jest.fn(), current: jest.fn(), confirm: jest.fn(), cancel: jest.fn(), clear: jest.fn(),
    consume: jest.fn().mockResolvedValue("44444444-4444-4444-8444-444444444444"),
  };
}

function run(service: ToolRegistryService, name: string, input: unknown, extra: Record<string, unknown> = {}) {
  return service.execute(name, input, { customerId: tenantId, sessionId, ...extra }, token);
}

function bookingInput() {
  return {
    reviewId: "55555555-5555-4555-8555-555555555555",
    propertyId: "66666666-6666-4666-8666-666666666666",
    slotId: "77777777-7777-4777-8777-777777777777",
    confirmedStartsAt: "2026-10-01T10:00:00+10:00",
    propertyAddress: "1 Example Street, Brisbane",
    startsAtLabel: "Thursday, 1 October at 10:00 am",
    customerName: "Jane Example",
    customerEmail: "jane@example.com",
    confirmed: true,
  };
}
