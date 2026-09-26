import { afterEach, beforeEach, describe, expect, it, jest } from "@jest/globals";
import { OpenAIBufferedTranscriptionProvider } from "./openai-buffered-transcription.provider.js";
import { OpenAISpeechSynthesisProvider } from "./openai-speech-synthesis.provider.js";
import { SOPHIA_PCM_FORMAT } from "./speech-provider.interface.js";

describe("OpenAI speech providers", () => {
  beforeEach(() => {
    process.env.SOPHIA_RUNTIME_DATABASE_URL = "postgres://example";
    process.env.OPENAI_API_KEY = "test-openai-key";
    process.env.OPENAI_AUDIO_API_BASE_URL = "https://audio.example/v1";
    process.env.OPENAI_TRANSCRIPTION_MODEL = "configured-transcriber";
    process.env.OPENAI_SYNTHESIS_MODEL = "configured-synthesizer";
    process.env.OPENAI_SYNTHESIS_VOICE = "cedar";
  });
  afterEach(() => jest.restoreAllMocks());

  it("uploads one bounded PCM turn as a 24 kHz mono WAV and emits only canonical final text", async () => {
    const fetchMock = jest.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ text: " Book Bulimba. " }), {
      status: 200, headers: { "content-type": "application/json" },
    }));
    const session = await new OpenAIBufferedTranscriptionProvider().openStream({
      turnId: "turn-1", turnEpoch: 7, inputFormat: SOPHIA_PCM_FORMAT,
    });
    await session.pushAudio(Uint8Array.of(1, 2, 3, 4));
    const events = await collect(session.finishTurn(new AbortController().signal));

    expect(events).toEqual([{ type: "transcript.final", turnId: "turn-1", turnEpoch: 7,
      text: "Book Bulimba.", provider: "openai-transcription" }]);
    expect(fetchMock.mock.calls[0][0]).toBe("https://audio.example/v1/audio/transcriptions");
    const form = fetchMock.mock.calls[0][1]?.body as FormData;
    expect(form.get("model")).toBe("configured-transcriber");
    const bytes = new Uint8Array(await (form.get("file") as File).arrayBuffer());
    expect(new TextDecoder().decode(bytes.subarray(0, 4))).toBe("RIFF");
    expect(new DataView(bytes.buffer).getUint32(24, true)).toBe(24_000);
    expect(bytes.subarray(44)).toEqual(Uint8Array.of(1, 2, 3, 4));
  });

  it("rejects oversized or incomplete PCM before provider I/O", async () => {
    process.env.OPENAI_TRANSCRIPTION_MAX_INPUT_BYTES = "48000";
    const fetchMock = jest.spyOn(globalThis, "fetch");
    const tooLarge = await new OpenAIBufferedTranscriptionProvider().openStream({ turnId: "large", turnEpoch: 1, inputFormat: SOPHIA_PCM_FORMAT });
    await expect(tooLarge.pushAudio(new Uint8Array(48_002))).rejects.toThrow("bounded audio size");
    const incomplete = await new OpenAIBufferedTranscriptionProvider().openStream({ turnId: "odd", turnEpoch: 2, inputFormat: SOPHIA_PCM_FORMAT });
    await incomplete.pushAudio(Uint8Array.of(1));
    await expect(collect(incomplete.finishTurn(new AbortController().signal))).rejects.toThrow("complete PCM16 samples");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("streams configured TTS as aligned PCM chunks without leaking arbitrary HTTP framing", async () => {
    const body = new ReadableStream<Uint8Array>({ start(controller) {
      controller.enqueue(Uint8Array.of(1)); controller.enqueue(Uint8Array.of(2, 3, 4)); controller.close();
    } });
    const fetchMock = jest.spyOn(globalThis, "fetch").mockResolvedValue(new Response(body, { status: 200 }));
    const chunks = await collect(new OpenAISpeechSynthesisProvider().streamSpeech({
      turnId: "turn-2", turnEpoch: 8, text: "Hello", outputFormat: SOPHIA_PCM_FORMAT,
    }, new AbortController().signal));

    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({
      model: "configured-synthesizer", voice: "cedar", input: "Hello", response_format: "pcm", stream_format: "audio",
    });
    expect(chunks.flatMap((chunk) => [...chunk.audio])).toEqual([1, 2, 3, 4]);
    expect(chunks.every((chunk) => chunk.audio.byteLength % 2 === 0)).toBe(true);
    expect(chunks.every((chunk) => chunk.format === SOPHIA_PCM_FORMAT)).toBe(true);
  });
});

async function collect<T>(stream: AsyncIterable<T>): Promise<T[]> {
  const values: T[] = [];
  for await (const value of stream) values.push(value);
  return values;
}
