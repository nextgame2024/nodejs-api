import { z } from "zod";
import {
  CatalogItemSchema,
  MediaItemSchema,
  PageInfoSchema,
  PageRequestSchema,
  ResourceRefSchema,
  SourceMetadataSchema,
  type CapabilityContext,
  type ExtensionValue,
} from "../contracts/business-capability.contracts.js";
import { CapabilityExtensionRegistry } from "../extensions/capability-extension.registry.js";
import type { CatalogPort } from "../ports/business-capability.ports.js";

const searchInputSchema = z.object({
  query: z.string().trim().min(1).max(500).optional(),
  page: PageRequestSchema,
  extension: z.unknown().optional(),
}).strict();

const resourceInputSchema = z.object({
  resource: ResourceRefSchema,
  extension: z.unknown().optional(),
}).strict();

export class CatalogCapabilityService {
  constructor(
    private readonly port: CatalogPort,
    private readonly extensions: CapabilityExtensionRegistry,
  ) {}

  async search(input: unknown, context: CapabilityContext) {
    const parsed = searchInputSchema.parse(input);
    const extension = this.extensions.parseInput<ExtensionValue>(
      context.capabilityBindingId, "catalog.search", parsed.extension ?? {},
    );
    const result = await this.port.search({ ...parsed, extension }, context);
    const page = PageInfoSchema.parse(result.page);
    const sources = result.sources?.map((source) => SourceMetadataSchema.parse(source));
    const items = result.items.map((candidate) => {
      const item = CatalogItemSchema.parse(candidate);
      return {
        ...item,
        extension: this.extensions.parseOutput<ExtensionValue>(
          context.capabilityBindingId, "catalog.search", item.extension ?? {},
        ),
      };
    });
    return { items, page, ...(sources ? { sources } : {}) };
  }

  async get(input: unknown, context: CapabilityContext) {
    const parsed = resourceInputSchema.parse(input);
    const extension = this.extensions.parseInput<ExtensionValue>(
      context.capabilityBindingId, "catalog.get", parsed.extension ?? {},
    );
    const result = await this.port.get({ ...parsed, extension }, context);
    const item = CatalogItemSchema.parse(result.item);
    return {
      item: {
        ...item,
        extension: this.extensions.parseOutput<ExtensionValue>(
          context.capabilityBindingId, "catalog.get", item.extension ?? {},
        ),
      },
      ...(result.sources ? { sources: result.sources.map((source) => SourceMetadataSchema.parse(source)) } : {}),
    };
  }

  async getMedia(input: unknown, context: CapabilityContext) {
    const parsed = resourceInputSchema.parse(input);
    const extension = this.extensions.parseInput<ExtensionValue>(
      context.capabilityBindingId, "catalog.media", parsed.extension ?? {},
    );
    const result = await this.port.getMedia({ ...parsed, extension }, context);
    return {
      items: result.items.map((candidate) => {
        const item = MediaItemSchema.parse(candidate);
        return {
          ...item,
          extension: this.extensions.parseOutput<ExtensionValue>(
            context.capabilityBindingId, "catalog.media", item.extension ?? {},
          ),
        };
      }),
      ...(result.sources ? { sources: result.sources.map((source) => SourceMetadataSchema.parse(source)) } : {}),
    };
  }
}
