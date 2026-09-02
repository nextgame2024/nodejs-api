import { Injectable } from "@nestjs/common";
import { runtimeConfig } from "../../config/runtime-config.js";
import { sophiaConversationInstructions } from "../../knowledge/sophia-profile.js";

export type TavusFullSessionRequest = {
  customerId: string;
  deviceId?: string;
  storeId?: string;
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
  private internetSearchConfigured = false;

  async createSession(
    request: TavusFullSessionRequest,
  ): Promise<TavusFullSession> {
    const config = runtimeConfig();
    const { apiKey, apiBaseUrl, personaId, replicaId } = config.tavus;

    if (!apiKey || !personaId) {
      throw new Error(
        "TAVUS_API_KEY and TAVUS_PERSONA_ID are required for Tavus Full sessions.",
      );
    }
    if (!config.tavus.nativeLlmOnly) {
      throw new Error(
        "Set TAVUS_NATIVE_LLM_ONLY=true after confirming the Tavus Persona uses tavus-gpt-oss and has no custom OpenAI LLM layer.",
      );
    }
    if (config.tavus.internetSearchEnabled) {
      await this.ensureInternetSearchSkill(apiBaseUrl, apiKey, personaId);
    }

    const response = await fetch(`${apiBaseUrl}/v2/conversations`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
      },
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
    });

    if (!response.ok) {
      const detail = await response.text();
      throw new Error(
        `Tavus conversation request failed: ${response.status} ${detail}`,
      );
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
      throw new Error(
        "Tavus conversation response did not include its ID, URL, and private-room meeting token.",
      );
    }

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
}
