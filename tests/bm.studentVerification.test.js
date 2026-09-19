import { expect, it, jest } from "@jest/globals";
jest.unstable_mockModule("../src/models/bm.studentSourceSnapshots.model.js", () => ({}));
const { verifyStudentSources } = await import("../src/services/bm.studentVerification.service.js");
const now = Date.parse("2026-09-19T01:00:00Z");
const snapshot = {text: "Official evidence", contentHash: "hash-1", fetchedAt: "2026-09-19T00:00:00Z"};
const store = previous => ({getLatestSnapshot: jest.fn().mockResolvedValue(previous), saveSnapshot: jest.fn().mockResolvedValue(undefined)});
it("returns official evidence and records changes without asserting a rule changed", async () => {
  const cache = store(snapshot);
  const result = await verifyStudentSources({topic:"genuine_student"}, {store:cache, now:()=>now,
    fetchSource: jest.fn().mockResolvedValue({...snapshot, contentHash:"hash-2"})});
  expect(result.status).toBe("official_evidence");
  expect(result.sources[0]).toMatchObject({status:"fetched",contentChanged:true,historySaved:true});
  expect(cache.saveSnapshot).toHaveBeenCalledTimes(1);
});
it("labels recent fallback as cached rather than live, and rejects expired cache", async () => {
  const fetchSource = jest.fn().mockRejectedValue(new Error("blocked"));
  const result = await verifyStudentSources({topic:"work"}, {store:store(snapshot),fetchSource,now:()=>now});
  expect(result.status).toBe("verification_unavailable");
  expect(result.sources[0]).toMatchObject({status:"cached",fetchedAt:snapshot.fetchedAt});
  const expired = await verifyStudentSources({topic:"work"}, {store:store(snapshot),fetchSource,now:()=>now+86400000});
  expect(expired.sources[0].status).toBe("unavailable");
  expect(expired.sources[0].text).toBeUndefined();
});
it("reports partial evidence when one page fails", async () => {
  const fetchSource = jest.fn().mockResolvedValueOnce(snapshot).mockRejectedValueOnce(new Error("timeout"));
  expect((await verifyStudentSources({topic:"documents"}, {store:store(null),fetchSource})).status).toBe("partial_evidence");
});
it("continues live retrieval if snapshot persistence fails", async () => {
  const cache = {getLatestSnapshot:jest.fn().mockRejectedValue(new Error("db")),saveSnapshot:jest.fn().mockRejectedValue(new Error("db"))};
  const result = await verifyStudentSources({topic:"work"}, {store:cache,fetchSource:jest.fn().mockResolvedValue(snapshot)});
  expect(result.sources[0]).toMatchObject({status:"fetched",historySaved:false});
});
it("rejects unknown topics and arbitrary URLs before requesting anything", async () => {
  const fetchSource = jest.fn();
  await expect(verifyStudentSources({topic:"https://evil.test"}, {fetchSource})).rejects.toMatchObject({status:400});
  await expect(verifyStudentSources({topic:"__proto__"}, {fetchSource})).rejects.toMatchObject({status:400});
  expect(fetchSource).not.toHaveBeenCalled();
});
