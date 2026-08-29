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
};

export type RuntimeTool<TInput, TOutput> = {
  definition: RuntimeToolDefinition;
  inputSchema: z.ZodType<TInput>;
  execute(input: TInput, context: RuntimeToolContext): Promise<TOutput>;
};

export class ToolRegistry {
  private readonly tools = new Map<string, RuntimeTool<unknown, unknown>>();

  register<TInput, TOutput>(tool: RuntimeTool<TInput, TOutput>): void {
    if (this.tools.has(tool.definition.name)) {
      throw new Error(`Tool already registered: ${tool.definition.name}`);
    }
    this.tools.set(
      tool.definition.name,
      tool as RuntimeTool<unknown, unknown>,
    );
  }

  listDefinitions(): RuntimeToolDefinition[] {
    return [...this.tools.values()].map((tool) => tool.definition);
  }

  async execute(
    name: string,
    input: unknown,
    context: RuntimeToolContext,
  ): Promise<unknown> {
    const tool = this.tools.get(name);
    if (!tool) throw new Error(`Unknown runtime tool: ${name}`);

    const parsedInput = tool.inputSchema.parse(input);
    return tool.execute(parsedInput, context);
  }
}
