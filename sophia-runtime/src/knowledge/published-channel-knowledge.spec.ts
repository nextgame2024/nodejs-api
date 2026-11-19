import { jest, describe, it, expect, beforeEach } from "@jest/globals";
import { publishedChannelKnowledge } from "./published-channel-knowledge.js";
const tenant = "11111111-1111-4111-8111-111111111111";
function database(release: unknown, sources: unknown[] = []) {
  const query = jest
    .fn<(...args: unknown[]) => Promise<{ rows: unknown[] }>>()
    .mockResolvedValueOnce({ rows: release ? [release] : [] })
    .mockResolvedValueOnce({ rows: sources });
  const tenantTransaction = jest.fn(
    async (_tenant: string, work: (db: unknown) => Promise<unknown>) =>
      work({ query }),
  );
  return { query, tenantTransaction };
}
const release = () => ({
  manifest: {
    tenantId: tenant,
    schemaVersion: 1,
    configuration: {
      knowledgeRevisionIds: ["revision"],
      businessProfileVersionId: "profile",
      capabilityBindingIds: ["binding"],
    },
  },
  content: "Public guidance",
  tone: "Natural",
});
describe("published public channel knowledge", () => {
  beforeEach(() => { process.env.SOPHIA_RUNTIME_DATABASE_URL = "postgres://example"; process.env.SOPHIA_RUNTIME_SCHEMA = "sophia_runtime"; });
  it("leaves existing deployments untouched unless explicitly configured", async () => {
    const db = database(null);
    expect(await publishedChannelKnowledge(db as never, tenant)).toBe("");
    expect(db.tenantTransaction).not.toHaveBeenCalled();
  });
  it("rejects a mismatched tenant or unavailable release before exposing sources", async () => {
    const db = database({
      ...release(),
      manifest: { ...release().manifest, tenantId: "other" },
    });
    await expect(
      publishedChannelKnowledge(db as never, tenant, "sophia_ai"),
    ).rejects.toThrow("Published public knowledge is unavailable");
    expect(db.query).toHaveBeenCalledTimes(1);
  });
  it("requires currently published granted sources and uses a scoped transaction", async () => {
    const db = database(release(), [
      { title: "Services", content: "Approved company information" },
    ]);
    const instructions = await publishedChannelKnowledge(
      db as never,
      tenant,
      "sophia_ai",
    );
    expect(db.tenantTransaction.mock.calls[0][0]).toBe(tenant);
    expect(db.query.mock.calls[0][0]).toContain("agent_release_revocations");
    expect(db.query.mock.calls[1][0]).toContain("knowledge_snapshot_grants");
    expect(db.query.mock.calls[1][1]).toEqual([
      tenant,
      ["revision"],
      "profile",
      ["binding"],
    ]);
    expect(instructions).toContain("Approved company information");
    expect(instructions).toContain("no verified WhatsApp identity");
    expect(instructions).toContain(
      "Keep other registered business tools and their workflows unchanged",
    );
  });
  it("does not silently fall back to stale generic knowledge when approved sources disappear", async () => {
    await expect(
      publishedChannelKnowledge(
        database(release()) as never,
        tenant,
        "sophia_ai",
      ),
    ).rejects.toThrow("Published public knowledge is unavailable");
  });
});
