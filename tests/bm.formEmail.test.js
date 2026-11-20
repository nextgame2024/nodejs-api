import { test, expect } from "@jest/globals";
process.env.DATABASE_URL ||= "postgresql://127.0.0.1/postgres";
const { formEmailMessage } = await import(
  "../src/services/leads/form-email.service.js"
);
const { businessEmailRecipient } = await import(
  "../src/services/leads/public-lead-forms.service.js"
);
const appointment = {
  startsAt: "2026-11-15T23:00:00.000Z",
  endsAt: "2026-11-15T23:30:00.000Z",
  timezone: "Australia/Brisbane",
};
test("branded notification has local date and separate escaped questions and answers only", () => {
  const m = formEmailMessage({
    formName: "Discovery",
    contact: { name: "Removed", email: "removed@test.com" },
    appointment,
    answers: [{ label: "Your name?", value: "Jose <script>" }],
  });
  expect(m.html).toContain(
    "Monday, 16 November 2026 at 9:00 am (Australia/Brisbane)",
  );
  expect(m.html).toContain('alt="Sophia AI"');
  expect(m.text).toContain("Your name?\nJose <script>");
  expect(m.html).not.toContain("<script>");
  expect(m.html).not.toContain("removed@test.com");
  expect(m.text).not.toContain("2026-11-15T");
});
test("customer confirmation includes requested copy and does not expose answers", () => {
  const m = formEmailMessage({
    formName: "Discovery",
    confirmationOnly: true,
    appointment,
    answers: [{ label: "Private", value: "Secret" }],
  });
  expect(m.text).toContain("Thank you for telling us about your business!");
  expect(m.text).toContain("We look forward to speaking with you.");
  expect(m.html).not.toContain("Secret");
  expect(
    formEmailMessage({ formName: "Discovery", confirmationOnly: true }).text,
  ).not.toContain("appointment is confirmed");
});
test("only an unambiguous valid business email answer is a confirmation recipient", () => {
  expect(
    businessEmailRecipient([
      { label: "What is your business email?", value: " Person@example.com " },
    ]),
  ).toBe("person@example.com");
  for (const answers of [
    [{ label: "Notes", value: "person@example.com" }],
    [{ label: "Business email", value: "one@example.com,two@example.com" }],
    [
      { label: "Business email", value: "one@example.com" },
      { label: "Business email", value: "two@example.com" },
    ],
  ])
    expect(businessEmailRecipient(answers)).toBeNull();
});

test("booking email reuses branding and includes friendly preparation button and timezone", () => {
  const m = formEmailMessage({
    bookingConfirmation: true,
    confirmationOnly: true,
    name: "Alex <script>",
    language: "en",
    appointment,
    preparationUrl: "https://sophiaai.com.au/forms/meeting-preparation",
  });
  expect(m.subject).toBe("Your appointment is confirmed — Sophia AI");
  expect(m.html).toContain('alt="Sophia AI"');
  expect(m.html).toContain("Prepare for our meeting");
  expect(m.html).toContain(
    'href="https://sophiaai.com.au/forms/meeting-preparation"',
  );
  expect(m.html).not.toContain("<script>");
  expect(m.text).toContain(
    "Monday, 16 November 2026 at 9:00 am (Australia/Brisbane)",
  );
  expect(m.text).toContain("Before we meet");
});
