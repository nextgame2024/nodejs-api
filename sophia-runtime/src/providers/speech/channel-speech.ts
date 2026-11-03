import "reflect-metadata";
import { OpenAIBufferedTranscriptionProvider } from "./openai-buffered-transcription.provider.js";
import { OpenAISpeechSynthesisProvider } from "./openai-speech-synthesis.provider.js";
import {
  SOPHIA_PCM_FORMAT,
  type TranscriptionProvider,
  type SynthesisProvider,
} from "./speech-provider.interface.js";
export async function transcribeChannelAudio(
  input: {
    adapterKey: string;
    credentialRef: string;
    jobId: string;
    pcm: Uint8Array;
    signal: AbortSignal;
  },
  override?: TranscriptionProvider,
) {
  if (
    input.adapterKey !== "openai-transcription-v1" ||
    input.credentialRef !== "env://openai-transcription"
  )
    throw new Error("Unsupported speech input binding.");
  const session = await (
    override ?? new OpenAIBufferedTranscriptionProvider()
  ).openStream({
    turnId: input.jobId,
    turnEpoch: 1,
    inputFormat: SOPHIA_PCM_FORMAT,
  });
  try {
    await session.pushAudio(input.pcm);
    let text = "";
    for await (const event of session.finishTurn(input.signal)) {
      if (event.type === "transcript.final") text = event.text.trim();
    }
    if (!text || text.length > 4000) throw new Error("Invalid transcript.");
    return text;
  } finally {
    await session.close();
  }
}
export async function synthesizeChannelAudio(
  input: {
    adapterKey: string;
    credentialRef: string;
    jobId: string;
    text: string;
    signal: AbortSignal;
  },
  override?: SynthesisProvider,
) {
  if (
    input.adapterKey !== "openai-synthesis-v1" ||
    input.credentialRef !== "env://openai-synthesis"
  )
    throw new Error("Unsupported speech output binding.");
  const provider = override ?? new OpenAISpeechSynthesisProvider(),
    chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for await (const chunk of provider.streamSpeech(
      {
        turnId: input.jobId,
        turnEpoch: 1,
        text: input.text,
        outputFormat: SOPHIA_PCM_FORMAT,
      },
      input.signal,
    )) {
      size += chunk.audio.byteLength;
      if (size > 12000000) throw new Error("Voice output too long.");
      chunks.push(chunk.audio);
    }
    if (!size || size % 2) throw new Error("Invalid voice output.");
    const pcm = new Uint8Array(size);
    let at = 0;
    for (const c of chunks) {
      pcm.set(c, at);
      at += c.length;
    }
    return pcm;
  } finally {
    for (const c of chunks) c.fill(0);
    await provider.close();
  }
}
