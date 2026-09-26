import { z } from "zod";

export type RuntimeToolDefinition = {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
};

export type RuntimeToolContext = {
  customerId: string;
  sessionId?: string;
  storeId?: string;
  providerCallId?: string;
  providerEventId?: string;
  eventSource?: "browser" | "provider_sideband";
  correlationId?: string;
  capabilityBindingId?: string;
  commandId?: string;
  workflowVersions?: readonly { templateKey: string; workflowVersionId: string }[];
  abortSignal?: AbortSignal;
  provenance?: "server-provider-connection" | "verified-provider-webhook" | "authenticated-user-action" | "untrusted-client-bridge";
};

export type RuntimeToolPolicy = {
  toolId: string;
  version: string;
  requiredCapability: string;
  requiredScopes: string[];
  riskClass: "low" | "medium" | "high";
  sideEffectClass: "read" | "ephemeral-ui" | "prepare-command" | "business-mutation" | "notification" | "handoff";
  confirmationPolicy: "none" | "explicit-user-review";
  timeoutMs: number;
  retryPolicy: "none" | "safe-read" | "idempotent-command";
  idempotencyPolicy: "not-applicable" | "tool-call" | "stable-command";
};

export type RuntimeTool<TInput, TOutput> = {
  definition: RuntimeToolDefinition;
  inputSchema: z.ZodType<TInput>;
  outputSchema?: z.ZodType<TOutput>;
  policy?: RuntimeToolPolicy;
  reviewAuthorization?: {
    mode: string;
    payload(input: TInput): Record<string, unknown>;
  };
  execute(input: TInput, context: RuntimeToolContext): Promise<TOutput>;
};

export class ToolRegistry {
  private readonly tools = new Map<string, RuntimeTool<unknown, unknown>>();
  private readonly aliases = new Map<string, RuntimeTool<unknown, unknown>>();

  register<TInput, TOutput>(tool: RuntimeTool<TInput, TOutput>): void {
    if (this.tools.has(tool.definition.name) || this.aliases.has(tool.definition.name)) {
      throw new Error(`Tool already registered: ${tool.definition.name}`);
    }
    const registered = tool as RuntimeTool<unknown, unknown>;
    this.tools.set(tool.definition.name, registered);
    if (tool.policy) {
      if (tool.policy.toolId !== tool.definition.name &&
        (this.aliases.has(tool.policy.toolId) || this.tools.has(tool.policy.toolId))) {
        throw new Error(`Tool alias already registered: ${tool.policy.toolId}`);
      }
      if (tool.policy.toolId !== tool.definition.name) this.aliases.set(tool.policy.toolId, registered);
    }
  }

  listDefinitions(): RuntimeToolDefinition[] {
    return [...this.tools.values()].map((tool) => tool.definition);
  }

  listPolicies(): RuntimeToolPolicy[] {
    return [...this.tools.values()].flatMap((tool) => tool.policy ? [tool.policy] : []);
  }

  listDefinitionsForCapabilities(capabilities: ReadonlySet<string>, canonicalNames = false): RuntimeToolDefinition[] {
    return [...this.tools.values()]
      .filter((tool) => tool.policy && capabilities.has(tool.policy.requiredCapability))
      .map((tool) => ({
        ...tool.definition,
        name: canonicalNames ? tool.policy!.toolId : tool.definition.name,
      }));
  }

  resolve(name: string): RuntimeTool<unknown, unknown> | undefined {
    return this.tools.get(name) ?? this.aliases.get(name);
  }

  require(name: string): RuntimeTool<unknown, unknown> {
    const tool = this.resolve(name);
    if (!tool) throw new Error(`Unknown runtime tool: ${name}`);
    return tool;
  }

  async execute(
    name: string,
    input: unknown,
    context: RuntimeToolContext,
  ): Promise<unknown> {
    const tool = this.require(name);

    const parsedInput = tool.inputSchema.parse(input);
    const output = await tool.execute(parsedInput, context);
    return tool.outputSchema ? tool.outputSchema.parse(output) : output;
  }
}
