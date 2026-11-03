import { describe, test, expect, jest } from "@jest/globals";
import { sendText } from "../src/adapters/whatsapp/outbound.js";
const profile = {
  phoneNumberId: "123456",
  accessToken: "test-secret-token",
  graphVersion: "v25.0",
  sendingEnabled: true,
};
const message = {
  recipient: "61412345678",
  body: "Hello",
  messageId: "11111111-1111-4111-8111-111111111111",
};
describe("WhatsApp outbound protocol and ambiguous delivery", () => {
  test("sends through the pinned official endpoint and includes opaque reconciliation identity", async () => {
    const fetchImpl = jest
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ messages: [{ id: "wamid.123" }] }), {
          status: 200,
        }),
      );
    expect(await sendText(profile, message, { fetchImpl })).toEqual({
      kind: "accepted",
      providerMessageId: "wamid.123",
    });
    const [url, options] = fetchImpl.mock.calls[0];
    expect(url).toBe("https://graph.facebook.com/v25.0/123456/messages");
    expect(options.redirect).toBe("error");
    expect(JSON.parse(options.body)).toMatchObject({
      biz_opaque_callback_data: message.messageId,
      to: message.recipient,
      text: { body: "Hello", preview_url: false },
    });
  });
  test("network failures, 5xx, malformed success and empty message IDs are unknown, never blindly retryable", async () => {
    for (const response of [
      new Response("{}", { status: 500 }),
      new Response("not-json", { status: 200 }),
      new Response('{"messages":[{"id":""}]}', { status: 200 }),
    ])
      expect(
        (
          await sendText(profile, message, {
            fetchImpl: jest.fn().mockResolvedValue(response),
          })
        ).kind,
      ).toBe("unknown");
    expect(
      (
        await sendText(profile, message, {
          fetchImpl: jest.fn().mockRejectedValue(new Error("timeout")),
        })
      ).kind,
    ).toBe("unknown");
  });
  test("only rate limits retry; errors stay classified without returning provider payloads", async () => {
    expect(
      await sendText(profile, message, {
        fetchImpl: jest
          .fn()
          .mockResolvedValue(
            new Response("secret", {
              status: 429,
              headers: { "retry-after": "120" },
            }),
          ),
      }),
    ).toEqual({ kind: "retry", seconds: 120 });
    expect(
      await sendText(profile, message, {
        fetchImpl: jest
          .fn()
          .mockResolvedValue(new Response("secret", { status: 401 })),
      }),
    ).toEqual({ kind: "failed", code: "connection_attention" });
  });
  test("requires explicit profile enablement and bounds successful response size", async () => {
    await expect(
      sendText({ ...profile, sendingEnabled: false }, message),
    ).rejects.toThrow("unavailable");
    expect(
      (
        await sendText(profile, message, {
          fetchImpl: jest
            .fn()
            .mockResolvedValue(
              new Response("x".repeat(40000), { status: 200 }),
            ),
        })
      ).kind,
    ).toBe("unknown");
  });
});
