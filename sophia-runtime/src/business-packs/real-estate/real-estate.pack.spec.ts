import { describe, expect, it, jest } from "@jest/globals";
import { MemoryActionReviewStore } from "../../tools/action-review.store.js";
import { BusinessPackManifestSchema } from "../business-pack.contracts.js";
import { BusinessPackRegistry } from "../business-pack.registry.js";
import type { BusinessManagerClient } from "./business-manager.client.js";
import { createRealEstateBusinessPack } from "./real-estate.pack.js";

describe("compiled real-estate business pack", () => {
  it("declares its connector, capabilities, extensions, renderers and bounded legacy aliases", () => {
    const pack = createPack();
    expect(BusinessPackManifestSchema.parse(pack.manifest)).toMatchObject({
      packId: "real-estate",
      connectorKeys: ["business-manager-real-estate"],
      capabilities: expect.arrayContaining(["catalog", "availability", "booking", "delivery", "workflow-status"]),
      schemaExtensionIds: expect.arrayContaining(["real-estate.catalog-search-extension"]),
      uiRendererIds: expect.arrayContaining(["real-estate.property-list", "real-estate.booking-review"]),
      legacyAliases: expect.objectContaining({ searchProperties: "catalog.search", bookInspection: "booking.commit" }),
    });
    expect(pack.operationIds).toEqual(expect.arrayContaining([
      "catalog.search", "availability.revalidate", "booking.reconcile", "delivery.status", "workflow.status", "ui.dismiss",
    ]));
    expect(pack.analyticsMetrics).toEqual(expect.arrayContaining([
      expect.objectContaining({ metricKey: "real-estate.inspection-booking.confirmed",
        source: expect.objectContaining({ canonicalToolId: "booking.commit" }) }),
    ]));
  });

  it("contains no quarantined student implementation or registration", () => {
    const serialized = JSON.stringify(createPack());
    expect(serialized).not.toMatch(/student|consultation|migration/i);
  });

  it("can be omitted without breaking the generic pack registry", () => {
    const core = new BusinessPackRegistry();
    expect(core.manifests()).toEqual([]);
    expect(core.tools()).toEqual([]);
    expect(core.instructions("canonical")).toEqual([]);
    expect(core.analyticsMetrics()).toEqual([]);
    expect(core.catalogVersion()).toBe("core-tools-v1");
  });
});

function createPack() {
  return createRealEstateBusinessPack(
    {} as BusinessManagerClient,
    new MemoryActionReviewStore(),
    {} as never,
  );
}
