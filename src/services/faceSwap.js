import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";

/** Run a command and stream output */
function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: "inherit", shell: false, ...opts });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) return resolve();
      reject(
        new Error(`Command failed: ${cmd} ${args.join(" ")} (code ${code})`)
      );
    });
  });
}

const TMP_DIR = process.env.TMPDIR || "/tmp";

/** Low-RAM defaults; override via Render env if needed */
const FACEFUSION_CWD = process.env.FACEFUSION_CWD || "/opt/facefusion";
const FACE_SWAP_CMD = (
  process.env.FACE_SWAP_CMD || "python3 /opt/facefusion/facefusion.py"
).trim();
const FACEFUSION_SUBCOMMAND = (
  process.env.FACEFUSION_SUBCOMMAND || "headless-run"
).trim(); // or "run"
const EXECUTION_PROVIDERS = (process.env.FACEFUSION_PROVIDERS || "cpu")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const THREADS = process.env.FACEFUSION_THREADS || "1";

/** Valid selector options in current CLI */
const FACE_SELECTOR_MODE = (process.env.FACE_SELECTOR_MODE || "one").trim(); // many|one|reference
const FACE_SELECTOR_ORDER = (
  process.env.FACE_SELECTOR_ORDER || "best-worst"
).trim();

const FACE_SWAPPER_MODEL = process.env.FACE_SWAPPER_MODEL || "inswapper_128";

/** Optional enhancer (turn on only if you have RAM for it) */
const ENABLE_ENHANCER = (process.env.FACEFUSION_ENABLE_ENHANCER || "0") === "1";
const FACE_ENHANCER_MODEL = process.env.FACE_ENHANCER_MODEL || "codeformer";

/** Pre-scaling and chunking to cut RAM/CPU */
const PRESCALE_MAX_WIDTH = parseInt(
  process.env.PRESCALE_MAX_WIDTH || "720",
  10
);
const PRESCALE_FPS = parseInt(process.env.PRESCALE_FPS || "16", 10);
const CHUNK_SECONDS = Math.max(
  1,
  parseInt(process.env.CHUNK_SECONDS || "3", 10)
); // 1..N

/** Optional system memory limit (FaceFusion accepts 0,4,8,...,128 only) */
const SYSTEM_MEMORY_LIMIT = (() => {
  const raw = parseInt(process.env.SYSTEM_MEMORY_LIMIT || "0", 10);
  const allowed = new Set([
    0, 4, 8, 12, 16, 20, 24, 28, 32, 36, 40, 44, 48, 52, 56, 60, 64, 68, 72, 76,
    80, 84, 88, 92, 96, 100, 104, 108, 112, 116, 120, 124, 128,
  ]);
  return allowed.has(raw) ? raw : 0; // 0 => omit
})();

/** Lexicographic sort helper for numbered filenames */
function sortByIndex(a, b) {
  const na = Number(a.match(/(\d+)(?=\D*$)/)?.[1] ?? -1);
  const nb = Number(b.match(/(\d+)(?=\D*$)/)?.[1] ?? -1);
  return na - nb;
}

/**
 * swapFaceOnVideo
 * @param {Object} p
 * @param {Buffer} p.faceBytes
 * @param {string} [p.baseVideoUrl]
 * @param {Buffer} [p.baseVideoBytes]
 * @param {string[]} [p.extraArgs]
 * @returns {Promise<{ bytes: Buffer, mime: string }>}
 */
export async function swapFaceOnVideo({
  faceBytes,
  baseVideoUrl,
  baseVideoBytes,
  extraArgs = [],
}) {
  if (!faceBytes || !Buffer.isBuffer(faceBytes)) {
    throw new Error("swapFaceOnVideo: faceBytes (Buffer) is required");
  }
  if (!baseVideoUrl && !baseVideoBytes) {
    throw new Error(
      "swapFaceOnVideo: baseVideoUrl or baseVideoBytes is required"
    );
  }

  await fs.mkdir(TMP_DIR, { recursive: true });
  const ts = Date.now();
  const facePath = path.join(TMP_DIR, `face_${ts}.jpg`);
  const inVideoPath = path.join(TMP_DIR, `in_${ts}.mp4`);
  const prescaledPath = path.join(TMP_DIR, `pre_${ts}.mp4`);
  const concatListPath = path.join(TMP_DIR, `concat_${ts}.txt`);
  const concatVideoPath = path.join(TMP_DIR, `concat_${ts}.mp4`);
  const audioPath = path.join(TMP_DIR, `audio_${ts}.m4a`);
  const outVideoPath = path.join(TMP_DIR, `out_${ts}.mp4`);
  const chunksDir = path.join(TMP_DIR, `chunks_${ts}`);
  const outChunksDir = path.join(TMP_DIR, `outchunks_${ts}`);

  // Write inputs
  await fs.writeFile(facePath, faceBytes);
  if (baseVideoBytes && Buffer.isBuffer(baseVideoBytes)) {
    await fs.writeFile(inVideoPath, baseVideoBytes);
  } else {
    const resp = await fetch(baseVideoUrl);
    if (!resp.ok)
      throw new Error(`Failed to fetch base video (${resp.status})`);
    const ab = await resp.arrayBuffer();
    await fs.writeFile(inVideoPath, Buffer.from(ab));
  }

  // Extract original audio (so we can keep audio while chunking video-only)
  await run("ffmpeg", [
    "-y",
    "-i",
    inVideoPath,
    "-vn",
    "-acodec",
    "aac",
    "-b:a",
    "128k",
    audioPath,
  ]);

  // ---- Pre-scale to reduce RAM (video only) ----
  await run("ffmpeg", [
    "-y",
    "-i",
    inVideoPath,
    "-vf",
    `scale='min(${PRESCALE_MAX_WIDTH},iw)':'-2',fps=${PRESCALE_FPS}`,
    "-c:v",
    "libx264",
    "-preset",
    "ultrafast",
    "-crf",
    "30",
    "-an",
    prescaledPath,
  ]);

  // ---- Split into small chunks to bound peak memory ----
  await fs.mkdir(chunksDir, { recursive: true });
  await run("ffmpeg", [
    "-y",
    "-i",
    prescaledPath,
    "-c",
    "copy",
    "-map",
    "0:v:0",
    "-f",
    "segment",
    "-segment_time",
    String(CHUNK_SECONDS),
    "-reset_timestamps",
    "1",
    path.join(chunksDir, "chunk_%03d.mp4"),
  ]);

  // Process each chunk with FaceFusion
  await fs.mkdir(outChunksDir, { recursive: true });
  const chunkFiles = (await fs.readdir(chunksDir))
    .filter((f) => f.startsWith("chunk_") && f.endsWith(".mp4"))
    .sort(sortByIndex);

  if (chunkFiles.length === 0) {
    throw new Error("No chunks produced from input video");
  }

  // Common FaceFusion args builder
  const processors = ["face_swapper"];
  if (ENABLE_ENHANCER) processors.push("face_enhancer");
  const parts = FACE_SWAP_CMD.split(/\s+/).filter(Boolean);
  const cmd = parts.shift();
  if (!cmd) throw new Error("FACE_SWAP_CMD is empty");

  for (const f of chunkFiles) {
    const inChunk = path.join(chunksDir, f);
    const idx = f.match(/(\d+)(?=\D*$)/)?.[1] ?? "000";
    const outChunk = path.join(outChunksDir, `out_${idx}.mp4`);

    const args = [
      ...parts,
      FACEFUSION_SUBCOMMAND,

      "--execution-providers",
      ...EXECUTION_PROVIDERS,
      "--execution-thread-count",
      THREADS,

      "--face-selector-mode",
      FACE_SELECTOR_MODE,
      "--face-selector-order",
      FACE_SELECTOR_ORDER,

      // Light models keep memory in check
      "--face-detector-model",
      "yunet",
      "--face-landmarker-model",
      "2dfan4",

      "--video-memory-strategy",
      "strict",
      ...(SYSTEM_MEMORY_LIMIT
        ? ["--system-memory-limit", String(SYSTEM_MEMORY_LIMIT)]
        : []),

      "--processors",
      ...processors,
      "--face-swapper-model",
      FACE_SWAPPER_MODEL,
      ...(ENABLE_ENHANCER
        ? ["--face-enhancer-model", FACE_ENHANCER_MODEL]
        : []),

      "--output-video-encoder",
      "libx264",
      "--output-video-preset",
      "ultrafast",

      "-s",
      facePath,
      "-t",
      inChunk,
      "-o",
      outChunk,

      ...extraArgs,
    ];

    await run(cmd, args, {
      cwd: FACEFUSION_CWD,
      env: {
        ...process.env,
        FACEFUSION_CACHE_DIR: process.env.FACEFUSION_CACHE_DIR || "/cache",
        XDG_CACHE_HOME: process.env.XDG_CACHE_HOME || "/cache/xdg",
        HF_HOME: process.env.HF_HOME || "/cache/hf",
        INSIGHTFACE_HOME: process.env.INSIGHTFACE_HOME || "/cache/insightface",
      },
    });
  }

  // ---- Concatenate processed chunks (video only) ----
  const outChunkFiles = (await fs.readdir(outChunksDir))
    .filter((f) => f.startsWith("out_") && f.endsWith(".mp4"))
    .sort(sortByIndex);

  if (outChunkFiles.length !== chunkFiles.length) {
    throw new Error(
      `Chunk mismatch: in=${chunkFiles.length} out=${outChunkFiles.length}`
    );
  }

  const concatLines = outChunkFiles
    .map((f) => `file '${path.join(outChunksDir, f).replace(/'/g, "'\\''")}'`)
    .join("\n");
  await fs.writeFile(concatListPath, concatLines, "utf8");

  await run("ffmpeg", [
    "-y",
    "-f",
    "concat",
    "-safe",
    "0",
    "-i",
    concatListPath,
    "-c",
    "copy",
    concatVideoPath,
  ]);

  // ---- Mux back the original audio (trim to shortest) ----
  await run("ffmpeg", [
    "-y",
    "-i",
    concatVideoPath,
    "-i",
    audioPath,
    "-c:v",
    "copy",
    "-c:a",
    "aac",
    "-shortest",
    outVideoPath,
  ]);

  const ok = await fs
    .stat(outVideoPath)
    .then((s) => s.isFile() && s.size > 0)
    .catch(() => false);
  if (!ok) throw new Error("FaceFusion didn’t produce an output video");

  const out = await fs.readFile(outVideoPath);

  // Cleanup (best effort)
  try {
    await fs.unlink(facePath);
    await fs.unlink(inVideoPath);
    await fs.unlink(prescaledPath);
    await fs.unlink(concatListPath);
    await fs.unlink(concatVideoPath);
    await fs.unlink(audioPath);
    for (const d of [chunksDir, outChunksDir]) {
      for (const f of await fs.readdir(d)) {
        try {
          await fs.unlink(path.join(d, f));
        } catch {}
      }
      try {
        await fs.rmdir(d);
      } catch {}
    }
    await fs.unlink(outVideoPath); // remove after reading
  } catch {}

  return { bytes: out, mime: "video/mp4" };
}

export default swapFaceOnVideo;
