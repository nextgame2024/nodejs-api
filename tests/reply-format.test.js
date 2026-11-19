import {
  replyFormat,
  requestedReplyFormat,
} from "../src/services/messaging/reply-format.js";
const text = (body) => ({ body, metadata: { messageType: "text" } });
const audio = (body) => ({
  body,
  metadata: { messageType: "text", transcriptOf: 12 },
});
test("matches text, audio and voice transcripts by default", () => {
  expect(replyFormat([text("Hello")])).toBe("text");
  expect(replyFormat([{ metadata: { messageType: "audio" } }])).toBe("voice");
  expect(replyFormat([audio("Hello")])).toBe("voice");
  expect(replyFormat([text("Next question"), audio("Hello")])).toBe("text");
});
test("explicit voice preference survives later text and can be revoked", () => {
  const preference = text("Please always reply by voice");
  expect(replyFormat([text("What are your services?"), preference])).toBe(
    "voice",
  );
  expect(replyFormat([text("Please respond by text"), preference])).toBe(
    "text",
  );
  expect(
    replyFormat([
      text("Another question"),
      text("Stop voice replies"),
      preference,
    ]),
  ).toBe("text");
  expect(requestedReplyFormat("Contesta siempre por voz")).toBe("voice");
  expect(requestedReplyFormat("Can I send a voice message?")).toBeNull();
});
