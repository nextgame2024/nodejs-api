import {
  Injectable,
  Logger,
  ServiceUnavailableException,
} from "@nestjs/common";
import { runtimeConfig } from "../../config/runtime-config.js";
import { sophiaConversationInstructions } from "../../knowledge/sophia-profile.js";
import type { RuntimeToolDefinition } from "../../tools/tool-registry.js";

export type TavusFullSessionRequest = {
  customerId: string;
  deviceId?: string;
  storeId?: string;
  tools?: RuntimeToolDefinition[];
};

export type TavusFullSession = {
  provider: "tavus-full";
  providerSessionId: string;
  model: "tavus-gpt-oss";
  outputModality: "audio";
  conversationUrl: string;
  meetingToken?: string;
};

type TavusConversationResponse = {
  conversation_id?: string;
  conversation_url?: string;
  meeting_token?: string;
};

@Injectable()
export class TavusFullProvider {
  private readonly logger = new Logger(TavusFullProvider.name);
  private internetSearchConfigured = false;
  private runtimeToolsConfigured = false;

  async createSession(
    request: TavusFullSessionRequest,
  ): Promise<TavusFullSession> {
    const startedAt = Date.now();
    const config = runtimeConfig();
    const { apiKey, apiBaseUrl, personaId, replicaId } = config.tavus;

    if (!apiKey || !personaId) {
      throw new ServiceUnavailableException(
        "TAVUS_API_KEY and TAVUS_PERSONA_ID are required for Tavus Full sessions.",
      );
    }
    if (!config.tavus.nativeLlmOnly) {
      throw new ServiceUnavailableException(
        "Set TAVUS_NATIVE_LLM_ONLY=true after confirming the Tavus Persona uses tavus-gpt-oss and has no custom OpenAI LLM layer.",
      );
    }
    const setupOperations: Array<{ name: string; promise: Promise<void> }> = [];
    if (config.tavus.internetSearchEnabled) {
      setupOperations.push({
        name: "internet search",
        promise: this.ensureInternetSearchSkill(apiBaseUrl, apiKey, personaId),
      });
    }
    if (request.tools?.length) {
      setupOperations.push({
        name: "runtime tools",
        promise: this.ensureRuntimeTools(
          apiBaseUrl,
          apiKey,
          personaId,
          request.tools,
        ),
      });
    }

    const setupPromise = Promise.all(
      setupOperations.map(async ({ name, promise }) => {
        const operationStartedAt = Date.now();
        try {
          await promise;
          this.logger.log(
            `Tavus ${name} setup completed in ${Date.now() - operationStartedAt}ms.`,
          );
        } catch (error) {
          this.logger.warn(
            `Tavus ${name} setup failed after ${Date.now() - operationStartedAt}ms; conversation creation will continue. ${errorMessage(error)}`,
          );
        }
      }),
    );

    let response: Response;
    try {
      [, response] = await Promise.all([
        setupPromise,
        fetch(`${apiBaseUrl}/v2/conversations`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-api-key": apiKey,
          },
          signal: AbortSignal.timeout(20_000),
          body: JSON.stringify({
            persona_id: personaId,
            ...(replicaId ? { replica_id: replicaId } : {}),
            conversation_name: `Sophia - ${request.storeId || request.customerId}`,
            conversational_context: [
              sophiaConversationInstructions(),
              request.storeId ? `Store identifier: ${request.storeId}.` : "",
              "Use only the native Tavus Full conversational pipeline. Use the attached internet search skill for questions about named businesses and current public information.",
            ]
              .filter(Boolean)
              .join(" "),
            require_auth: true,
            max_participants: 2,
          }),
        }),
      ]);
    } catch (error) {
      const message = `Tavus could not be reached: ${errorMessage(error)}`;
      this.logger.error(message);
      throw new ServiceUnavailableException(message);
    }

    if (!response.ok) {
      const detail = await response.text();
      const message = `Tavus conversation request failed (${response.status}): ${providerDetail(detail)}`;
      this.logger.error(message);
      throw new ServiceUnavailableException(message);
    }

    const payload = (await response.json()) as TavusConversationResponse;
    if (
      !payload.conversation_id ||
      !payload.conversation_url ||
      !payload.meeting_token
    ) {
      if (payload.conversation_id) {
        await this.closeSession(payload.conversation_id).catch(() => undefined);
      }
      const message =
        "Tavus conversation response did not include its ID, URL, and private-room meeting token.";
      this.logger.error(message);
      throw new ServiceUnavailableException(message);
    }

    this.logger.log(
      `Tavus conversation ${payload.conversation_id} created in ${Date.now() - startedAt}ms.`,
    );

    return {
      provider: "tavus-full",
      providerSessionId: payload.conversation_id,
      model: "tavus-gpt-oss",
      outputModality: "audio",
      conversationUrl: payload.conversation_url,
      meetingToken: payload.meeting_token,
    };
  }

  async closeSession(conversationId: string): Promise<void> {
    const config = runtimeConfig();
    if (!config.tavus.apiKey) {
      throw new Error("TAVUS_API_KEY is required to end a Tavus conversation.");
    }

    const response = await fetch(
      `${config.tavus.apiBaseUrl}/v2/conversations/${encodeURIComponent(conversationId)}/end`,
      {
        method: "POST",
        headers: { "x-api-key": config.tavus.apiKey },
        signal: AbortSignal.timeout(15_000),
      },
    );

    if (!response.ok) {
      const detail = await response.text();
      throw new Error(
        `Tavus conversation end request failed: ${response.status} ${detail}`,
      );
    }
  }

  private async ensureInternetSearchSkill(
    apiBaseUrl: string,
    apiKey: string,
    personaId: string,
  ): Promise<void> {
    if (this.internetSearchConfigured) return;

    const response = await fetch(
      `${apiBaseUrl}/v2/pals/${encodeURIComponent(personaId)}/skills/internet_search`,
      {
        method: "PUT",
        headers: {
          "content-type": "application/json",
          "x-api-key": apiKey,
        },
        signal: AbortSignal.timeout(12_000),
        body: "{}",
      },
    );
    if (!response.ok) {
      const detail = await response.text();
      throw new Error(
        `Tavus internet search activation failed: ${response.status} ${detail}`,
      );
    }

    this.internetSearchConfigured = true;
  }

  private async ensureRuntimeTools(
    apiBaseUrl: string,
    apiKey: string,
    personaId: string,
    definitions: RuntimeToolDefinition[],
  ): Promise<void> {
    if (this.runtimeToolsConfigured) return;

    const existingResponse = await fetch(`${apiBaseUrl}/v2/tools?limit=100`, {
      headers: { "x-api-key": apiKey },
      signal: AbortSignal.timeout(12_000),
    });
    if (!existingResponse.ok) {
      const detail = await existingResponse.text();
      throw new Error(`Tavus tool listing failed: ${existingResponse.status} ${detail}`);
    }
    const existingPayload = await existingResponse.json() as {
      data?: Array<{ tool_id?: string; name?: string }>;
      tools?: Array<{ tool_id?: string; name?: string }>;
    };
    const existingTools = existingPayload.data || existingPayload.tools || [];
    const toolIds: string[] = [];

    for (const definition of definitions) {
      const existing = existingTools.find((tool) => tool.name === definition.name);
      if (existing?.tool_id) {
        await this.updateTavusTool(apiBaseUrl, apiKey, existing.tool_id, definition);
        toolIds.push(existing.tool_id);
        continue;
      }

      const response = await fetch(`${apiBaseUrl}/v2/tools`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": apiKey },
        signal: AbortSignal.timeout(12_000),
        body: JSON.stringify(this.tavusToolPayload(definition)),
      });
      const detail = await response.text();
      if (!response.ok) {
        throw new Error(`Tavus tool creation failed for ${definition.name}: ${response.status} ${detail}`);
      }
      const created = JSON.parse(detail) as { tool_id?: string };
      if (!created.tool_id) throw new Error(`Tavus did not return a tool ID for ${definition.name}.`);
      toolIds.push(created.tool_id);
    }

    const attachedResponse = await fetch(
      `${apiBaseUrl}/v2/pals/${encodeURIComponent(personaId)}/tools`,
      {
        headers: { "x-api-key": apiKey },
        signal: AbortSignal.timeout(12_000),
      },
    );
    if (!attachedResponse.ok) {
      const detail = await attachedResponse.text();
      throw new Error(`Tavus PAL tool listing failed: ${attachedResponse.status} ${detail}`);
    }
    const attachedPayload = await attachedResponse.json() as {
      data?: Array<{ tool_id?: string }>;
      tools?: Array<{ tool_id?: string }>;
    };
    const attachedIds = new Set(
      (attachedPayload.data || attachedPayload.tools || [])
        .map((tool) => tool.tool_id)
        .filter((id): id is string => Boolean(id)),
    );
    const missingIds = toolIds.filter((id) => !attachedIds.has(id));
    if (missingIds.length) {
      const attachResponse = await fetch(
        `${apiBaseUrl}/v2/pals/${encodeURIComponent(personaId)}/tools`,
        {
          method: "POST",
          headers: { "content-type": "application/json", "x-api-key": apiKey },
          signal: AbortSignal.timeout(12_000),
          body: JSON.stringify({ tool_ids: missingIds }),
        },
      );
      if (!attachResponse.ok) {
        const detail = await attachResponse.text();
        throw new Error(`Tavus PAL tool attachment failed: ${attachResponse.status} ${detail}`);
      }
    }

    this.runtimeToolsConfigured = true;
  }

  private async updateTavusTool(
    apiBaseUrl: string,
    apiKey: string,
    toolId: string,
    definition: RuntimeToolDefinition,
  ): Promise<void> {
    const response = await fetch(`${apiBaseUrl}/v2/tools/${encodeURIComponent(toolId)}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", "x-api-key": apiKey },
      signal: AbortSignal.timeout(12_000),
      body: JSON.stringify(this.tavusToolPayload(definition)),
    });
    if (!response.ok) {
      const detail = await response.text();
      throw new Error(`Tavus tool update failed for ${definition.name}: ${response.status} ${detail}`);
    }
  }

  private tavusToolPayload(definition: RuntimeToolDefinition) {
    return {
      name: definition.name,
      description: definition.description,
      parameters: definition.parameters,
      origin: "llm",
      on_call: "generate_filler",
      on_resolve: "generate_response",
      delivery: { app_message: true },
    };
  }
}

function providerDetail(detail: string): string {
  const normalized = detail.replace(/\s+/g, " ").trim();
  return normalized ? normalized.slice(0, 600) : "No additional detail provided.";
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message
    ? error.message
    : "Unknown Tavus error.";
}
