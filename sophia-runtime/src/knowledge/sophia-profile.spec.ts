import {
  STUDENT_VISA_DEMO_BASELINE,
  sophiaConversationInstructions,
} from "./sophia-profile.js";

describe("sophiaConversationInstructions", () => {
  it("answers agency requirement questions without generic advice disclaimers", () => {
    const instructions = sophiaConversationInstructions();

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

  it("explains the asynchronous BUY property report accurately", () => {
    const instructions = sophiaConversationInstructions();

    expect(instructions).toContain(
      "I'm also preparing the property report and will include it with your confirmation email",
    );
    expect(instructions).toContain(
      "Do not say that the email has already been sent",
    );
  });

  it("routes the five student visa demo intents through the fast display tool", () => {
    const instructions = sophiaConversationInstructions();

    expect(instructions).toContain("call showStudentVisaDemoGuidance");
    expect(instructions).toContain("without web research");
    expect(instructions).toContain("Genuine Student requirement replaced");
    expect(instructions).toContain("Ministerial Direction 115");
    expect(instructions).toContain("do not automatically alter an already-granted visa");
    expect(instructions).toContain("48 hours per fortnight");
    expect(instructions).toContain(STUDENT_VISA_DEMO_BASELINE);
  });
});
