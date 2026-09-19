import { expect, it, jest, beforeEach } from "@jest/globals";
const searchStudentKnowledge = jest.fn();
jest.unstable_mockModule("../src/models/bm.studentAgency.model.js", () => ({ searchStudentKnowledge }));
const { searchKnowledge } = await import("../src/services/bm.studentAgency.service.js");
beforeEach(() => jest.clearAllMocks());
it("keeps student lookups company scoped and preserves evidence", async () => {
  const record = { answer: "Reviewed example", previousRule: "Earlier example", sources: [{title: "Home Affairs", url: "https://immi.homeaffairs.gov.au/visas"}] };
  searchStudentKnowledge.mockResolvedValue([record]);
  const result = await searchKnowledge("company-a", {q: " English evidence "});
  expect(searchStudentKnowledge).toHaveBeenCalledWith("company-a", "English evidence");
  expect(result.results).toEqual([record]);
  expect(result.liveVerified).toBe(false);
  expect(result.consultationBookingRequiresAvailabilityCheck).toBe(true);
});
it("does not expose answers backed by missing or spoofed official sources", async () => {
  searchStudentKnowledge.mockResolvedValue([
    {sources: []}, {sources: [{title: "Fake", url: "https://immi.homeaffairs.gov.au.evil.test/"}]},
    {sources: [{title: "Unsafe", url: "http://immi.homeaffairs.gov.au/"}]},
  ]);
  expect(await searchKnowledge("company-a", {q: "recent changes"})).toMatchObject({status: "verification_required", results: []});
});
it("rejects invalid questions before querying", async () => {
  await expect(searchKnowledge("company-a", {q: " "})).rejects.toMatchObject({status: 400});
  expect(searchStudentKnowledge).not.toHaveBeenCalled();
});
