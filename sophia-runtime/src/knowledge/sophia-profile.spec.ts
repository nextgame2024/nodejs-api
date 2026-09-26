import { sophiaConversationInstructions } from "./sophia-profile.js";
import { REAL_ESTATE_CANONICAL_INSTRUCTIONS, REAL_ESTATE_LEGACY_INSTRUCTIONS } from "../business-packs/real-estate/real-estate.instructions.js";

describe("sophiaConversationInstructions", () => {
  it("answers agency requirement questions without generic advice disclaimers", () => {
    const instructions = sophiaConversationInstructions(REAL_ESTATE_LEGACY_INSTRUCTIONS);

    expect(instructions).toContain(
      "answer directly from the agency-approved results",
    );
    expect(instructions).toContain(
      "do not append generic legal or financial advice disclaimers",
    );
    expect(instructions).not.toContain(
      "Explain that general information may not be legal advice",
    );
  });

  it("keeps asynchronous sale-report policy inside the real-estate pack", () => {
    const core = sophiaConversationInstructions();
    const instructions = sophiaConversationInstructions(REAL_ESTATE_CANONICAL_INSTRUCTIONS);

    expect(core).not.toMatch(/property|sale booking|rental/i);
    expect(instructions).toContain("sale booking may succeed");
    expect(instructions).toContain("report and confirmation delivery remain accepted or processing");
  });

  it("uses canonical names only in canonical pack instructions", () => {
    const instructions = sophiaConversationInstructions(REAL_ESTATE_CANONICAL_INSTRUCTIONS);
    expect(instructions).toContain("catalog.search");
    expect(instructions).toContain("booking.commit");
    expect(instructions).not.toContain("searchProperties");
    expect(instructions).not.toContain("bookInspection");
  });

  it("does not activate the quarantined student-agency product", () => {
    const instructions = sophiaConversationInstructions();

    expect(instructions).not.toContain("searchStudentAgencyKnowledge");
    expect(instructions).not.toContain("getStudentConsultationSlots");
    expect(instructions).not.toContain("bookStudentConsultation");
  });
});
