import { z } from "zod";
import { CapabilityOperationIdSchema, type CapabilityOperationId } from "../contracts/business-capability.contracts.js";

const identifier = z.string().trim().min(1).max(160);

export const CapabilityExtensionMetadataSchema = z.object({
  schemaId: identifier,
  schemaVersion: identifier,
  dataClassification: z.array(z.enum(["public", "internal", "personal", "sensitive"])).min(1),
  maximumItems: z.number().int().min(1).max(100).optional(),
}).strict();

export type CapabilityExtensionDefinition<TInput = unknown, TOutput = unknown> = {
  capabilityBindingId: string;
  operationId: CapabilityOperationId;
  metadata: z.infer<typeof CapabilityExtensionMetadataSchema>;
  inputSchema: z.ZodType<TInput>;
  outputSchema: z.ZodType<TOutput>;
};

export class CapabilityExtensionRegistry {
  private readonly definitions = new Map<string, CapabilityExtensionDefinition>();

  register<TInput, TOutput>(definition: CapabilityExtensionDefinition<TInput, TOutput>): void {
    const parsed = {
      ...definition,
      capabilityBindingId: z.string().uuid().parse(definition.capabilityBindingId),
      operationId: CapabilityOperationIdSchema.parse(definition.operationId),
      metadata: CapabilityExtensionMetadataSchema.parse(definition.metadata),
    } as CapabilityExtensionDefinition;
    const key = extensionKey(parsed.capabilityBindingId, parsed.operationId);
    if (this.definitions.has(key)) throw new Error(`Capability extension already registered: ${key}`);
    this.definitions.set(key, parsed);
  }

  parseInput<T = unknown>(bindingId: string, operationId: CapabilityOperationId, value: unknown): T {
    return this.require(bindingId, operationId).inputSchema.parse(value) as T;
  }

  parseOutput<T = unknown>(bindingId: string, operationId: CapabilityOperationId, value: unknown): T {
    return this.require(bindingId, operationId).outputSchema.parse(value) as T;
  }

  metadata(bindingId: string, operationId: CapabilityOperationId) {
    return this.require(bindingId, operationId).metadata;
  }

  private require(bindingId: string, operationId: CapabilityOperationId): CapabilityExtensionDefinition {
    const key = extensionKey(z.string().uuid().parse(bindingId), CapabilityOperationIdSchema.parse(operationId));
    const definition = this.definitions.get(key);
    if (!definition) throw new Error(`Unknown capability extension: ${key}`);
    return definition;
  }
}

function extensionKey(bindingId: string, operationId: CapabilityOperationId): string {
  return `${bindingId}:${operationId}`;
}
