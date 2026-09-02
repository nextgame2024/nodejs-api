import { Injectable } from "@nestjs/common";
import { runtimeConfig } from "../../config/runtime-config.js";

export type BusinessResearchRequest = {
  businessName: string;
  location?: string;
};

export type BusinessResearchResult = {
  businessName: string;
  location?: string;
  summary: string;
  officialWebsite?: string;
  sources: Array<{ title?: string; url: string }>;
  researchedAt: string;
};

type OpenAiResponse = {
  output?: Array<{
    type?: string;
    action?: {
      sources?: Array<{ title?: string; url?: string }>;
    };
    content?: Array<{
      type?: string;
      text?: string;
      annotations?: Array<{
        type?: string;
        title?: string;
        url?: string;
      }>;
    }>;
  }>;
};

@Injectable()
export class BusinessResearchService {
  async research(
    request: BusinessResearchRequest,
  ): Promise<BusinessResearchResult> {
    const config = runtimeConfig();
    if (!config.openAi.apiKey) {
      throw new Error("OPENAI_API_KEY is required for business research.");
    }

    const location = request.location?.trim() || undefined;
    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        authorization: `Bearer ${config.openAi.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: config.openAi.researchModel,
        tools: [{ type: "web_search", search_context_size: "low" }],
        tool_choice: "auto",
        include: ["web_search_call.action.sources"],
        max_output_tokens: 700,
        instructions: [
          "Research the named business using current public web information.",
          "Use search results only to identify the business and its official website.",
          "Base factual claims on the official website whenever one is available.",
          "If multiple businesses match and the supplied location does not resolve the ambiguity, explain what clarification is needed.",
          "Do not invent an official website, services, locations, prices, opening hours, or policies.",
          "Return a concise spoken-ready answer and mention when information could not be confirmed.",
        ].join(" "),
        input: `Business: ${request.businessName}${location ? `\nLocation: ${location}` : ""}`,
      }),
      signal: AbortSignal.timeout(config.openAi.researchTimeoutMs),
    });

    if (!response.ok) {
      const detail = await response.text();
      throw new Error(
        `OpenAI business research failed: ${response.status} ${detail}`,
      );
    }

    const payload = (await response.json()) as OpenAiResponse;
    const summary = extractOutputText(payload);
    if (!summary) {
      throw new Error("Business research returned no answer.");
    }

    const sources = extractSources(payload);
    return {
      businessName: request.businessName,
      ...(location ? { location } : {}),
      summary,
      officialWebsite: sources[0]?.url,
      sources,
      researchedAt: new Date().toISOString(),
    };
  }
}

function extractOutputText(payload: OpenAiResponse): string {
  return (payload.output || [])
    .flatMap((item) => item.content || [])
    .filter((content) => content.type === "output_text" && content.text)
    .map((content) => content.text?.trim())
    .filter(Boolean)
    .join("\n")
    .trim();
}

function extractSources(
  payload: OpenAiResponse,
): Array<{ title?: string; url: string }> {
  const candidates: Array<{ title?: string; url?: string }> = [];
  for (const item of payload.output || []) {
    candidates.push(...(item.action?.sources || []));
    for (const content of item.content || []) {
      candidates.push(...(content.annotations || []));
    }
  }

  const seen = new Set<string>();
  return candidates
    .filter((source): source is { title?: string; url: string } => {
      if (!source.url || !isPublicHttpUrl(source.url) || seen.has(source.url)) {
        return false;
      }
      seen.add(source.url);
      return true;
    })
    .slice(0, 5)
    .map((source) => ({
      ...(source.title ? { title: source.title } : {}),
      url: source.url,
    }));
}

function isPublicHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}
