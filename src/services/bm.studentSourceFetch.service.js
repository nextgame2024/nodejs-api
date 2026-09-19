import crypto from "node:crypto";
import { isOfficialStudentUrl } from "./bm.studentSources.js";

export function extractStudentPageText(html) {
  const main = html.match(/<main\b[^>]*>([\s\S]*?)<\/main>/i)?.[1] || html;
  return main.replace(/<(script|style|noscript|nav|footer|header)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ").replace(/<[^>]+>/g, " ")
    .replace(/&#(x[0-9a-f]+|\d+);/gi, (_, code) => {
      const value = code[0].toLowerCase() === "x" ? parseInt(code.slice(1), 16) : Number(code);
      return value > 0 && value <= 0x10ffff ? String.fromCodePoint(value) : " ";
    })
    .replace(/&(nbsp|amp|lt|gt|quot|apos);/gi, (_, entity) => ({nbsp: " ", amp: "&", lt: "<", gt: ">", quot: '"', apos: "'"})[entity.toLowerCase()])
    .replace(/[\u200b-\u200f\ufeff]/g, "").replace(/\s+/g, " ").trim();
}

export async function fetchStudentSource(source, { fetchImpl = fetch, timeoutMs = 6500, maxBytes = 4_000_000 } = {}) {
  const signal = AbortSignal.timeout(timeoutMs);
  let url = source.url;
  for (let redirects = 0; redirects <= 3; redirects++) {
    if (!isOfficialStudentUrl(url)) throw new Error("Source URL is not approved");
    const response = await fetchImpl(url, { redirect: "manual", signal, headers: { accept: "text/html" } });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      await response.body?.cancel();
      const location = response.headers.get("location");
      if (!location) throw new Error("Source redirect has no location");
      url = new URL(location, url).href;
      continue;
    }
    if (!response.ok || !response.headers.get("content-type")?.includes("text/html")) {
      await response.body?.cancel();
      throw new Error("Official source did not return an HTML page");
    }
    if (Number(response.headers.get("content-length")) > maxBytes) {
      await response.body?.cancel();
      throw new Error("Official source exceeds size limit");
    }
    const reader = response.body?.getReader();
    if (!reader) throw new Error("Official source is empty");
    const chunks = [];
    let bytes = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > maxBytes) throw new Error("Official source exceeds size limit");
        chunks.push(Buffer.from(value));
      }
    } finally { await reader.cancel(); }
    const text = extractStudentPageText(Buffer.concat(chunks).toString("utf8"));
    if (text.length < (source.minTextLength || 400) || !text.toLowerCase().includes(source.marker.toLowerCase()) ||
        /access denied|verify you are human|request blocked|just a moment/i.test(text)) {
      throw new Error("Official source content is unavailable or incomplete");
    }
    return { url, title: source.title, text: text.slice(0, 60_000), truncated: text.length > 60_000,
      contentHash: crypto.createHash("sha256").update(text).digest("hex"), fetchedAt: new Date().toISOString() };
  }
  throw new Error("Too many official source redirects");
}
