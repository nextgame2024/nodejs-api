import { describe, expect, it, jest } from "@jest/globals";
import { ScriptedReasoningProvider, succeededToolResult } from "../../../test/fixtures/reasoning-contract.fixture.js";
import { ProviderCapabilityRegistry, type ProviderAdapterRegistration } from "../../providers/capability/provider-capability.registry.js";
import type { ReasoningProvider } from "../../providers/reasoning/reasoning-provider.interface.js";
import { SOPHIA_PCM_FORMAT, type AudioOutputSink, type SpeechChunk, type SynthesisProvider, type TranscriptionProvider, type TranscriptionSession } from "../../providers/speech/speech-provider.interface.js";
import { ReasoningPipelineService } from "../orchestration/reasoning-pipeline.service.js";
import { OrchestratedVoicePipelineFactory, type OrchestratedVoiceEvent } from "./orchestrated-voice-pipeline.js";

describe("OrchestratedVoicePipeline", () => {
  it.each(["anthropic-reasoning-v1", "gemini-reasoning-v1"])("keeps the same secured booking flow with %s", async (reasoningKey) => {
    const reasoning = new ScriptedReasoningProvider([
      [{ type: "tool.call", call: { callId: "search", name: "catalog.search", arguments: { query: "Bulimba" } } }, { type: "response.completed" }],
      [{ type: "tool.call", call: { callId: "prepare", name: "booking.prepare", arguments: { propertyId: "property-1" } } }, { type: "response.completed" }],
      [{ type: "text.delta", delta: "Please review the booking." }, { type: "response.completed" }],
    ]);
    const execute = jest.fn(async (call: { callId: string; name: string }) => succeededToolResult(call.callId, call.name, {}));
    const transcription = transcriptionProvider("Book an inspection in Bulimba");
    const synthesis = synthesisProvider();
    const sink = audioSink();
    const registry = new ProviderCapabilityRegistry([
      registration("transcription", "speech-input", transcription, [SOPHIA_PCM_FORMAT], []),
      registration(reasoningKey, "reasoning", reasoning, [], []),
      registration("synthesis", "speech-output", synthesis, [], [SOPHIA_PCM_FORMAT]),
    ]);
    const factory = new OrchestratedVoicePipelineFactory(registry,
      new ReasoningPipelineService(registry, { execute } as never));
    const pipeline = factory.create(request(reasoningKey), [sink]);
    await pipeline.beginTurn(); await pipeline.pushAudio(Uint8Array.of(1, 2));
    const events = await collect(pipeline.finishTurn());

    expect(execute.mock.calls.map(([call]) => call.name)).toEqual(["catalog.search", "booking.prepare"]);
    expect(events.some((event) => event.type === "assistant.audio.stopped")).toBe(true);
    expect(sink.write).toHaveBeenCalledTimes(1);
  });

  it("drops late synthesis output and flushes the sole audio owner after interruption", async () => {
    let release!: () => void;
    const gated = new Promise<void>((resolve) => { release = resolve; });
    const entered = deferred<void>();
    const synthesis: SynthesisProvider = {
      providerName: "late", supportedOutputFormats: [SOPHIA_PCM_FORMAT],
      async *streamSpeech(input) { entered.resolve(); await gated; yield { ...input, sequence: 0, audio: Uint8Array.of(1, 2), provider: "late" }; },
      cancel: async () => undefined, close: async () => undefined,
    };
    const reasoner = new ScriptedReasoningProvider([[{ type: "text.delta", delta: "Late audio" }, { type: "response.completed" }]]);
    const sink = audioSink();
    const registry = new ProviderCapabilityRegistry([
      registration("transcription", "speech-input", transcriptionProvider("Hello"), [SOPHIA_PCM_FORMAT], []),
      registration("reasoning", "reasoning", reasoner, [], []),
      registration("synthesis", "speech-output", synthesis, [], [SOPHIA_PCM_FORMAT]),
    ]);
    const pipeline = new OrchestratedVoicePipelineFactory(registry,
      new ReasoningPipelineService(registry, { execute: async () => { throw new Error("unused"); } } as never))
      .create(request("reasoning"), [sink]);
    await pipeline.beginTurn(); await pipeline.pushAudio(Uint8Array.of(1, 2));
    const collecting = collect(pipeline.finishTurn());
    await entered.promise;
    const interrupted = await pipeline.interrupt();
    release(); await collecting;

    expect(interrupted?.type).toBe("turn.interrupted");
    expect(sink.interrupt).toHaveBeenCalledTimes(1);
    expect(sink.write).not.toHaveBeenCalled();
  });

  it("rejects incompatible codecs and multiple audio owners before transcription opens", () => {
    const transcription = transcriptionProvider("Hello");
    const open = jest.spyOn(transcription, "openStream");
    const registry = new ProviderCapabilityRegistry([
      registration("transcription", "speech-input", transcription, [SOPHIA_PCM_FORMAT], []),
      registration("reasoning", "reasoning", {} as ReasoningProvider, [], []),
      registration("synthesis", "speech-output", synthesisProvider(), [], [SOPHIA_PCM_FORMAT]),
    ]);
    const factory = new OrchestratedVoicePipelineFactory(registry, {} as ReasoningPipelineService);
    expect(() => factory.create(request("reasoning"), [audioSink(), audioSink()])).toThrow("exactly one");
    const incompatible = audioSink(); Object.defineProperty(incompatible, "acceptedFormats", { value: [] });
    expect(() => factory.create(request("reasoning"), [incompatible])).toThrow("output codec");
    expect(open).not.toHaveBeenCalled();
  });
});

function request(reasoningAdapterKey: string) {
  return { customerId: "11111111-1111-4111-8111-111111111111", sessionId: "session-1", sessionAccessToken: "token",
    instructions: "Help with property inspections.", tools: [
      { name: "catalog.search", description: "Search", inputSchema: { type: "object" } },
      { name: "booking.prepare", description: "Prepare", inputSchema: { type: "object" } },
    ], transcriptionAdapterKey: "transcription", reasoningAdapterKey, synthesisAdapterKey: "synthesis",
    inputFormat: SOPHIA_PCM_FORMAT, outputFormat: SOPHIA_PCM_FORMAT };
}

function transcriptionProvider(text: string): TranscriptionProvider {
  return { providerName: "test-transcription", supportedInputFormats: [SOPHIA_PCM_FORMAT], async openStream(input) {
    const session: TranscriptionSession = { pushAudio: async () => undefined,
      async *finishTurn() { yield { type: "transcript.final" as const, turnId: input.turnId, turnEpoch: input.turnEpoch, text, provider: "test-transcription" }; },
      cancel: async () => undefined, close: async () => undefined };
    return session;
  } };
}

function synthesisProvider(): SynthesisProvider {
  return { providerName: "test-synthesis", supportedOutputFormats: [SOPHIA_PCM_FORMAT], async *streamSpeech(input) {
    yield { ...input, sequence: 0, audio: Uint8Array.of(1, 2), provider: "test-synthesis" };
  }, cancel: async () => undefined, close: async () => undefined };
}

function audioSink(): AudioOutputSink & { write: jest.Mock; interrupt: jest.Mock } {
  return { sinkId: "direct-media", acceptedFormats: [SOPHIA_PCM_FORMAT], write: jest.fn(async (_chunk: SpeechChunk) => undefined),
    interrupt: jest.fn(async () => undefined), close: async () => undefined };
}

function registration(key: string, capability: string, implementation: object, inputs: string[], outputs: string[]): ProviderAdapterRegistration {
  return { adapterKey: key, implementation, manifest: { providerId: key, adapterVersion: "test.1", configurationSchema: {},
    capabilities: [capability], supportedModes: ["orchestrated-voice"], supportedInputModalities: [], supportedOutputModalities: [], languages: ["en-AU"],
    toolSchemaCapabilities: [], toolDeliveryModes: [], transportAdapters: ["test"], interruptionCapabilities: ["provider-cancel"],
    inputAudioFormats: inputs, outputAudioFormats: outputs, usageDimensions: [], dataHandlingAssessmentRef: "review://test", credentialRef: "env://test",
    healthPolicy: { checkKey: "test", maximumAgeSeconds: 60, failClosed: true } } };
}

function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; }
async function collect(stream: AsyncIterable<OrchestratedVoiceEvent>): Promise<OrchestratedVoiceEvent[]> {
  const values: OrchestratedVoiceEvent[] = []; for await (const value of stream) values.push(value); return values;
}
