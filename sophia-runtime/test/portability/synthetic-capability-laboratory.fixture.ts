import { createHash } from "node:crypto";
import { z } from "zod";
import {
  AvailabilityOptionSchema,
  CatalogItemSchema,
  type CommandReceipt,
  PreparedCommandSchema,
  ResourceRefSchema,
  type CapabilityContext,
  type CapabilityOperationId,
  type ExtensionValue,
} from "../../src/capabilities-v2/contracts/business-capability.contracts.js";
import type {
  AvailabilityPort,
  BookingPort,
  CatalogPort,
  KnowledgePort,
} from "../../src/capabilities-v2/ports/business-capability.ports.js";

export type PortableCapability = "knowledge" | "catalog" | "availability" | "booking";
export type PortablePorts = {
  knowledge: KnowledgePort;
  catalog: CatalogPort;
  availability: AvailabilityPort;
  booking: BookingPort;
};

type PortableOperationResult = {
  "knowledge.search": Awaited<ReturnType<KnowledgePort["search"]>>;
  "catalog.search": Awaited<ReturnType<CatalogPort["search"]>>;
  "availability.search": Awaited<ReturnType<AvailabilityPort["search"]>>;
  "booking.prepare": Awaited<ReturnType<BookingPort["prepare"]>>;
};
type PortableOperationId = keyof PortableOperationResult;

export type SyntheticTenantConfiguration = {
  tenantId: string;
  connectorBindingId: string;
  capabilityBindings: Partial<Record<PortableCapability, string>>;
  wording: { catalogTitle: string; knowledgeTitle: string; bookingSummary: string };
  catalogInputExtension: z.ZodType<ExtensionValue>;
  catalogOutputExtension: ExtensionValue;
};

const pageSchema = z.object({ cursor: z.string().optional(), limit: z.number().int().min(1).max(100).default(20) }).strict();
const catalogSearchSchema = z.object({
  query: z.string().trim().min(1).max(500).optional(),
  page: pageSchema.default({ limit: 20 }),
  extension: z.unknown().optional(),
}).strict();
const knowledgeSearchSchema = z.object({
  query: z.string().trim().min(1).max(500),
  page: pageSchema.default({ limit: 20 }),
  extension: z.record(z.string(), z.unknown()).optional(),
}).strict();
const availabilitySearchSchema = z.object({
  resource: ResourceRefSchema,
  from: z.string().datetime({ offset: true }),
  to: z.string().datetime({ offset: true }),
  extension: z.record(z.string(), z.unknown()).optional(),
}).strict();
const bookingPrepareSchema = z.object({
  resource: ResourceRefSchema,
  optionRef: z.string().trim().min(1).max(512),
  extension: z.record(z.string(), z.unknown()).optional(),
}).strict();

export class SyntheticCapabilityLaboratory {
  private readonly tenants = new Map<string, { configuration: SyntheticTenantConfiguration; connector: SyntheticConnector }>();

  constructor(configurations: readonly SyntheticTenantConfiguration[]) {
    for (const configuration of configurations) {
      const tenantId = z.string().uuid().parse(configuration.tenantId);
      if (this.tenants.has(tenantId)) throw new Error(`Duplicate synthetic tenant: ${tenantId}`);
      z.string().uuid().parse(configuration.connectorBindingId);
      for (const bindingId of Object.values(configuration.capabilityBindings)) z.string().uuid().parse(bindingId);
      this.tenants.set(tenantId, { configuration, connector: new SyntheticConnector(configuration) });
    }
  }

  availableOperations(tenantId: string): CapabilityOperationId[] {
    const configuration = this.requireTenant(tenantId).configuration;
    return [
      ...(configuration.capabilityBindings.knowledge ? ["knowledge.search" as const] : []),
      ...(configuration.capabilityBindings.catalog ? ["catalog.search" as const] : []),
      ...(configuration.capabilityBindings.availability ? ["availability.search" as const] : []),
      ...(configuration.capabilityBindings.booking ? ["booking.prepare" as const] : []),
    ];
  }

  async execute<T extends PortableOperationId>(tenantId: string, operationId: T, input: unknown): Promise<PortableOperationResult[T]> {
    const tenant = this.requireTenant(tenantId);
    const capability = operationId.split(".")[0] as PortableCapability;
    const capabilityBindingId = tenant.configuration.capabilityBindings[capability];
    if (!capabilityBindingId) throw new Error(`Capability ${capability} is not granted to this synthetic tenant.`);
    return executeSharedCapabilityTool(tenant.connector, operationId, input, context(
      tenant.configuration.tenantId,
      tenant.configuration.connectorBindingId,
      capabilityBindingId,
    ));
  }

  ports(tenantId: string): PortablePorts {
    return this.requireTenant(tenantId).connector;
  }

  context(tenantId: string, capability: PortableCapability): CapabilityContext {
    const tenant = this.requireTenant(tenantId);
    const capabilityBindingId = tenant.configuration.capabilityBindings[capability];
    if (!capabilityBindingId) throw new Error(`Capability ${capability} is not granted to this synthetic tenant.`);
    return context(tenantId, tenant.configuration.connectorBindingId, capabilityBindingId);
  }

  private requireTenant(tenantId: string) {
    const tenant = this.tenants.get(tenantId);
    if (!tenant) throw new Error(`Unknown synthetic tenant: ${tenantId}`);
    return tenant;
  }
}

export async function executeSharedCapabilityTool(
  ports: PortablePorts,
  operationId: "knowledge.search",
  input: unknown,
  capabilityContext: CapabilityContext,
): Promise<PortableOperationResult["knowledge.search"]>;
export async function executeSharedCapabilityTool(
  ports: PortablePorts,
  operationId: "catalog.search",
  input: unknown,
  capabilityContext: CapabilityContext,
): Promise<PortableOperationResult["catalog.search"]>;
export async function executeSharedCapabilityTool(
  ports: PortablePorts,
  operationId: "availability.search",
  input: unknown,
  capabilityContext: CapabilityContext,
): Promise<PortableOperationResult["availability.search"]>;
export async function executeSharedCapabilityTool(
  ports: PortablePorts,
  operationId: "booking.prepare",
  input: unknown,
  capabilityContext: CapabilityContext,
): Promise<PortableOperationResult["booking.prepare"]>;
export async function executeSharedCapabilityTool(
  ports: PortablePorts,
  operationId: PortableOperationId,
  input: unknown,
  capabilityContext: CapabilityContext,
) {
  switch (operationId) {
    case "knowledge.search": {
      const parsed = knowledgeSearchSchema.parse(input);
      return ports.knowledge.search(parsed, capabilityContext);
    }
    case "catalog.search": {
      const parsed = catalogSearchSchema.parse(input);
      const extension = parsed.extension === undefined
        ? undefined
        : z.record(z.string(), z.unknown()).parse(parsed.extension);
      return ports.catalog.search({ ...parsed, extension }, capabilityContext);
    }
    case "availability.search": {
      const parsed = availabilitySearchSchema.parse(input);
      return ports.availability.search(parsed, capabilityContext);
    }
    case "booking.prepare": {
      const parsed = bookingPrepareSchema.parse(input);
      return ports.booking.prepare(parsed, capabilityContext);
    }
    default:
      throw new Error(`Operation ${operationId} is not part of the synthetic portability catalog.`);
  }
}

class SyntheticConnector {
  constructor(private readonly configuration: SyntheticTenantConfiguration) {}

  get knowledge(): KnowledgePort { return { search: this.searchKnowledge.bind(this) }; }
  get catalog(): CatalogPort { return { search: this.search.bind(this), get: this.get.bind(this), getMedia: this.getMedia.bind(this) }; }
  get availability(): AvailabilityPort { return { search: this.searchAvailability.bind(this), revalidate: this.revalidate.bind(this) }; }
  get booking(): BookingPort { return { prepare: this.prepare.bind(this), commit: this.commit.bind(this), getStatus: this.getStatus.bind(this), reconcile: this.reconcile.bind(this) }; }

  async search(input: { query?: string; page: { cursor?: string; limit: number }; extension?: ExtensionValue }, capabilityContext: CapabilityContext) {
    this.assertContext(capabilityContext);
    const extension = this.configuration.catalogInputExtension.parse(input.extension ?? {});
    return {
      items: [CatalogItemSchema.parse({
        resource: this.resource(),
        title: this.configuration.wording.catalogTitle,
        summary: input.query ? `Matched ${input.query}` : "Configured fixture item",
        extension: { ...this.configuration.catalogOutputExtension, acceptedInput: extension },
      })],
      page: { hasMore: false },
    };
  }

  async get(input: { resource: z.infer<typeof ResourceRefSchema> }, capabilityContext: CapabilityContext) {
    this.assertContext(capabilityContext);
    this.assertResource(input.resource);
    return { item: CatalogItemSchema.parse({ resource: input.resource, title: this.configuration.wording.catalogTitle }) };
  }

  async getMedia(input: { resource: z.infer<typeof ResourceRefSchema> }, capabilityContext: CapabilityContext) {
    this.assertContext(capabilityContext);
    this.assertResource(input.resource);
    return { items: [] };
  }

  async searchAvailability(input: { resource: z.infer<typeof ResourceRefSchema>; from: string; to: string }, capabilityContext: CapabilityContext) {
    this.assertContext(capabilityContext);
    this.assertResource(input.resource);
    return { options: [AvailabilityOptionSchema.parse({
      optionRef: "shared-option",
      resource: input.resource,
      startsAt: input.from,
      endsAt: input.to,
      status: "available",
    })] };
  }

  async revalidate(input: { resource: z.infer<typeof ResourceRefSchema>; optionRef: string }, capabilityContext: CapabilityContext) {
    const result = await this.searchAvailability({
      resource: input.resource,
      from: "2026-10-01T00:00:00.000Z",
      to: "2026-10-01T00:30:00.000Z",
    }, capabilityContext);
    return { option: result.options[0]!, revalidatedAt: "2026-09-25T00:00:00.000Z" };
  }

  async prepare(input: { resource: z.infer<typeof ResourceRefSchema>; optionRef: string }, capabilityContext: CapabilityContext) {
    this.assertContext(capabilityContext);
    this.assertResource(input.resource);
    return PreparedCommandSchema.parse({
      reviewId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      commandId: `${this.configuration.connectorBindingId}:${input.resource.opaqueId}:${input.optionRef}`,
      requestHash: createHash("sha256").update(JSON.stringify(input)).digest("hex"),
      expiresAt: "2026-10-01T01:00:00.000Z",
      summary: this.configuration.wording.bookingSummary,
    });
  }

  async commit(
    _input: { reviewId: string; commandId: string; extension: ExtensionValue },
    _capabilityContext: CapabilityContext,
  ): Promise<CommandReceipt> { throw new Error("Synthetic portability fixtures never commit business mutations."); }
  async getStatus(input: { operationRef: string }) {
    return { operationRef: input.operationRef, status: "succeeded" as const, updatedAt: "2026-09-25T00:00:00.000Z" };
  }
  async reconcile(input: { commandId: string }) {
    return { operationRef: input.commandId, status: "succeeded" as const, updatedAt: "2026-09-25T00:00:00.000Z" };
  }

  private resource() {
    return { connectorBindingId: this.configuration.connectorBindingId, opaqueId: "shared-resource" };
  }

  private assertContext(capabilityContext: CapabilityContext) {
    if (capabilityContext.tenantId !== this.configuration.tenantId ||
        capabilityContext.connectorBindingId !== this.configuration.connectorBindingId) {
      throw new Error("Synthetic connector context is outside the configured tenant binding.");
    }
  }

  private assertResource(resource: z.infer<typeof ResourceRefSchema>) {
    if (resource.connectorBindingId !== this.configuration.connectorBindingId) {
      throw new Error("Resource binding does not match the authorised connector binding.");
    }
  }

  async searchKnowledge(input: { query: string }, capabilityContext: CapabilityContext) {
    this.assertContext(capabilityContext);
    return {
      items: [{
        recordRef: this.resource(),
        title: this.configuration.wording.knowledgeTitle,
        excerpt: `Synthetic answer for ${input.query}`,
        sources: [{
          sourceRef: `${this.configuration.connectorBindingId}:fixture`,
          retrievedAt: "2026-09-25T00:00:00.000Z",
          freshness: "cached" as const,
          accessClassification: "internal" as const,
        }],
      }],
      page: { hasMore: false },
    };
  }
}

function context(tenantId: string, connectorBindingId: string, capabilityBindingId: string): CapabilityContext {
  return {
    tenantId,
    sessionId: `synthetic-${tenantId}`,
    capabilityBindingId,
    connectorBindingId,
    actorRef: "synthetic-test-actor",
    correlationId: "synthetic-test-correlation",
    deadline: "2026-10-01T02:00:00.000Z",
  };
}
