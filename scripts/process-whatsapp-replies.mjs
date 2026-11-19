import "dotenv/config";
import { setTimeout as sleep } from "node:timers/promises";
import pool from "../src/config/db.js";
import { channelProfiles } from "../src/services/messaging/channel-profiles.js";
import { processChannelEvent } from "../src/services/messaging/whatsapp-channel.service.js";
import {
  generateOne,
  dispatchOne,
} from "../src/services/messaging/reply-worker.js";
import { sendText } from "../src/adapters/whatsapp/outbound.js";
import { workerFailureCode } from "../src/services/messaging/worker-diagnostics.js";
import { generateChannelAnswer } from "../sophia-runtime/dist/providers/reasoning/channel-reasoner.js";
import {
  transcribeOne,
  synthesizeOne,
  expireVoiceAssets,
  prepareVoiceMedia,
} from "../src/services/messaging/voice-worker.js";
import { downloadAudio, uploadAudio } from "../src/adapters/whatsapp/media.js";
import {
  transcribeChannelAudio,
  synthesizeChannelAudio,
} from "../sophia-runtime/dist/providers/speech/channel-speech.js";
if (process.env.WHATSAPP_REPLY_WORKER_ENABLED !== "true")
  throw new Error("WhatsApp reply worker is disabled.");
const profiles = channelProfiles().filter((p) => p.ready);
if (!profiles.length) throw new Error("No ready reply profiles.");
const abort = new AbortController();
for (const signal of ["SIGINT", "SIGTERM"])
  process.once(signal, () => abort.abort());
// Each lane is bounded to one in-flight operation. Slow generation never occupies
// an interactive HTTP request or prevents another lane from dispatching replies.
async function lane(operation, work, idleMs = 2000) {
  while (!abort.signal.aborted) {
    let busy = false;
    for (const p of profiles) {
      if (abort.signal.aborted) break;
      try {
        const result = await work(p);
        busy ||= result.processed;
      } catch (error) {
        console.error(
          JSON.stringify({
            event: "whatsapp_reply_tick_failed",
            profileId: p.id,
            operation,
            code: workerFailureCode(error),
          }),
        );
      }
    }
    await sleep(busy ? 100 : idleMs, undefined, { signal: abort.signal }).catch(
      (e) => {
        if (e.name !== "AbortError") throw e;
      },
    );
  }
}
try {
  await Promise.all([
    ...(process.env.WHATSAPP_INBOUND_WORKER_ENABLED === "true"
      ? [lane("inbound", (p) => processChannelEvent(p))]
      : []),
    lane("generation", (p) => generateOne(p, generateChannelAnswer)),
    lane("voice_expiry", (p) => expireVoiceAssets(p), 60000),
    lane("dispatch", (p) =>
      dispatchOne(p, sendText, {
        prepareAudio: (profile, message) =>
          prepareVoiceMedia(profile, message, uploadAudio),
      }),
    ),
    ...(process.env.WHATSAPP_VOICE_ENABLED === "true"
      ? [
          lane("transcription", (p) =>
            transcribeOne(p, {
              download: downloadAudio,
              transcribe: transcribeChannelAudio,
            }),
          ),
          lane("synthesis", (p) => synthesizeOne(p, { synthesize: synthesizeChannelAudio })),
        ]
      : []),
  ]);
} finally {
  abort.abort();
  await pool.end();
}
