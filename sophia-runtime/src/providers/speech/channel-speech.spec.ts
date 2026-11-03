import { describe, it, expect, jest } from "@jest/globals";
import {
  transcribeChannelAudio,
  synthesizeChannelAudio,
} from "./channel-speech.js";
import type {
  TranscriptionProvider,
  SynthesisProvider,
} from "./speech-provider.interface.js";
const base = { jobId: "job", signal: new AbortController().signal };
describe("Messaging speech provider bridge", () => {
  it("transcribes a final turn and closes the session", async () => {
    const close = jest.fn(async () => {});
    const provider = {
      openStream: async () => ({
        pushAudio: async () => {},
        close,
        finishTurn: async function* () {
          yield { type: "transcript.final", text: " Hello " };
        },
      }),
    } as unknown as TranscriptionProvider;
    expect(
      await transcribeChannelAudio(
        {
          ...base,
          adapterKey: "openai-transcription-v1",
          credentialRef: "env://openai-transcription",
          pcm: new Uint8Array(4800),
        },
        provider,
      ),
    ).toBe("Hello");
    expect(close).toHaveBeenCalledTimes(1);
  });
  it("rejects unsupported credential bindings before opening a provider", async () => {
    const openStream = jest.fn();
    await expect(
      transcribeChannelAudio(
        {
          ...base,
          adapterKey: "arbitrary",
          credentialRef: "secret",
          pcm: new Uint8Array(),
        },
        { openStream } as unknown as TranscriptionProvider,
      ),
    ).rejects.toThrow("Unsupported");
    expect(openStream).not.toHaveBeenCalled();
  });
  it("synthesizes the exact answer and closes providers on success or failure", async () => {
    const close = jest.fn(async () => {});
    let text = "";
    const provider = {
      close,
      streamSpeech: async function* (r: { text: string }) {
        text = r.text;
        yield { audio: Uint8Array.of(1, 2, 3, 4) };
      },
    } as unknown as SynthesisProvider;
    expect([
      ...(await synthesizeChannelAudio(
        {
          ...base,
          adapterKey: "openai-synthesis-v1",
          credentialRef: "env://openai-synthesis",
          text: "Exact answer",
        },
        provider,
      )),
    ]).toEqual([1, 2, 3, 4]);
    expect(text).toBe("Exact answer");
    expect(close).toHaveBeenCalled();
    provider.streamSpeech = async function* () {
      yield { audio: new Uint8Array(12000002) } as any;
    };
    await expect(
      synthesizeChannelAudio(
        {
          ...base,
          adapterKey: "openai-synthesis-v1",
          credentialRef: "env://openai-synthesis",
          text: "Exact answer",
        },
        provider,
      ),
    ).rejects.toThrow("too long");
    expect(close).toHaveBeenCalledTimes(2);
  });
});
