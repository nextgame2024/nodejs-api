import { describe, expect, it } from "@jest/globals";
import { CapabilityExtensionRegistry } from "../../capabilities-v2/extensions/capability-extension.registry.js";
import { realEstateCapabilityExtensions } from "./real-estate-capability.extensions.js";

const bindingId = "11111111-1111-4111-8111-111111111111";

describe("real-estate capability extensions", () => {
  it("keeps business fields in a strict compiled pack schema", () => {
    const registry = new CapabilityExtensionRegistry();
    realEstateCapabilityExtensions(bindingId).forEach((definition) => registry.register(definition));

    expect(registry.parseInput(bindingId, "catalog.search", {
      listingType: "sale", suburbs: ["Paddington"], minimumBedrooms: 3,
    })).toMatchObject({ listingType: "sale" });
    expect(() => registry.parseInput(bindingId, "catalog.search", {
      listingType: "sale", arbitrarySql: "select *",
    })).toThrow();
    expect(() => registry.parseOutput(bindingId, "catalog.get", {
      listingType: "sale", suburb: "Paddington", displayPrice: "$1m", bedrooms: 3,
      bathrooms: 2, description: "Example", features: [], executableHtml: "<script />",
    })).toThrow();
  });
});
