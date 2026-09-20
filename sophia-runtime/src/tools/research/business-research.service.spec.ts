import { afterEach, beforeEach, describe, expect, it, jest } from "@jest/globals";
import { BusinessResearchService } from "./business-research.service.js";

describe("BusinessResearchService", () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    process.env.SOPHIA_RUNTIME_DATABASE_URL = "postgres://example";
    process.env.OPENAI_API_KEY = "test-openai-key";
    process.env.OPENAI_RESEARCH_MODEL = "test-research-model";
  });

  afterEach(() => {
    global.fetch = originalFetch;
    delete process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_RESEARCH_MODEL;
  });

  it("returns a concise answer and cited public sources", async () => {
    const fetchMock = jest.fn<typeof fetch>().mockResolvedValue({
      ok: true,
      json: async () => ({
        output: [
          {
            type: "web_search_call",
            action: {
              sources: [
                {
                  title: "Sushi Train Australia",
                  url: "https://www.sushitrain.com.au/",
                },
              ],
            },
          },
          {
            type: "message",
            content: [
              {
                type: "output_text",
                text: "Sushi Train operates Japanese dining locations in Australia.",
                annotations: [
                  {
                    type: "url_citation",
                    title: "Sushi Train",
                    url: "https://www.sushitrain.com.au/",
                  },
                ],
              },
            ],
          },
        ],
      }),
    } as Response);
    global.fetch = fetchMock;

    const result = await new BusinessResearchService().research({
      businessName: "Sushi Train",
      location: "Australia",
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.openai.com/v1/responses",
      expect.objectContaining({ method: "POST" }),
    );
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({
      model: "test-research-model",
      tools: [{ type: "web_search" }],
      input: "Business: Sushi Train\nLocation: Australia",
    });
    expect(result).toMatchObject({
      businessName: "Sushi Train",
      location: "Australia",
      status: "completed",
      officialWebsite: "https://www.sushitrain.com.au/",
      sources: [
        {
          title: "Sushi Train Australia",
          url: "https://www.sushitrain.com.au/",
        },
      ],
    });
  });

  it("handles missing server-side OpenAI credentials without a 500", async () => {
    delete process.env.OPENAI_API_KEY;

    await expect(
      new BusinessResearchService().research({ businessName: "Example" }),
    ).resolves.toMatchObject({
      businessName: "Example",
      status: "unavailable",
      sources: [],
    });
  });

  it("returns an unavailable result instead of failing the conversation", async () => {
    global.fetch = jest.fn<typeof fetch>().mockResolvedValue({
      ok: false,
      status: 429,
      headers: new Headers({ "x-request-id": "req_test" }),
      text: async () => JSON.stringify({ error: { message: "rate limited" } }),
    } as Response);

    await expect(
      new BusinessResearchService().research({ businessName: "Example" }),
    ).resolves.toMatchObject({
      businessName: "Example",
      status: "unavailable",
      sources: [],
    });
  });
});
