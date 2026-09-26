import type { ToolResult } from "../../src/platform/contracts/v2/sophia-runtime-v2.contracts.js";
import type {
  ReasoningProvider,
  ReasoningProviderEvent,
  ReasoningProviderInput,
  ReasoningProviderSession,
  ReasoningToolDefinition,
} from "../../src/providers/reasoning/reasoning-provider.interface.js";

export const reasoningContractTools: ReasoningToolDefinition[] = [
  { name: "catalog.search", description: "Search the configured catalog.", inputSchema: objectSchema({ query: { type: "string" } }, ["query"]) },
  { name: "booking.prepare", description: "Prepare exact booking details for review.", inputSchema: objectSchema({ propertyId: { type: "string" } }, ["propertyId"]) },
];

export const reasoningContractContext = {
  customerId: "11111111-1111-4111-8111-111111111111",
  sessionId: "22222222-2222-4222-8222-222222222222",
  sessionAccessToken: "test-session-access-token",
  instructions: "Help the visitor using only the provided tools.",
};

export class ScriptedReasoningProvider implements ReasoningProvider {
  readonly inputs: ReasoningProviderInput[] = [];
  closed = false;
  constructor(private readonly steps: ReasoningProviderEvent[][]) {}
  async open(): Promise<ReasoningProviderSession> {
    let index = 0;
    const provider = this;
    return {
      stream: async function* (input: ReasoningProviderInput) {
        provider.inputs.push(input);
        for (const event of provider.steps[index++] ?? []) yield event;
      },
      close: async () => { provider.closed = true; },
    };
  }
}

export function succeededToolResult(toolCallId: string, toolId: string, data: Record<string, unknown>): ToolResult {
  return { toolCallId, toolId, status: "succeeded", capability: toolId.split(".")[0], data };
}

export function sseResponse(events: unknown[], status = 200): Response {
  const body = events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("") + "data: [DONE]\n\n";
  return new Response(body, { status, headers: { "content-type": "text/event-stream" } });
}

function objectSchema(properties: Record<string, unknown>, required: string[]) {
  return { type: "object", additionalProperties: false, properties, required };
}
