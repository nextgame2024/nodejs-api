import { describe, expect, it } from "@jest/globals";
import { ADMIN_PERMISSIONS_METADATA } from "../authorization/admin-permission.decorator.js";
import { UsageBillingController } from "./usage-billing.controller.js";

describe("UsageBillingController permissions", () => {
  it("keeps measured usage and commercial references on distinct read permissions", () => {
    const prototype = UsageBillingController.prototype;
    expect(Reflect.getMetadata(ADMIN_PERMISSIONS_METADATA, prototype.usage)).toEqual(["usage.read"]);
    expect(Reflect.getMetadata(ADMIN_PERMISSIONS_METADATA, prototype.commercial)).toEqual(["billing.read"]);
    expect(Reflect.getMetadata(ADMIN_PERMISSIONS_METADATA, prototype.limits)).toEqual(["usage.read"]);
    expect(Reflect.getMetadata(ADMIN_PERMISSIONS_METADATA, prototype.updateLimits)).toEqual(["usage.limits.manage"]);
    expect(Reflect.getMetadata(ADMIN_PERMISSIONS_METADATA, prototype.checkout)).toEqual(["billing.manage"]);
    expect(Reflect.getMetadata(ADMIN_PERMISSIONS_METADATA, prototype.portal)).toEqual(["billing.manage"]);
    expect(Reflect.getMetadata(ADMIN_PERMISSIONS_METADATA, prototype.reconcile)).toEqual(["billing.manage"]);
  });
});
