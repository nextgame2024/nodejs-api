import { Injectable } from "@nestjs/common";
import { Worker } from "node:worker_threads";
import type { KnowledgeTextParser } from "./knowledge-file.ports.js";

@Injectable()
export class IsolatedTextParserService implements KnowledgeTextParser {
  parse(input: { bytes: Uint8Array; mediaType: "text/plain" | "text/markdown"; maxOutputBytes: number }): Promise<{ text: string; parserVersion: string }> {
    return new Promise((resolve, reject) => {
      const worker = new Worker(new URL("./text-parser.worker.js", import.meta.url), {
        resourceLimits: { maxOldGenerationSizeMb: 32, stackSizeMb: 2 },
      });
      const timeout = setTimeout(() => void worker.terminate().finally(() => reject(new Error("parser_timeout"))), 2_000);
      worker.once("message", (message: { ok?: boolean; text?: string; parserVersion?: string; error?: string }) => {
        clearTimeout(timeout);
        void worker.terminate();
        if (message.ok && message.text && message.parserVersion) resolve({ text: message.text, parserVersion: message.parserVersion });
        else reject(new Error(message.error || "parser_failed"));
      });
      worker.once("error", (error) => { clearTimeout(timeout); reject(error); });
      worker.postMessage(input);
    });
  }
}
