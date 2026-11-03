import { transaction } from "../leads/assistant-settings.service.js";
import { requiredLead, detail } from "../leads/lead-records.service.js";
import { uuid } from "../leads/lead-records.contracts.js";
import { fail } from "../leads/assistant-settings.contracts.js";
import { schema as s } from "./reply-store.js";
import { voiceEnabled, voiceState } from "./voice-store.js";
import { channelProfiles } from "./channel-profiles.js";
export async function retryVoice(actor, company, leadId, jobId) {
  uuid(leadId);
  uuid(jobId);
  return transaction(
    actor,
    company,
    async (db, tenant, access) => {
      await requiredLead(db, tenant, access, leadId, true);
      const permitted = (await voiceState(db, tenant, access, leadId)).find(
        (j) => j.id === jobId && j.canRetry,
      );
      if (!permitted)
        throw fail(
          "This voice reply cannot be retried. Refresh the conversation.",
          409,
        );
      const job = (
        await db.query(
          `SELECT j.*,h.profile_id FROM ${s}.assistant_voice_jobs j JOIN ${s}.assistant_channels h USING(customer_id,channel_id) WHERE j.customer_id=$1 AND j.voice_job_id=$2 FOR UPDATE OF j`,
          [tenant, jobId],
        )
      ).rows[0];
      const profile = channelProfiles().find(
        (p) => p.customerId === tenant && p.id === job.profile_id,
      );
      if (!voiceEnabled(profile))
        throw fail("Voice replies are not configured.", 409);
      // Regenerate only the failed voice part. Never touch the accepted text parent.
      await db.query(
        `UPDATE ${s}.assistant_voice_jobs SET state='queued',failure_code=NULL,completed_at=NULL WHERE customer_id=$1 AND voice_job_id=$2`,
        [tenant, jobId],
      );
      await db.query(
        `UPDATE ${s}.assistant_message_outbox SET state='preparing',safe_code=NULL,updated_at=now() WHERE customer_id=$1 AND message_id=$2 AND state='failed'`,
        [tenant, job.message_id],
      );
      return detail(db, tenant, access, leadId);
    },
    { inbox: true },
  );
}
