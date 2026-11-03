import "dotenv/config";
import { setTimeout as sleep } from "node:timers/promises";
import pool from "../src/config/db.js";
import { channelProfiles } from "../src/services/messaging/channel-profiles.js";
import {
  generateOne,
  dispatchOne,
} from "../src/services/messaging/reply-worker.js";
import { sendText } from "../src/adapters/whatsapp/outbound.js";
import { generateChannelAnswer } from "../sophia-runtime/dist/providers/reasoning/channel-reasoner.js";
if (process.env.WHATSAPP_REPLY_WORKER_ENABLED !== "true")
  throw new Error("WhatsApp reply worker is disabled.");
const profiles = channelProfiles().filter((p) => p.ready);
if (!profiles.length) throw new Error("No ready reply profiles.");
const abort = new AbortController();
for (const signal of ["SIGINT", "SIGTERM"])
  process.once(signal, () => abort.abort());
// Each lane is bounded to one in-flight operation. Slow generation never occupies
// an interactive HTTP request or prevents another lane from dispatching replies.
async function lane(work) {
  while (!abort.signal.aborted) {
    let busy = false;
    for (const p of profiles) {
      if (abort.signal.aborted) break;
      try {
        const result=await work(p);busy ||= result.processed;
      } catch {
        console.error(
          JSON.stringify({
            event: "whatsapp_reply_tick_failed",
            profileId: p.id,
          }),
        );
      }
    }
    await sleep(busy ? 100 : 2000, undefined, { signal: abort.signal }).catch(
      (e) => {
        if (e.name !== "AbortError") throw e;
      },
    );
  }
}
try {
  await Promise.all([
    lane((p) => generateOne(p, generateChannelAnswer)),
    lane((p) => dispatchOne(p, sendText)),
  ]);
} finally {
  abort.abort();
  await pool.end();
}
