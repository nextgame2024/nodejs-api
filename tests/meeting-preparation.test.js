import { test, expect, afterEach } from "@jest/globals";
import { preparationConfigs } from "../src/services/scheduling/meeting-preparation.js";
process.env.DATABASE_URL ||= "postgresql://127.0.0.1/postgres";
const { publicToken } = await import(
  "../src/services/leads/public-lead-forms.service.js"
);
const tenant = "11111111-1111-4111-8111-111111111111",
  publication = "22222222-2222-4222-8222-222222222222";
afterEach(() => delete process.env.APPOINTMENT_PREPARATION_FORMS);
test("friendly alias resolves to the published form token and preserves ordinary tokens", () => {
  process.env.APPOINTMENT_PREPARATION_FORMS = JSON.stringify({
    [tenant]: {
      slug: "meeting-preparation",
      origin: "https://sophiaai.com.au",
      publicToken: tenant + "." + publication,
    },
  });
  expect(preparationConfigs()[tenant].url).toBe(
    "https://sophiaai.com.au/forms/meeting-preparation",
  );
  expect(publicToken("meeting-preparation")).toEqual({
    tenant,
    id: publication,
  });
  expect(publicToken(tenant + "." + publication)).toEqual({
    tenant,
    id: publication,
  });
  expect(() => publicToken("unknown-alias")).toThrow();
});
test("rejects unsafe alias configuration", () => {
  expect(() =>
    preparationConfigs({
      APPOINTMENT_PREPARATION_FORMS: JSON.stringify({
        [tenant]: {
          slug: "meeting-preparation",
          origin: "javascript:alert(1)",
          publicToken: tenant + "." + publication,
        },
      }),
    }),
  ).toThrow();
});
