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
test("advertised alias retains the original form while new invitations use the copy", () => {
  const copy = "33333333-3333-4333-8333-333333333333";
  const config = {
    [tenant]: {
      slug: "prepare-for-your-meeting",
      origin: "https://sophiaai.com.au",
      publicToken: tenant + "." + copy,
      aliases: [
        {
          slug: "meeting-preparation",
          publicToken: tenant + "." + publication,
        },
      ],
    },
  };
  process.env.APPOINTMENT_PREPARATION_FORMS = JSON.stringify(config);
  expect(publicToken("meeting-preparation")).toEqual({
    tenant,
    id: publication,
  });
  expect(publicToken("prepare-for-your-meeting")).toEqual({ tenant, id: copy });
  expect(preparationConfigs()[tenant].url).toBe(
    "https://sophiaai.com.au/forms/prepare-for-your-meeting",
  );
  for (const alias of [
    {
      slug: "prepare-for-your-meeting",
      publicToken: tenant + "." + publication,
    },
    { slug: "../invalid", publicToken: tenant + "." + publication },
    { slug: "another-form", publicToken: copy + "." + publication },
  ]) {
    config[tenant].aliases = [alias];
    expect(() =>
      preparationConfigs({
        APPOINTMENT_PREPARATION_FORMS: JSON.stringify(config),
      }),
    ).toThrow();
  }
});
