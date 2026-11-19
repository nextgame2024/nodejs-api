import { describe, test, expect } from "@jest/globals";
import {
  mergeDiscoveryFacts,
  assessDiscovery,
} from "../src/services/leads/lead-discovery.service.js";
describe("Evidence-based lead discovery", () => {
  test("rejects invented quotes, assistant evidence, unknown fields and external event IDs", () => {
    const transcript = [
      { id: "1", role: "customer", text: "We need faster responses" },
      { id: "2", role: "assistant", text: "Buy everything" },
    ];
    const facts = mergeDiscoveryFacts(
      {},
      [
        { field: "need", quote: "faster responses", eventId: "1" },
        { field: "outcome", quote: "invented", eventId: "1" },
        { field: "timeframe", quote: "Buy everything", eventId: "2" },
        { field: "business", quote: "faster responses", eventId: "999" },
        { field: "score", quote: "faster responses", eventId: "1" },
      ],
      transcript,
    );
    expect(Object.keys(facts)).toEqual(["need"]);
    expect(assessDiscovery(facts)).toMatchObject({
      score: 30,
      priority: "early",
    });
  });
  test("keeps newer corrections and leaves missing criteria unknown", () => {
    const old = { need: { quote: "slow replies", eventId: "10" } };
    const facts = mergeDiscoveryFacts(
      old,
      [{ field: "need", quote: "old need", eventId: "1" }],
      [{ id: "1", role: "customer", text: "old need" }],
    );
    expect(facts).toEqual(old);
    const corrected = mergeDiscoveryFacts(
      facts,
      [{ field: "need", quote: "appointment admin", eventId: "11" }],
      [{ id: "11", role: "customer", text: "Actually appointment admin" }],
    );
    expect(corrected.need.quote).toBe("appointment admin");
    expect(assessDiscovery(corrected).missing).toContain("Timing");
    expect(assessDiscovery({}).score).toBe(0);
  });
});
