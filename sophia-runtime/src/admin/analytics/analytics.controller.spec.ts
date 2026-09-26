import { describe, expect, it } from "@jest/globals";
import { ADMIN_PERMISSIONS_METADATA } from "../authorization/admin-permission.decorator.js";
import { AnalyticsController } from "./analytics.controller.js";

describe("AnalyticsController permissions", () => {
  it("keeps dashboard reads and exports on distinct permissions", () => {
    const prototype = AnalyticsController.prototype;
    expect(Reflect.getMetadata(ADMIN_PERMISSIONS_METADATA, prototype.dashboard)).toEqual(["analytics.read"]);
    expect(Reflect.getMetadata(ADMIN_PERMISSIONS_METADATA, prototype.exports)).toEqual(["analytics.export"]);
    expect(Reflect.getMetadata(ADMIN_PERMISSIONS_METADATA, prototype.createExport)).toEqual(["analytics.export"]);
    expect(Reflect.getMetadata(ADMIN_PERMISSIONS_METADATA, prototype.downloadExport)).toEqual(["analytics.export"]);
  });
});
