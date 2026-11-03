import "dotenv/config";
import { setTimeout as sleep } from "node:timers/promises";
import pool from "../src/config/db.js";
import { channelProfiles } from "../src/services/messaging/channel-profiles.js";
import { processChannelEvent } from "../src/services/messaging/whatsapp-channel.service.js";
if (process.env.WHATSAPP_INBOUND_WORKER_ENABLED !== "true")
  throw new Error("WhatsApp inbound worker is disabled.");
const profiles = channelProfiles().filter((p) => p.ready);
if (!profiles.length) throw new Error("No ready WhatsApp inbound profiles.");
const abort = new AbortController();
for (const signal of ["SIGINT", "SIGTERM"])
  process.once(signal, () => abort.abort());
// One bounded database-only operation per channel per tick, fair across tenants.
// Multiple processes coordinate with SKIP LOCKED plus per-contact advisory locks.
try {
  while (!abort.signal.aborted) {
    let busy = false;
    for (const profile of profiles) {
      if (abort.signal.aborted) break;
      try {
        const result = await processChannelEvent(profile);
        busy ||= result.processed;
      } catch {
        console.error(
          JSON.stringify({
            event: "whatsapp_inbound_tick_failed",
            profileId: profile.id,
          }),
        );
      }
    }
    await sleep(busy ? 50 : 2000, undefined, { signal: abort.signal }).catch(
      (e) => {
        if (e.name !== "AbortError") throw e;
      },
    );
  }
} finally {
  await pool.end();
}
