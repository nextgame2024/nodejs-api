import { Injectable } from "@nestjs/common";
import { runtimeConfig } from "../../config/runtime-config.js";
import {
  SOPHIA_PCM_FORMAT,
  type TranscriptEvent,
  type TranscriptionProvider,
  type TranscriptionSession,
} from "./speech-provider.interface.js";

@Injectable()
export class OpenAIBufferedTranscriptionProvider implements TranscriptionProvider {
  readonly providerName = "openai-transcription";
  readonly supportedInputFormats = [SOPHIA_PCM_FORMAT] as const;

  async openStream(request: {
    turnId: string;
    turnEpoch: number;
    inputFormat: typeof SOPHIA_PCM_FORMAT;
  }): Promise<TranscriptionSession> {
    if (!this.supportedInputFormats.includes(request.inputFormat)) throw new Error("Unsupported transcription audio format.");
    const config = runtimeConfig().openAi;
    if (!config.apiKey) throw new Error("OpenAI transcription is unavailable because OPENAI_API_KEY is not configured.");
    return new OpenAIBufferedTranscriptionSession({
      ...request,
      apiKey: config.apiKey,
      baseUrl: config.audioApiBaseUrl,
      model: config.transcriptionModel,
      timeoutMs: config.speechTimeoutMs,
      maximumInputBytes: config.transcriptionMaximumInputBytes,
    });
  }
}

class OpenAIBufferedTranscriptionSession implements TranscriptionSession {
  private chunks: Uint8Array[] = [];
  private byteLength = 0;
  private terminal = false;
  private readonly cancellation = new AbortController();

  constructor(private readonly options: {
    turnId: string;
    turnEpoch: number;
    apiKey: string;
    baseUrl: string;
    model: string;
    timeoutMs: number;
    maximumInputBytes: number;
  }) {}

  async pushAudio(chunk: Uint8Array): Promise<void> {
    if (this.terminal) throw new Error("The transcription turn is already closed.");
    if (!chunk.byteLength) return;
    if (this.byteLength + chunk.byteLength > this.options.maximumInputBytes) {
      throw new Error("The transcription turn exceeded its bounded audio size.");
    }
    this.chunks.push(chunk.slice());
    this.byteLength += chunk.byteLength;
  }

  async *finishTurn(signal: AbortSignal): AsyncGenerator<TranscriptEvent> {
    if (this.terminal) throw new Error("The transcription turn is already closed.");
    this.terminal = true;
    if (!this.byteLength || this.byteLength % 2 !== 0) throw new Error("Transcription audio must contain complete PCM16 samples.");
    const pcm = concatenate(this.chunks, this.byteLength);
    this.chunks = [];
    this.byteLength = 0;
    const form = new FormData();
    form.append("model", this.options.model);
    form.append("response_format", "json");
    const wav = wavFile(pcm);
    const blobBytes = new ArrayBuffer(wav.byteLength);
    new Uint8Array(blobBytes).set(wav);
    form.append("file", new Blob([blobBytes], { type: "audio/wav" }), `${this.options.turnId}.wav`);
    const response = await fetch(`${this.options.baseUrl.replace(/\/$/, "")}/audio/transcriptions`, {
      method: "POST",
      headers: { authorization: `Bearer ${this.options.apiKey}` },
      body: form,
      signal: AbortSignal.any([signal, this.cancellation.signal, AbortSignal.timeout(this.options.timeoutMs)]),
    });
    if (!response.ok) throw new Error(`OpenAI transcription request failed with status ${response.status}.`);
    const body = await response.json() as { text?: unknown };
    const text = typeof body.text === "string" ? body.text.trim() : "";
    if (!text) throw new Error("OpenAI transcription returned no final text.");
    yield { type: "transcript.final", turnId: this.options.turnId, turnEpoch: this.options.turnEpoch,
      text, provider: "openai-transcription" };
  }

  async cancel(): Promise<void> {
    this.terminal = true;
    this.chunks = [];
    this.byteLength = 0;
    this.cancellation.abort();
  }

  async close(): Promise<void> {
    await this.cancel();
  }
}

function concatenate(chunks: readonly Uint8Array[], total: number): Uint8Array {
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
  return result;
}

function wavFile(pcm: Uint8Array): Uint8Array {
  const header = new ArrayBuffer(44);
  const view = new DataView(header);
  writeAscii(view, 0, "RIFF"); view.setUint32(4, 36 + pcm.byteLength, true);
  writeAscii(view, 8, "WAVE"); writeAscii(view, 12, "fmt ");
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, 24_000, true); view.setUint32(28, 48_000, true);
  view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  writeAscii(view, 36, "data"); view.setUint32(40, pcm.byteLength, true);
  return concatenate([new Uint8Array(header), pcm], 44 + pcm.byteLength);
}

function writeAscii(view: DataView, offset: number, value: string): void {
  for (let index = 0; index < value.length; index += 1) view.setUint8(offset + index, value.charCodeAt(index));
}
