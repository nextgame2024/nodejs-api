import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import { MAX_MEDIA_BYTES } from "../../services/messaging/audio/codec.js";
async function read(response, max) {
  if (!response.ok || !response.body) throw new Error("Media request failed.");
  const declared = Number(response.headers.get("content-length"));
  if (declared > max) {
    await response.body.cancel();
    throw new Error("Media too large.");
  }
  const reader = response.body.getReader(),
    chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > max) throw new Error("Media too large.");
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks);
  } catch (e) {
    await reader.cancel();
    throw e;
  }
}
export async function readJson(response) {
  return JSON.parse((await read(response, 32768)).toString("utf8"));
}
async function trustedUrl(raw, { resolve = lookup } = {}) {
  const u = new URL(raw);
  if (
    u.protocol !== "https:" ||
    (u.port && u.port !== "443") ||
    u.username ||
    u.password ||
    !["lookaside.fbsbx.com", "lookaside.facebook.com"].includes(u.hostname)
  )
    throw new Error("Untrusted media address.");
  const addresses = await resolve(u.hostname, { all: true });
  if (
    !addresses.length ||
    addresses.some((a) => {
      if (a.family === 6) return !/^[23][0-9a-f]{3}:/i.test(a.address);
      if (a.family !== 4) return true;
      const [x, y] = a.address.split(".").map(Number);
      return (
        x === 0 ||
        x === 10 ||
        x === 127 ||
        x >= 224 ||
        (x === 169 && y === 254) ||
        (x === 192 && y === 168) ||
        (x === 172 && y >= 16 && y <= 31) ||
        (x === 100 && y >= 64 && y <= 127) ||
        (x === 198 && (y === 18 || y === 19))
      );
    })
  )
    throw new Error("Untrusted media address.");
  return u.href;
}
export async function downloadAudio(
  profile,
  media,
  { fetchImpl = fetch, resolve } = {},
) {
  if (
    !profile.accessToken ||
    !profile.graphVersion ||
    !/^[A-Za-z0-9_-]{1,200}$/.test(media.id)
  )
    throw new Error("Media unavailable.");
  const signal = AbortSignal.timeout(20000),
    headers = { authorization: `Bearer ${profile.accessToken}` };
  const metadata = await readJson(
    await fetchImpl(
      `https://graph.facebook.com/${profile.graphVersion}/${media.id}?phone_number_id=${profile.phoneNumberId}`,
      { headers, signal, redirect: "error" },
    ),
  );
  if (
    String(metadata.id) !== media.id ||
    !Number.isInteger(metadata.file_size) ||
    metadata.file_size <= 0 ||
    metadata.file_size > MAX_MEDIA_BYTES ||
    ![
      "audio/ogg",
      "audio/mpeg",
      "audio/mp4",
      "audio/aac",
      "audio/amr",
    ].includes(metadata.mime_type?.split(";")[0]) ||
    typeof metadata.sha256 !== "string"
  )
    throw new Error("Unsupported audio metadata.");
  const url = await trustedUrl(metadata.url, { resolve });
  const response = await fetchImpl(url, { headers, signal, redirect: "error" });
  const bytes = await read(response, MAX_MEDIA_BYTES);
  if (
    bytes.length !== metadata.file_size ||
    createHash("sha256").update(bytes).digest("hex") !==
      metadata.sha256.toLowerCase()
  ) {
    bytes.fill(0);
    throw new Error("Media checksum mismatch.");
  }
  return { bytes, mimeType: metadata.mime_type };
}
export async function uploadAudio(profile, bytes, { fetchImpl = fetch } = {}) {
  if (
    bytes.length > MAX_MEDIA_BYTES ||
    bytes.subarray(0, 4).toString() !== "OggS"
  )
    throw new Error("Invalid voice file.");
  const form = new FormData();
  form.append("messaging_product", "whatsapp");
  form.append("type", "audio/ogg");
  form.append("file", new Blob([bytes], { type: "audio/ogg" }), "reply.ogg");
  const response = await fetchImpl(
    `https://graph.facebook.com/${profile.graphVersion}/${profile.phoneNumberId}/media`,
    {
      method: "POST",
      headers: { authorization: `Bearer ${profile.accessToken}` },
      body: form,
      signal: AbortSignal.timeout(20000),
      redirect: "error",
    },
  );
  const result = await readJson(response);
  if (
    typeof result.id !== "string" ||
    !/^[A-Za-z0-9_-]{1,200}$/.test(result.id)
  )
    throw new Error("Upload could not be confirmed.");
  return result.id;
}
