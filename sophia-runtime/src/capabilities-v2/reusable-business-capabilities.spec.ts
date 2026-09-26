import { describe, expect, it } from "@jest/globals";
import { z } from "zod";
import { enabledConnectorOperations } from "./connectors/connector-capability.manifest.js";
import { CatalogItemSchema, ResourceRefSchema, type CapabilityContext } from "./contracts/business-capability.contracts.js";
import { CapabilityExtensionRegistry } from "./extensions/capability-extension.registry.js";
import type { CatalogPort } from "./ports/business-capability.ports.js";
import { CatalogCapabilityService } from "./services/catalog-capability.service.js";

const bindingId = "11111111-1111-4111-8111-111111111111";
const connectorBindingId = "44444444-4444-4444-8444-444444444444";
const context: CapabilityContext = {
  tenantId: "22222222-2222-4222-8222-222222222222",
  sessionId: "session-1",
  capabilityBindingId: bindingId,
  connectorBindingId,
  actorRef: "anonymous-session",
  correlationId: "correlation-1",
  deadline: new Date(Date.now() + 60_000).toISOString(),
};

describe("reusable business capability contracts", () => {
  it("runs a catalog capability without an AI provider or business-system implementation", async () => {
    const catalog: CatalogPort = {
      async search(input, capabilityContext) {
        return {
          items: [{
            resource: { connectorBindingId: capabilityContext.connectorBindingId, opaqueId: "item-1" },
            title: input.query ?? "All items",
            extension: { label: "example" },
          }],
          page: { hasMore: false },
        };
      },
      async get(input) { return { item: { resource: input.resource, title: "Item" } }; },
      async getMedia() { return { items: [] }; },
    };

    const registry = new CapabilityExtensionRegistry();
    registry.register(neutralExtension());
    const service = new CatalogCapabilityService(catalog, registry);
    const result = await service.search({
      query: "Example", page: { limit: 10 }, extension: { categories: ["featured"] },
    }, context);

    expect(CatalogItemSchema.parse(result.items[0])).toMatchObject({ title: "Example" });
    expect(ResourceRefSchema.parse(result.items[0].resource).opaqueId).toBe("item-1");
  });

  it("validates binding-specific input and output extensions and rejects undeclared fields", () => {
    const registry = new CapabilityExtensionRegistry();
    registry.register(neutralExtension());

    expect(registry.parseInput(bindingId, "catalog.search", {
      categories: ["featured"],
    })).toMatchObject({ categories: ["featured"] });
    expect(() => registry.parseInput(bindingId, "catalog.search", {
      categories: ["featured"], arbitrarySql: "select *",
    })).toThrow();
    expect(() => registry.parseOutput(bindingId, "catalog.search", {
      labels: ["Featured"], executableHtml: "<script />",
    })).toThrow();
    expect(registry.metadata(bindingId, "catalog.search")).toMatchObject({
      schemaId: "test.catalog-search-extension", maximumItems: 25,
    });
  });

  it("fails closed for an unknown capability binding", () => {
    const registry = new CapabilityExtensionRegistry();
    registry.register(neutralExtension());
    expect(() => registry.parseInput(
      "33333333-3333-4333-8333-333333333333", "catalog.search", {},
    )).toThrow("Unknown capability extension");
  });

  it("does not accept an arbitrary URL as an opaque business resource", () => {
    expect(() => ResourceRefSchema.parse({
      connectorBindingId,
      opaqueId: "https://untrusted.example/resource",
    })).toThrow("not URLs");
  });

  it("cannot expose a commit operation without stable idempotency and reconciliation", () => {
    const unsafe = manifest({
      operationId: "booking.commit",
      enabled: true,
      idempotency: "none",
      reconciliation: "unsupported",
      cancellation: "unsupported",
      liveStatus: "none",
    });
    expect(() => enabledConnectorOperations(unsafe, ["booking.commit"]))
      .toThrow("cannot safely expose mutation");
  });

  it("exposes only explicitly supported safe mutation and live-status operations", () => {
    const safe = {
      connectorKey: "test-connector",
      version: "1.0.0",
      operations: [
        {
          operationId: "booking.commit",
          enabled: true,
          idempotency: "stable-command",
          reconciliation: "lookup",
          cancellation: "before-commit",
          liveStatus: "none",
        },
        {
          operationId: "booking.status",
          enabled: true,
          idempotency: "not-applicable",
          reconciliation: "lookup",
          cancellation: "unsupported",
          liveStatus: "poll",
        },
      ],
    };
    expect(enabledConnectorOperations(safe, ["booking.commit", "booking.status"]))
      .toEqual(["booking.commit", "booking.status"]);
    expect(() => enabledConnectorOperations(safe, ["delivery.commit-resend"]))
      .toThrow("does not enable");
  });
});

function manifest(operation: Record<string, unknown>) {
  return { connectorKey: "unsafe-connector", version: "1.0.0", operations: [operation] };
}

function neutralExtension() {
  return {
    capabilityBindingId: bindingId,
    operationId: "catalog.search" as const,
    metadata: {
      schemaId: "test.catalog-search-extension",
      schemaVersion: "1.0.0",
      dataClassification: ["internal" as const],
      maximumItems: 25,
    },
    inputSchema: z.object({ categories: z.array(z.string()).max(10) }).strict(),
    outputSchema: z.object({ label: z.string().max(100) }).strict(),
  };
}
