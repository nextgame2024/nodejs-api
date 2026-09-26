import { describe, expect, it, jest } from "@jest/globals";
import { z } from "zod";
import { BusinessManagerRealEstateConnector, businessManagerRealEstatePorts } from "../../src/business-packs/real-estate/business-manager-real-estate.connector.js";
import type { BusinessManagerClient } from "../../src/business-packs/real-estate/business-manager.client.js";
import type { CapabilityContext } from "../../src/capabilities-v2/contracts/business-capability.contracts.js";
import { MemoryActionReviewStore } from "../../src/tools/action-review.store.js";
import {
  executeSharedCapabilityTool,
  SyntheticCapabilityLaboratory,
  type SyntheticTenantConfiguration,
} from "./synthetic-capability-laboratory.fixture.js";

const tenantA = "11111111-1111-4111-8111-111111111111";
const tenantB = "22222222-2222-4222-8222-222222222222";
const connectorA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
const connectorB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2";
const from = "2026-10-01T00:00:00.000Z";
const to = "2026-10-01T00:30:00.000Z";

describe("P5-06 synthetic capability portability laboratory", () => {
  it("onboards independent tenants through configuration and exposes only granted capabilities", async () => {
    const laboratory = lab();

    expect(laboratory.availableOperations(tenantA)).toEqual([
      "knowledge.search", "catalog.search", "availability.search", "booking.prepare",
    ]);
    expect(laboratory.availableOperations(tenantB)).toEqual([
      "knowledge.search", "catalog.search", "availability.search",
    ]);
    await expect(laboratory.execute(tenantB, "booking.prepare", {
      resource: { connectorBindingId: connectorB, opaqueId: "shared-resource" },
      optionRef: "shared-option",
    })).rejects.toThrow("Capability booking is not granted");

    const knowledge = await laboratory.execute(tenantA, "knowledge.search", { query: "hours" });
    expect(knowledge).toMatchObject({ items: [{ title: "Alpha guidance" }] });
  });

  it("keeps overlapping opaque IDs isolated by tenant-owned connector binding", async () => {
    const laboratory = lab();
    const alpha = await laboratory.execute(tenantA, "catalog.search", {
      query: "shared", extension: { audience: "visitor" },
    });
    const beta = await laboratory.execute(tenantB, "catalog.search", {
      query: "shared", extension: { section: "north" },
    });

    expect(alpha).toMatchObject({ items: [{
      resource: { connectorBindingId: connectorA, opaqueId: "shared-resource" },
      title: "Alpha resource",
      extension: { badge: "Alpha", acceptedInput: { audience: "visitor" } },
    }] });
    expect(beta).toMatchObject({ items: [{
      resource: { connectorBindingId: connectorB, opaqueId: "shared-resource" },
      title: "Beta entry",
      extension: { caption: "Beta", acceptedInput: { section: "north" } },
    }] });

    await expect(laboratory.execute(tenantA, "availability.search", {
      resource: beta.items[0].resource, from, to,
    })).rejects.toThrow("Resource binding does not match");
  });

  it("denies unknown business fields at the shared boundary and inside binding-specific extensions", async () => {
    const laboratory = lab();
    await expect(laboratory.execute(tenantA, "catalog.search", {
      query: "shared", arbitrarySql: "select *",
    })).rejects.toThrow();
    await expect(laboratory.execute(tenantA, "catalog.search", {
      query: "shared", extension: { audience: "visitor", section: "north" },
    })).rejects.toThrow();
    await expect(laboratory.execute(tenantB, "catalog.search", {
      query: "shared", extension: { audience: "visitor" },
    })).rejects.toThrow();
  });

  it("uses different capability grants on one connector without invalidating a catalog resource", async () => {
    const laboratory = lab();
    const catalog = await laboratory.execute(tenantA, "catalog.search", {
      query: "shared", extension: { audience: "visitor" },
    });
    const availability = await laboratory.execute(tenantA, "availability.search", {
      resource: catalog.items[0].resource, from, to,
    });
    const prepared = await laboratory.execute(tenantA, "booking.prepare", {
      resource: catalog.items[0].resource, optionRef: availability.options[0].optionRef,
    });

    expect(prepared).toMatchObject({ summary: "Review Alpha reservation" });
    expect(laboratory.context(tenantA, "catalog").capabilityBindingId)
      .not.toBe(laboratory.context(tenantA, "availability").capabilityBindingId);
    expect(laboratory.context(tenantA, "catalog").connectorBindingId)
      .toBe(laboratory.context(tenantA, "availability").connectorBindingId);
  });

  it("runs the same canonical read tools against synthetic and real-estate connector ports", async () => {
    const laboratory = lab();
    const syntheticContext = laboratory.context(tenantA, "catalog");
    const syntheticCatalog = await executeSharedCapabilityTool(
      laboratory.ports(tenantA), "catalog.search", { query: "shared", extension: { audience: "visitor" } }, syntheticContext,
    );

    const propertyId = "33333333-3333-4333-8333-333333333333";
    const slotId = "44444444-4444-4444-8444-444444444444";
    const searchProperties = jest.fn<BusinessManagerClient["searchProperties"]>().mockResolvedValue({ properties: [{
      propertyId, listingType: "rent", title: "Real-estate fixture", suburb: "Nundah", priceDisplay: "$620 per week",
      bedrooms: 2, bathrooms: 1, description: "Fixture only", features: [], media: [],
    }] });
    const getInspectionSlots = jest.fn<BusinessManagerClient["getInspectionSlots"]>().mockResolvedValue({ slots: [{
      slotId, propertyId, startsAt: from, endsAt: to, capacity: 4, placesAvailable: 2,
      startsAtLabel: "Fixture time",
    }] });
    const realEstate = businessManagerRealEstatePorts(new BusinessManagerRealEstateConnector(
      { searchProperties, getInspectionSlots } as unknown as BusinessManagerClient,
      new MemoryActionReviewStore() as never,
    ));
    const realEstateCatalogContext = realEstateContext("catalog-capability");
    const realEstateCatalog = await executeSharedCapabilityTool(
      realEstate, "catalog.search", { query: "Nundah", extension: { listingType: "rent" } }, realEstateCatalogContext,
    );
    const realEstateAvailability = await executeSharedCapabilityTool(
      realEstate,
      "availability.search",
      { resource: realEstateCatalog.items[0].resource, from, to },
      realEstateContext("availability-capability"),
    );

    expect(syntheticCatalog.items[0].title).toBe("Alpha resource");
    expect(realEstateCatalog.items[0].title).toBe("Real-estate fixture");
    expect(realEstateAvailability.options[0]).toMatchObject({ optionRef: slotId, status: "available" });
    expect(searchProperties).toHaveBeenCalledTimes(1);
    expect(getInspectionSlots).toHaveBeenCalledTimes(1);
  });
});

function lab() {
  return new SyntheticCapabilityLaboratory([alphaConfiguration(), betaConfiguration()]);
}

function alphaConfiguration(): SyntheticTenantConfiguration {
  return {
    tenantId: tenantA,
    connectorBindingId: connectorA,
    capabilityBindings: {
      knowledge: "11111111-1111-4111-8111-111111111101",
      catalog: "11111111-1111-4111-8111-111111111102",
      availability: "11111111-1111-4111-8111-111111111103",
      booking: "11111111-1111-4111-8111-111111111104",
    },
    wording: { catalogTitle: "Alpha resource", knowledgeTitle: "Alpha guidance", bookingSummary: "Review Alpha reservation" },
    catalogInputExtension: z.object({ audience: z.literal("visitor") }).strict(),
    catalogOutputExtension: { badge: "Alpha" },
  };
}

function betaConfiguration(): SyntheticTenantConfiguration {
  return {
    tenantId: tenantB,
    connectorBindingId: connectorB,
    capabilityBindings: {
      knowledge: "22222222-2222-4222-8222-222222222201",
      catalog: "22222222-2222-4222-8222-222222222202",
      availability: "22222222-2222-4222-8222-222222222203",
    },
    wording: { catalogTitle: "Beta entry", knowledgeTitle: "Beta help", bookingSummary: "Review Beta request" },
    catalogInputExtension: z.object({ section: z.literal("north") }).strict(),
    catalogOutputExtension: { caption: "Beta" },
  };
}

function realEstateContext(capabilityBindingId: string): CapabilityContext {
  return {
    tenantId: tenantA,
    sessionId: "real-estate-portability-session",
    capabilityBindingId,
    connectorBindingId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    actorRef: "test-actor",
    correlationId: "test-correlation",
    deadline: "2026-10-01T02:00:00.000Z",
  };
}
