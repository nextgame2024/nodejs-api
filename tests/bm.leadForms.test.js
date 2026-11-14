import { describe, test, expect, jest } from "@jest/globals";
import { randomUUID } from "node:crypto";
import {
  formInput,
  formQuery,
} from "../src/services/leads/lead-forms.contracts.js";
const block = (kind, fields = {}) => ({
  id: randomUUID(),
  kind,
  text: kind,
  required: false,
  options: [],
  ...fields,
});
const form = (blocks = [block("title")]) => ({
  name: "Discovery",
  typeId: randomUUID(),
  blocks,
});
describe("Lead form contracts", () => {
  test("supports the discovery form with required questions and ordered response fields", () => {
    const input = form([
      block("title"),
      block("description", {
        text: "<p><b>Tell us about your business.</b></p>",
      }),
      block("subtitle"),
      block("question", { required: true }),
      block("input"),
      block("question", { required: true }),
      block("list", { options: ["Education", "Other"] }),
      block("description", { text: "Thank you!" }),
    ]);
    expect(formInput(input)).toEqual(input);
  });
  test("rejects invalid question associations and duplicate or empty options", () => {
    for (const blocks of [
      [block("question")],
      [block("question"), block("title")],
      [block("checkboxes", { options: ["Same", "same"] })],
      [block("list", { options: [" "] })],
    ])
      expect(() => formInput(form(blocks))).toThrow();
  });
  test("rejects tenant injection, oversized forms, duplicate IDs and unsupported blocks", () => {
    expect(() => formInput({ ...form(), customerId: randomUUID() })).toThrow();
    expect(() =>
      formInput(form(Array.from({ length: 101 }, () => block("input")))),
    ).toThrow();
    const b = block("input");
    expect(() => formInput(form([b, b]))).toThrow();
    expect(() => formInput(form([block("script")]))).toThrow();
    expect(() =>
      formInput(form([block("input", { required: true })])),
    ).toThrow();
  });
  test("bounds page sizes and allowlists SQL sorting", () => {
    expect(formQuery({ page: "2", limit: "25", sort: "type" }).page).toBe(2);
    for (const q of [
      { limit: 1000 },
      { page: -1 },
      { sort: "name;drop table users" },
      { direction: "invalid" },
    ])
      expect(() => formQuery(q)).toThrow();
  });
});
const transaction = jest.fn();
jest.unstable_mockModule(
  "../src/services/leads/assistant-settings.service.js",
  () => ({ transaction }),
);
const api = await import("../src/services/leads/lead-forms.service.js");
describe("Lead form authorization and conflict handling", () => {
  test("denies changes by an assigned advisor before accessing form data", async () => {
    const query = jest.fn();
    transaction.mockImplementation((actor, company, work) =>
      work({ query }, "tenant", { canManageLeads: false }),
    );
    await expect(
      api.createType("advisor", "company", { name: "Type" }),
    ).rejects.toMatchObject({ status: 403 });
    expect(query).not.toHaveBeenCalled();
  });
  test("cannot assign another tenant’s type or a deleted type", async () => {
    const query = jest
      .fn()
      .mockResolvedValueOnce({ rows: [{ installed: true }] })
      .mockResolvedValueOnce({ rowCount: 0, rows: [] });
    transaction.mockImplementation((actor, company, work) =>
      work({ query }, "verified-tenant", { canManageLeads: true }),
    );
    await expect(
      api.saveForm("owner", "company", randomUUID(), {
        expectedVersion: 0,
        form: form(),
      }),
    ).rejects.toMatchObject({ status: 400 });
    expect(query.mock.calls[1][1][0]).toBe("verified-tenant");
    expect(query.mock.calls[1][0]).toContain("FOR UPDATE");
  });
  test("stale deletes do not audit or succeed", async () => {
    const query = jest
      .fn()
      .mockResolvedValueOnce({ rows: [{ installed: true }] })
      .mockResolvedValueOnce({ rowCount: 0 });
    transaction.mockImplementation((a, c, work) =>
      work({ query }, "tenant", { canManageLeads: true }),
    );
    await expect(
      api.deleteForm("owner", "company", randomUUID(), { expectedVersion: 2 }),
    ).rejects.toMatchObject({ status: 409 });
    expect(query).toHaveBeenCalledTimes(2);
  });
  test("used types cannot be deleted", async () => {
    const query = jest
      .fn()
      .mockResolvedValueOnce({ rows: [{ installed: true }] })
      .mockResolvedValueOnce({ rows: [{ id: "type" }] })
      .mockResolvedValueOnce({ rowCount: 1 });
    transaction.mockImplementation((a, c, work) =>
      work({ query }, "tenant", { canManageLeads: true }),
    );
    await expect(
      api.deleteType("owner", "company", randomUUID()),
    ).rejects.toMatchObject({ status: 409 });
    expect(query).toHaveBeenCalledTimes(3);
  });
});
