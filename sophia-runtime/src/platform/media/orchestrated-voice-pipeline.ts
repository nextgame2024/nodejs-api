import { randomUUID } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import type { CanonicalConversationMessage, ReasoningToolDefinition } from "../../providers/reasoning/reasoning-provider.interface.js";
import type {
  AudioOutputSink,
  SpeechAudioFormat,
  SynthesisProvider,
  TranscriptionProvider,
  TranscriptionSession,
} from "../../providers/speech/speech-provider.interface.js";
import { ProviderCapabilityRegistry } from "../../providers/capability/provider-capability.registry.js";
import { ReasoningPipelineService } from "../orchestration/reasoning-pipeline.service.js";
import type { ReasoningExecutionContext, ReasoningPipelineEvent } from "../orchestration/reasoning-pipeline.js";

export type OrchestratedVoiceSessionRequest = ReasoningExecutionContext & {
  instructions: string;
  tools: readonly ReasoningToolDefinition[];
  history?: readonly CanonicalConversationMessage[];
  transcriptionAdapterKey: string;
  reasoningAdapterKey: string;
  synthesisAdapterKey: string;
  inputFormat: SpeechAudioFormat;
  outputFormat: SpeechAudioFormat;
};

export type OrchestratedVoiceEvent =
  | { type: "transcript.partial"; turnId: string; turnEpoch: number; text: string; provider: string }
  | { type: "transcript.final"; turnId: string; turnEpoch: number; text: string; provider: string }
  | { type: "reasoning"; turnId: string; turnEpoch: number; event: ReasoningPipelineEvent }
  | { type: "assistant.audio.started" | "assistant.audio.stopped"; turnId: string; turnEpoch: number }
  | { type: "assistant.audio.chunk"; turnId: string; turnEpoch: number; sequence: number; byteLength: number }
  | { type: "turn.interrupted"; turnId: string; turnEpoch: number };

@Injectable()
export class OrchestratedVoicePipelineFactory {
  constructor(
    @Inject(ProviderCapabilityRegistry) private readonly providers: ProviderCapabilityRegistry,
    @Inject(ReasoningPipelineService) private readonly reasoning: ReasoningPipelineService,
  ) {}

  create(request: OrchestratedVoiceSessionRequest, sinks: readonly AudioOutputSink[]): OrchestratedVoicePipeline {
    if (sinks.length !== 1) throw new Error("Orchestrated voice requires exactly one playable-audio owner.");
    const transcription = this.providers.resolve<TranscriptionProvider>(request.transcriptionAdapterKey, "speech-input");
    const synthesis = this.providers.resolve<SynthesisProvider>(request.synthesisAdapterKey, "speech-output");
    this.providers.validateComposition({
      pipelineMode: "orchestrated-voice",
      bindings: [
        { bindingId: "transcription", adapterKey: request.transcriptionAdapterKey, capability: "speech-input" },
        { bindingId: "reasoning", adapterKey: request.reasoningAdapterKey, capability: "reasoning" },
        { bindingId: "synthesis", adapterKey: request.synthesisAdapterKey, capability: "speech-output" },
      ],
      capabilityOwners: { "speech-input": "transcription", reasoning: "reasoning", "speech-output": "synthesis" },
      audioOutputOwnerBindingId: "synthesis",
    });
    if (!transcription.implementation.supportedInputFormats.includes(request.inputFormat)
      || !transcription.manifest.inputAudioFormats.includes(request.inputFormat)) {
      throw new Error("The transcription adapter does not support the requested input codec.");
    }
    if (!synthesis.implementation.supportedOutputFormats.includes(request.outputFormat)
      || !synthesis.manifest.outputAudioFormats.includes(request.outputFormat)
      || !sinks[0].acceptedFormats.includes(request.outputFormat)) {
      throw new Error("The synthesis path does not support the requested output codec.");
    }
    return new OrchestratedVoicePipeline(request, transcription.implementation, synthesis.implementation, this.reasoning, sinks[0]);
  }
}

export class OrchestratedVoicePipeline {
  private history: CanonicalConversationMessage[];
  private epoch = 0;
  private active?: { turnId: string; turnEpoch: number; abort: AbortController; transcription: TranscriptionSession };
  private closed = false;

  constructor(
    private readonly request: OrchestratedVoiceSessionRequest,
    private readonly transcriptionProvider: TranscriptionProvider,
    private readonly synthesisProvider: SynthesisProvider,
    private readonly reasoning: Pick<ReasoningPipelineService, "stream">,
    private readonly sink: AudioOutputSink,
  ) { this.history = [...(request.history ?? [])]; }

  async beginTurn(): Promise<{ turnId: string; turnEpoch: number }> {
    if (this.closed) throw new Error("The voice session is closed.");
    if (this.active) throw new Error("A voice turn is already active.");
    const turnId = randomUUID();
    const turnEpoch = ++this.epoch;
    const transcription = await this.transcriptionProvider.openStream({ turnId, turnEpoch, inputFormat: this.request.inputFormat });
    this.active = { turnId, turnEpoch, abort: new AbortController(), transcription };
    return { turnId, turnEpoch };
  }

  async pushAudio(chunk: Uint8Array): Promise<void> {
    if (!this.active) throw new Error("No voice turn is active.");
    await this.active.transcription.pushAudio(chunk);
  }

  async *finishTurn(): AsyncGenerator<OrchestratedVoiceEvent> {
    const turn = this.active;
    if (!turn) throw new Error("No voice turn is active.");
    let transcript = "";
    let responseText = "";
    try {
      for await (const event of turn.transcription.finishTurn(turn.abort.signal)) {
        if (!this.isCurrent(turn)) return;
        if (event.type === "transcript.final") transcript = event.text;
        yield event;
      }
      if (!transcript) throw new Error("The transcription provider did not return a final transcript.");
      for await (const event of this.reasoning.stream(this.request.reasoningAdapterKey, {
        customerId: this.request.customerId, sessionId: this.request.sessionId, storeId: this.request.storeId,
        sessionAccessToken: this.request.sessionAccessToken, correlationId: this.request.correlationId,
        instructions: this.request.instructions, tools: this.request.tools, history: this.history,
        userText: transcript, signal: turn.abort.signal,
      })) {
        if (!this.isCurrent(turn)) return;
        yield { type: "reasoning", turnId: turn.turnId, turnEpoch: turn.turnEpoch, event };
        if (event.type === "turn.completed") responseText = event.text;
        if (event.type === "turn.failed" || event.type === "turn.cancelled") return;
      }
      if (!responseText) throw new Error("The reasoning provider returned no speakable response.");
      yield { type: "assistant.audio.started", turnId: turn.turnId, turnEpoch: turn.turnEpoch };
      let sequence = 0;
      for (const segment of speechSegments(responseText)) {
        for await (const chunk of this.synthesisProvider.streamSpeech({ turnId: turn.turnId, turnEpoch: turn.turnEpoch,
          text: segment, outputFormat: this.request.outputFormat }, turn.abort.signal)) {
          if (!this.isCurrent(turn)) return;
          await this.sink.write(chunk);
          if (!this.isCurrent(turn)) return;
          yield { type: "assistant.audio.chunk", turnId: turn.turnId, turnEpoch: turn.turnEpoch,
            sequence: sequence++, byteLength: chunk.audio.byteLength };
        }
      }
      if (!this.isCurrent(turn)) return;
      this.history.push({ role: "user", content: transcript }, { role: "assistant", content: responseText });
      yield { type: "assistant.audio.stopped", turnId: turn.turnId, turnEpoch: turn.turnEpoch };
    } finally {
      await turn.transcription.close().catch(() => undefined);
      if (this.active?.turnEpoch === turn.turnEpoch) this.active = undefined;
    }
  }

  async interrupt(): Promise<OrchestratedVoiceEvent | undefined> {
    const turn = this.active;
    if (!turn) return undefined;
    this.epoch += 1;
    this.active = undefined;
    turn.abort.abort();
    await Promise.allSettled([
      turn.transcription.cancel(), this.synthesisProvider.cancel(turn.turnId), this.sink.interrupt(turn.turnId),
    ]);
    return { type: "turn.interrupted", turnId: turn.turnId, turnEpoch: turn.turnEpoch };
  }

  async close(): Promise<void> {
    await this.interrupt();
    this.closed = true;
    await this.sink.close();
  }

  private isCurrent(turn: { turnEpoch: number }): boolean {
    return !turn || (!this.closed && this.active?.turnEpoch === turn.turnEpoch && this.epoch === turn.turnEpoch);
  }
}

function speechSegments(text: string): string[] {
  if (text.length <= 4_096) return [text];
  if (text.length > 40_000) throw new Error("The speakable response exceeded its bounded text size.");
  const result: string[] = [];
  let remaining = text;
  while (remaining.length) {
    let boundary = Math.min(4_096, remaining.length);
    if (boundary < remaining.length) {
      const whitespace = remaining.lastIndexOf(" ", boundary);
      if (whitespace > 3_000) boundary = whitespace;
    }
    result.push(remaining.slice(0, boundary).trim());
    remaining = remaining.slice(boundary).trimStart();
  }
  return result;
}
