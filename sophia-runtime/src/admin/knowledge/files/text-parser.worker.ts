import { parentPort } from "node:worker_threads";
import { parseBoundedText } from "./bounded-text-parser.js";

type Request = { bytes: Uint8Array; mediaType: "text/plain" | "text/markdown"; maxOutputBytes: number };

parentPort?.on("message", (input: Request) => {
  try {
    parentPort?.postMessage({ ok: true, ...parseBoundedText(input) });
  } catch (error) {
    parentPort?.postMessage({ ok: false, error: error instanceof Error ? error.message : "parser_failed" });
  }
});
