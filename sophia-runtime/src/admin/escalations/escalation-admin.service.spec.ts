import { ConflictException } from "@nestjs/common";
import { beforeEach, jest } from "@jest/globals";
import { EscalationAdminService } from "./escalation-admin.service.js";
import { EscalationPolicyConfigurationSchema } from "./escalation-admin.contracts.js";

describe("EscalationAdminService", () => {
  beforeEach(() => {
    process.env.SOPHIA_RUNTIME_DATABASE_URL = "postgres://example";
    process.env.SOPHIA_RUNTIME_SCHEMA = "sophia_runtime";
  });
  it("keeps external channels unavailable without an executable compiled adapter", () => {
    const service = new EscalationAdminService({} as never,
      { connectorManifests: () => [{ operations: [{ operationId: "handoff.request", enabled: true },
        { operationId: "handoff.status", enabled: true }] }] } as never, {} as never);
    const registry = service.channelRegistry();
    expect(registry.channels.find((channel) => channel.channel === "operations_inbox")).toMatchObject({ availability: "supported", semantics: "case_queued" });
    expect(registry.channels.find((channel) => channel.channel === "callback")).toMatchObject({ availability: "unsupported", semantics: "callback_requested" });
    expect(registry.channels.find((channel) => channel.channel === "live_transfer")).toMatchObject({ availability: "unsupported", semantics: "live_connected" });
  });

  it("rejects arbitrary policy conditions and context fields", () => {
    expect(() => EscalationPolicyConfigurationSchema.parse({
      defaultDestinationId: "00000000-0000-4000-8000-000000000001",
      rules: [{ ruleKey: "rule.one", reasonCodes: ["user_requested_human"],
        destinationId: "00000000-0000-4000-8000-000000000001", priority: "high",
        responseTargetMinutes: 30, arbitraryExpression: "execute()" }],
      contextFields: ["reason", "summary", "transcript"],
    })).toThrow();
  });

  it("does not allow assignment to regress an in-progress case", async () => {
    const query = jest.fn().mockResolvedValue({ rows: [], rowCount: 0 });
    const database = { tenantTransaction: jest.fn(async (_tenant: string, work: (client: { query: typeof query }) => unknown) =>
      work({ query })) };
    const service = new EscalationAdminService(database as never, { connectorManifests: () => [] } as never, {} as never);
    await expect(service.assignCase("00000000-0000-4000-8000-000000000001", "case", "actor", {
      assignedToIdentity: "operator", expectedRevision: 2,
    })).rejects.toBeInstanceOf(ConflictException);
    expect(String(query.mock.calls[0]?.[0])).toContain("$3 = 'assigned' AND status IN ('open', 'assigned')");
  });
});
