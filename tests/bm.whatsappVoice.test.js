import { describe, test, expect, jest } from "@jest/globals";
import { createHash } from "node:crypto";
import {
  encodeVoice,
  decodeAudio,
  MAX_INPUT_PCM,
} from "../src/services/messaging/audio/codec.js";
import {
  encryptAudio,
  decryptAudio,
} from "../src/services/messaging/audio/crypto.js";
import { downloadAudio, uploadAudio } from "../src/adapters/whatsapp/media.js";
import { sendAudio } from "../src/adapters/whatsapp/outbound.js";
const profile = {
  customerId: "tenant",
  mediaKeyEnv: "WHATSAPP_UNIT_KEY",
  accessToken: "secret",
  graphVersion: "v25.0",
  phoneNumberId: "123456",
  sendingEnabled: true,
};
const tone = (seconds = 1) => {
  const b = Buffer.alloc(seconds * 48000);
  for (let i = 0; i < b.length / 2; i++)
    b.writeInt16LE(
      Math.round(Math.sin((i / 24000) * 440 * 2 * Math.PI) * 10000),
      i * 2,
    );
  return b;
};
describe("WhatsApp voice boundaries", () => {
  test("encodes interoperable Ogg Opus and decodes bounded PCM without files", async () => {
    const ogg = await encodeVoice(tone());
    expect(ogg.subarray(0, 4).toString()).toBe("OggS");
    expect(ogg.includes(Buffer.from("OpusHead"))).toBe(true);
    const pcm = await decodeAudio(ogg, "audio/ogg; codecs=opus");
    expect(pcm.length).toBeGreaterThan(40000);
    expect(pcm.length).toBeLessThan(50000);
  });
  test("rejects silent, malformed and overlong media and terminates codec timeout", async () => {
    await expect(
      decodeAudio(await encodeVoice(Buffer.alloc(48000)), "audio/ogg"),
    ).rejects.toThrow();
    await expect(
      decodeAudio(Buffer.from("malformed"), "audio/ogg"),
    ).rejects.toThrow();
    await expect(
      decodeAudio(await encodeVoice(tone(61)), "audio/ogg"),
    ).rejects.toThrow();
    await expect(encodeVoice(tone(), { timeoutMs: 1 })).rejects.toThrow();
  }, 10000);
  test("encrypts by tenant/message; rejects tampering and unavailable keys", () => {
    process.env.WHATSAPP_UNIT_KEY = "cd".repeat(32);
    const e = encryptAudio(profile, "message", Buffer.from("private audio"));
    const asset = {
      ...e,
      auth_tag: e.authTag,
      key_fingerprint: e.keyFingerprint,
    };
    expect(decryptAudio(profile, "message", asset).toString()).toBe(
      "private audio",
    );
    expect(() =>
      decryptAudio({ ...profile, customerId: "other" }, "message", asset),
    ).toThrow();
    expect(() => decryptAudio(profile, "other", asset)).toThrow();
    e.ciphertext[0] ^= 1;
    expect(() => decryptAudio(profile, "message", asset)).toThrow();
    delete process.env.WHATSAPP_UNIT_KEY;
    expect(() => encryptAudio(profile, "m", Buffer.from("x"))).toThrow();
  });
  test("downloads only trusted Meta hosts with matching size and checksum, accepting public IPv6", async () => {
    const bytes = Buffer.from("OggS content"),
      metadata = {
        id: "m1",
        file_size: bytes.length,
        mime_type: "audio/ogg",
        sha256: createHash("sha256").update(bytes).digest("hex"),
        url: "https://lookaside.fbsbx.com/media",
      };
    const fetchImpl = jest
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(metadata)))
      .mockResolvedValueOnce(new Response(bytes));
    expect(
      (
        await downloadAudio(
          profile,
          { id: "m1" },
          {
            fetchImpl,
            resolve: async () => [{ family: 6, address: "2a03:2880::1" }],
          },
        )
      ).bytes,
    ).toEqual(bytes);
    expect(fetchImpl.mock.calls.every((c) => c[1].redirect === "error")).toBe(
      true,
    );
  });
  test("rejects private hosts, private IPs, oversize and mismatched media before processing", async () => {
    for (const extra of [
      { url: "https://localhost/private" },
      { url: "https://lookaside.fbsbx.com/media" },
      { file_size: 6000000 },
    ]) {
      const fetchImpl = jest
        .fn()
        .mockResolvedValue(
          new Response(
            JSON.stringify({
              id: "m1",
              file_size: 5,
              mime_type: "audio/ogg",
              sha256: "bad",
              url: "https://evil.test/",
              ...extra,
            }),
          ),
        );
      await expect(
        downloadAudio(
          profile,
          { id: "m1" },
          {
            fetchImpl,
            resolve: async () => [{ family: 4, address: "127.0.0.1" }],
          },
        ),
      ).rejects.toThrow();
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    }
  });
  test("uploads one media object then sends audio by ID with independent correlation", async () => {
    const upload = jest
      .fn()
      .mockResolvedValue(new Response('{"id":"uploaded"}'));
    expect(
      await uploadAudio(profile, Buffer.from("OggS content"), {
        fetchImpl: upload,
      }),
    ).toBe("uploaded");
    expect(upload.mock.calls[0][1].body.get("file").type).toBe("audio/ogg");
    const send = jest
      .fn()
      .mockResolvedValue(new Response('{"messages":[{"id":"wamid.voice"}]}'));
    expect(
      (
        await sendAudio(
          profile,
          {
            recipient: "61412345678",
            body: "answer",
            messageId: "11111111-1111-4111-8111-111111111111",
            mediaId: "uploaded",
          },
          { fetchImpl: send },
        )
      ).kind,
    ).toBe("accepted");
    expect(JSON.parse(send.mock.calls[0][1].body)).toMatchObject({
      type: "audio",
      audio: { id: "uploaded" },
    });
    expect(JSON.parse(send.mock.calls[0][1].body).text).toBeUndefined();
  });
});
