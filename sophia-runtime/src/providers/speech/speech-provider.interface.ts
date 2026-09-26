export const SOPHIA_PCM_FORMAT = "pcm-s16le-24000-mono" as const;

export type SpeechAudioFormat = typeof SOPHIA_PCM_FORMAT;

export type TranscriptEvent =
  | { type: "transcript.partial"; turnId: string; turnEpoch: number; text: string; provider: string }
  | { type: "transcript.final"; turnId: string; turnEpoch: number; text: string; provider: string };

export interface TranscriptionSession {
  pushAudio(chunk: Uint8Array): Promise<void>;
  finishTurn(signal: AbortSignal): AsyncIterable<TranscriptEvent>;
  cancel(): Promise<void>;
  close(): Promise<void>;
}

export interface TranscriptionProvider {
  readonly providerName: string;
  readonly supportedInputFormats: readonly SpeechAudioFormat[];
  openStream(request: {
    turnId: string;
    turnEpoch: number;
    inputFormat: SpeechAudioFormat;
  }): Promise<TranscriptionSession>;
}

export type SpeechChunk = {
  turnId: string;
  turnEpoch: number;
  sequence: number;
  format: SpeechAudioFormat;
  audio: Uint8Array;
  provider: string;
};

export interface SynthesisProvider {
  readonly providerName: string;
  readonly supportedOutputFormats: readonly SpeechAudioFormat[];
  streamSpeech(request: {
    turnId: string;
    turnEpoch: number;
    text: string;
    outputFormat: SpeechAudioFormat;
  }, signal: AbortSignal): AsyncIterable<SpeechChunk>;
  cancel(turnId: string): Promise<void>;
  close(): Promise<void>;
}

/** The sole owner of playable audio. It can be a direct transport or a verified avatar adapter. */
export interface AudioOutputSink {
  readonly sinkId: string;
  readonly acceptedFormats: readonly SpeechAudioFormat[];
  write(chunk: SpeechChunk): Promise<void>;
  interrupt(turnId: string): Promise<void>;
  close(): Promise<void>;
}
