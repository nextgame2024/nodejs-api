import { EvaluationService } from "./evaluation.service.js";
import { jest } from "@jest/globals";

describe("EvaluationService", () => {
  it("advertises deterministic, non-metered evaluation only", () => {
    const service = new EvaluationService({} as never);
    expect(service.registry()).toMatchObject({
      evaluatorKey: "deterministic-publication-checks",
      evaluatorVersion: 1,
      evidenceMode: "deterministic",
      externalEffects: false,
      meteredSessionCreated: false,
      liveProviderRuns: { available: false },
    });
  });

  it("blocks publication when a required suite has not run for the exact draft", async () => {
    const service = new EvaluationService({} as never);
    const client = { query: jest.fn()
      .mockResolvedValueOnce({ rows: [{ evaluation_dataset_version_id: "version-1", dataset_key: "release-baseline", version: 2, evaluator_version: 1 }] })
      .mockResolvedValueOnce({ rows: [] }) } as never;
    await expect(service.publicationChecks(client, "sophia_runtime", "tenant", "agent", 7)).resolves.toEqual([
      expect.objectContaining({ checkId: "evaluation.release-baseline.v2", status: "blocked" }),
    ]);
  });

  it("accepts only a passing deterministic run pinned to the draft", async () => {
    const service = new EvaluationService({} as never);
    const client = { query: jest.fn()
      .mockResolvedValueOnce({ rows: [{ evaluation_dataset_version_id: "version-1", dataset_key: "release-baseline", version: 1, evaluator_version: 1 }] })
      .mockResolvedValueOnce({ rows: [{ status: "passed", evidence_mode: "deterministic" }] }) } as never;
    const checks = await service.publicationChecks(client, "sophia_runtime", "tenant", "agent", 3);
    expect(checks[0]).toMatchObject({ status: "passed" });
    expect((client as any).query.mock.calls[1][1]).toEqual(["tenant", "agent", "version-1", 3, "deterministic-publication-checks", 1]);
  });
});
