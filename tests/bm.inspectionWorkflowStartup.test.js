import { expect, it, jest } from "@jest/globals";

const startInspectionWorkflow = jest.fn();
const listen = jest.fn((_port, ready) => ready());
jest.unstable_mockModule("../src/app.js", () => ({ default: { listen } }));
jest.unstable_mockModule("../src/config/db.js", () => ({ pingDb: jest.fn().mockResolvedValue(undefined) }));
jest.unstable_mockModule("../src/config/startupMigrations.js", () => ({
  ensureStartupMigrations: jest.fn().mockResolvedValue(undefined),
}));
jest.unstable_mockModule("../src/services/bm.inspectionWorkflow.service.js", () => ({ startInspectionWorkflow }));

it("starts the inspection queue consumers when the API starts", async () => {
  await import("../src/server.js");
  expect(listen).toHaveBeenCalled();
  expect(startInspectionWorkflow).toHaveBeenCalledTimes(1);
});
