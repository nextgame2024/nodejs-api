export function parseBoundedText(input: {
  bytes: Uint8Array;
  mediaType: "text/plain" | "text/markdown";
  maxOutputBytes: number;
}): { text: string; parserVersion: string } {
  if (input.mediaType !== "text/plain" && input.mediaType !== "text/markdown") throw new Error("unsupported_media_type");
  if (input.bytes.byteLength < 1 || input.bytes.byteLength > input.maxOutputBytes) throw new Error("parser_input_size_invalid");
  const text = new TextDecoder("utf-8", { fatal: true })
    .decode(input.bytes)
    .replace(/^\uFEFF/, "")
    .replace(/\r\n?/g, "\n")
    .trim();
  if (!text || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text)) throw new Error("parser_content_invalid");
  if (Buffer.byteLength(text, "utf8") > input.maxOutputBytes) throw new Error("parser_output_too_large");
  return { text, parserVersion: "bounded-utf8-v1" };
}
