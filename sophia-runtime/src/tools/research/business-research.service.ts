import { Injectable, Logger } from "@nestjs/common";
import { runtimeConfig } from "../../config/runtime-config.js";

export type BusinessResearchRequest = {
  businessName: string;
  location?: string;
};

export type BusinessResearchResult = {
  businessName: string;
  location?: string;
  status: "completed" | "unavailable";
  summary: string;
  officialWebsite?: string;
  sources: Array<{ title?: string; url: string }>;
  researchedAt: string;
};

export type OfficialStudentResearchResult = {
  domain: "student_migration";
  question: string;
  status: "official_research" | "unavailable";
  summary: string;
  sources: Array<{ title?: string; url: string }>;
  researchedAt: string;
  liveVerified: boolean;
  guidance: string;
  studentView?: Record<string, unknown>;
};

const officialStudentDomains = [
  "immi.homeaffairs.gov.au",
  "homeaffairs.gov.au",
  "legislation.gov.au",
  "education.gov.au",
  "studyaustralia.gov.au",
  "mara.gov.au",
];

type OpenAiResponse = {
  status?: string;
  error?: {
    code?: string;
    message?: string;
  };
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
  private readonly logger = new Logger(BusinessResearchService.name);

  async research(
    request: BusinessResearchRequest,
  ): Promise<BusinessResearchResult> {
    const config = runtimeConfig();
    if (!config.openAi.apiKey) {
      this.logger.error(
        "Business research is unavailable because OPENAI_API_KEY is not configured.",
      );
      return unavailableResult(
        request,
        request.location?.trim() || undefined,
      );
    }

    const location = request.location?.trim() || undefined;
    try {
      const response = await fetch("https://api.openai.com/v1/responses", {
        method: "POST",
        headers: {
          authorization: `Bearer ${config.openAi.apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: config.openAi.researchModel,
          tools: [{ type: "web_search" }],
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
        this.logger.error(
          `OpenAI business research failed: status=${response.status} model=${config.openAi.researchModel} requestId=${response.headers.get("x-request-id") || "unknown"} detail=${truncate(detail)}`,
        );
        return unavailableResult(request, location);
      }

      const payload = (await response.json()) as OpenAiResponse;
      const summary = extractOutputText(payload);
      if (!summary) {
        this.logger.error(
          `OpenAI business research returned no answer: status=${payload.status || "unknown"} model=${config.openAi.researchModel} requestId=${response.headers.get("x-request-id") || "unknown"} providerError=${truncate(payload.error?.message || payload.error?.code || "none")}`,
        );
        return unavailableResult(request, location);
      }

      const sources = extractSources(payload);
      return {
        businessName: request.businessName,
        ...(location ? { location } : {}),
        status: "completed",
        summary,
        officialWebsite: sources[0]?.url,
        sources,
        researchedAt: new Date().toISOString(),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(
        `OpenAI business research request failed: model=${config.openAi.researchModel} error=${truncate(message)}`,
      );
      return unavailableResult(request, location);
    }
  }

  async researchOfficialStudentInformation(
    question: string,
  ): Promise<OfficialStudentResearchResult> {
    const normalizedQuestion = question.trim();
    const config = runtimeConfig();
    const unavailable = (): OfficialStudentResearchResult => ({
      domain: "student_migration",
      question: normalizedQuestion,
      status: "unavailable",
      summary: "I couldn't confirm this from the approved official Australian sources.",
      sources: [],
      researchedAt: new Date().toISOString(),
      liveVerified: false,
      guidance: "Say that this information could not be confirmed from the approved official sources, then ask whether you can help with something else. Do not answer from memory.",
    });
    if (!config.openAi.apiKey) return unavailable();

    try {
      const response = await fetch("https://api.openai.com/v1/responses", {
        method: "POST",
        headers: {
          authorization: `Bearer ${config.openAi.apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: config.openAi.researchModel,
          tools: [{
            type: "web_search",
            search_context_size: "medium",
            filters: { allowed_domains: officialStudentDomains },
          }],
          tool_choice: "required",
          include: ["web_search_call.action.sources"],
          max_output_tokens: 900,
          instructions: [
            "Answer this Australian student visa or international education question only from the allowed official Australian Government domains returned by web search.",
            "Search before answering. Prefer the Department of Home Affairs and the Federal Register of Legislation; use Education, Study Australia, or OMARA where directly relevant.",
            "State the applicable date, lodgement date, visa condition, location, course type, and exceptions when the sources establish them.",
            "Do not treat a page retrieval date as a rule commencement date. Do not infer eligibility, approval, exemptions, or the absence of a newer rule.",
            "If the official sources do not establish the requested fact, say that it could not be confirmed. Do not answer from model memory or non-government sources.",
            "Keep the answer concise and suitable for speech.",
          ].join(" "),
          input: normalizedQuestion,
        }),
        signal: AbortSignal.timeout(config.openAi.researchTimeoutMs),
      });
      if (!response.ok) return unavailable();
      const payload = (await response.json()) as OpenAiResponse;
      const summary = extractOutputText(payload);
      const sources = extractSources(payload).filter(source =>
        isOfficialStudentResearchUrl(source.url),
      );
      if (!summary || !sources.length) return unavailable();
      const researchedAt = new Date().toISOString();
      return {
        domain: "student_migration",
        question: normalizedQuestion,
        status: "official_research",
        summary,
        sources,
        researchedAt,
        liveVerified: true,
        guidance: "Answer only from this summary and its official cited sources. State that the sources were checked at researchedAt; do not describe researchedAt as the rule's effective date.",
        studentView: {
          title: "Official student information",
          notice: "This answer was researched from approved Australian Government domains. Source and checking dates are shown below.",
          cards: [{
            kind: "answer",
            title: normalizedQuestion,
            summary,
            evidenceStatus: "live",
            verifiedAt: researchedAt,
            applicability: [],
            sources: sources.map(source => ({ ...source, checkedAt: researchedAt, status: "live" })),
            limitations: ["Official research is not an individual eligibility or visa outcome assessment."],
          }],
        },
      };
    } catch (error) {
      this.logger.error(
        `Official student research failed: ${truncate(error instanceof Error ? error.message : String(error))}`,
      );
      return unavailable();
    }
  }
}

function unavailableResult(
  request: BusinessResearchRequest,
  location?: string,
): BusinessResearchResult {
  return {
    businessName: request.businessName,
    ...(location ? { location } : {}),
    status: "unavailable",
    summary:
      "I couldn't access current public website information right now. Please try again shortly.",
    sources: [],
    researchedAt: new Date().toISOString(),
  };
}

function truncate(value: string, maxLength = 500): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength)}...`;
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

function isOfficialStudentResearchUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && officialStudentDomains.some(
      domain => url.hostname === domain || url.hostname.endsWith(`.${domain}`),
    );
  } catch {
    return false;
  }
}
