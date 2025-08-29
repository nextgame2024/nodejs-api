import { PollyClient, SynthesizeSpeechCommand } from "@aws-sdk/client-polly";

const polly = new PollyClient({ region: process.env.S3_REGION });

export async function ttsToBuffer(text) {
  const VoiceId = process.env.POLLY_VOICE || "Matthew";
  const cmd = new SynthesizeSpeechCommand({
    OutputFormat: "mp3",
    Text: text,
    VoiceId,
  });
  const res = await polly.send(cmd);
  const chunks = [];
  for await (const c of res.AudioStream) chunks.push(c);
  return Buffer.concat(chunks);
}
