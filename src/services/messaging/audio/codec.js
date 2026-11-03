import { spawn } from "node:child_process";
import ffmpeg from "ffmpeg-static";
export const MAX_MEDIA_BYTES = 5 * 1024 * 1024;
export const MAX_INPUT_PCM = 60 * 24000 * 2;
export const MAX_OUTPUT_PCM = 250 * 24000 * 2;
// No shell or file paths. Restrict demuxing, protocols, allocations, threads,
// duration and output bytes; terminate malformed/oversized/slow inputs.
function convert(
  input,
  args,
  maxBytes,
  { binary = ffmpeg, timeoutMs = 20000 } = {},
) {
  if (!binary || !Buffer.isBuffer(input) || !input.length)
    throw new Error("Invalid audio input.");
  return new Promise((resolve, reject) => {
    const child = spawn(
      binary,
      [
        "-nostdin",
        "-v",
        "error",
        "-max_alloc",
        "16777216",
        "-threads",
        "1",
        "-filter_threads",
        "1",
        ...args,
      ],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    let size = 0,
      ended = false;
    const chunks = [];
    const finish = (error) => {
      if (ended) return;
      ended = true;
      clearTimeout(timer);
      if (error) {
        child.kill("SIGKILL");
        for (const b of chunks) b.fill(0);
        reject(new Error("Audio format, size or duration is unsupported."));
      } else {
        const output = Buffer.concat(chunks);
        for (const b of chunks) b.fill(0);
        resolve(output);
      }
    };
    const timer = setTimeout(() => finish(true), timeoutMs);
    timer.unref();
    child.on("error", () => finish(true));
    child.stdin.on("error", () => {});
    child.stderr.on("data", () => {});
    child.stdout.on("data", (chunk) => {
      size += chunk.length;
      if (size > maxBytes) finish(true);
      else chunks.push(chunk);
    });
    child.on("close", (code) => finish(code !== 0 || !size));
    child.stdin.end(input);
  });
}
function format(bytes, mime) {
  const type = mime?.split(";")[0].trim().toLowerCase();
  if (
    type === "audio/ogg" &&
    bytes.subarray(0, 4).toString() === "OggS" &&
    bytes.subarray(0, 4096).includes(Buffer.from("OpusHead"))
  )
    return "ogg";
  if (
    type === "audio/mpeg" &&
    (bytes.subarray(0, 3).toString() === "ID3" ||
      (bytes[0] === 255 && (bytes[1] & 224) === 224))
  )
    return "mp3";
  if (type === "audio/mp4" && bytes.subarray(4, 8).toString() === "ftyp")
    return "mov";
  if (type === "audio/amr" && bytes.subarray(0, 5).toString() === "#!AMR")
    return "amr";
  if (type === "audio/aac" && bytes[0] === 255 && (bytes[1] & 246) === 240)
    return "aac";
  throw new Error("Unsupported audio container.");
}
export async function decodeAudio(bytes, mime, options) {
  if (bytes.length > MAX_MEDIA_BYTES) throw new Error("Audio too large.");
  const f = format(bytes, mime);
  const pcm = await convert(
    bytes,
    [
      "-protocol_whitelist",
      "pipe",
      "-probesize",
      "1048576",
      "-analyzeduration",
      "3000000",
      "-f",
      f,
      "-i",
      "pipe:0",
      "-map",
      "0:a:0",
      "-vn",
      "-sn",
      "-dn",
      "-ac",
      "1",
      "-ar",
      "24000",
      "-t",
      "61",
      "-f",
      "s16le",
      "pipe:1",
    ],
    MAX_INPUT_PCM,
    options,
  );
  let energy = 0;
  for (let i = 0; i + 1 < pcm.length; i += 2) {
    const n = pcm.readInt16LE(i);
    energy += n * n;
  }
  if (pcm.length < 2400 || Math.sqrt(energy / (pcm.length / 2)) < 8) {
    pcm.fill(0);
    throw new Error("No audible speech.");
  }
  return pcm;
}
export async function encodeVoice(pcm, options) {
  if (!pcm.length || pcm.length % 2 || pcm.length > MAX_OUTPUT_PCM)
    throw new Error("Invalid speech output.");
  return convert(
    pcm,
    [
      "-protocol_whitelist",
      "pipe",
      "-f",
      "s16le",
      "-ar",
      "24000",
      "-ac",
      "1",
      "-i",
      "pipe:0",
      "-vn",
      "-c:a",
      "libopus",
      "-b:a",
      "32000",
      "-application",
      "voip",
      "-f",
      "ogg",
      "pipe:1",
    ],
    MAX_MEDIA_BYTES,
    options,
  );
}
