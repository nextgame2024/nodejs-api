import { sophiaConversationInstructions } from "./sophia-profile.js";

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
});
