import { Injectable } from "@nestjs/common";
import { runtimeConfig } from "../../config/runtime-config.js";
import { SOPHIA_PCM_FORMAT, type SpeechChunk, type SynthesisProvider } from "./speech-provider.interface.js";

@Injectable()
export class OpenAISpeechSynthesisProvider implements SynthesisProvider {
  readonly providerName = "openai-synthesis";
  readonly supportedOutputFormats = [SOPHIA_PCM_FORMAT] as const;
  private readonly active = new Map<string, AbortController>();

  async *streamSpeech(request: {
    turnId: string;
    turnEpoch: number;
    text: string;
    outputFormat: typeof SOPHIA_PCM_FORMAT;
  }, signal: AbortSignal): AsyncGenerator<SpeechChunk> {
    if (!this.supportedOutputFormats.includes(request.outputFormat)) throw new Error("Unsupported synthesis audio format.");
    const text = request.text.trim();
    if (!text || text.length > 4_096) throw new Error("Speech text must contain between 1 and 4096 characters.");
    const config = runtimeConfig().openAi;
    if (!config.apiKey) throw new Error("OpenAI speech synthesis is unavailable because OPENAI_API_KEY is not configured.");
    const cancellation = new AbortController();
    this.active.set(request.turnId, cancellation);
    try {
      const response = await fetch(`${config.audioApiBaseUrl.replace(/\/$/, "")}/audio/speech`, {
        method: "POST",
        headers: { authorization: `Bearer ${config.apiKey}`, "content-type": "application/json" },
        body: JSON.stringify({ model: config.synthesisModel, voice: config.synthesisVoice, input: text,
          response_format: "pcm", stream_format: "audio" }),
        signal: AbortSignal.any([signal, cancellation.signal, AbortSignal.timeout(config.speechTimeoutMs)]),
      });
      if (!response.ok || !response.body) throw new Error(`OpenAI speech request failed with status ${response.status}.`);
      let sequence = 0;
      let emitted = 0;
      let carry: number | undefined;
      for await (const source of response.body) {
        let chunk = source;
        if (carry !== undefined) { const joined = new Uint8Array(source.byteLength + 1); joined[0] = carry; joined.set(source, 1); chunk = joined; carry = undefined; }
        if (chunk.byteLength % 2) { carry = chunk[chunk.byteLength - 1]; chunk = chunk.subarray(0, -1); }
        if (!chunk.byteLength) continue;
        emitted += chunk.byteLength;
        if (emitted > config.synthesisMaximumOutputBytes) throw new Error("Speech synthesis exceeded its bounded audio size.");
        yield { turnId: request.turnId, turnEpoch: request.turnEpoch, sequence: sequence++, format: request.outputFormat,
          audio: chunk.slice(), provider: this.providerName };
      }
      if (carry !== undefined) throw new Error("Speech synthesis returned an incomplete PCM16 sample.");
    } finally {
      if (this.active.get(request.turnId) === cancellation) this.active.delete(request.turnId);
    }
  }

  async cancel(turnId: string): Promise<void> {
    this.active.get(turnId)?.abort();
    this.active.delete(turnId);
  }

  async close(): Promise<void> {
    for (const controller of this.active.values()) controller.abort();
    this.active.clear();
  }
}
