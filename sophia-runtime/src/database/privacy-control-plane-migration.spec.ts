import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

describe("privacy control-plane migration", () => {
  it("keeps privacy state tenant-isolated, purpose-specific and fail-closed", async () => {
    const sql = await readFile(resolve(dirname(fileURLToPath(import.meta.url)), "migrations/023_privacy_control_plane.sql"), "utf8");
    expect(sql).toContain("privacy_notice_versions");
    expect(sql).toContain("privacy_consent_events");
    expect(sql).toContain("privacy_subject_requests");
    expect(sql).toContain("privacy_subject_request_targets");
    expect(sql).toContain("privacy_data_flows");
    expect(sql).toContain("privacy_legal_reviews");
    expect(sql).toContain("CHECK (raw_audio_recording_enabled = false)");
    expect(sql).toContain("CHECK (full_transcript_persistence_enabled = false)");
    expect(sql).toContain("CHECK (marketing_enabled = false)");
    expect(sql).toContain("Privacy consent evidence is append-only");
    expect(sql).toContain("ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.%I FORCE ROW LEVEL SECURITY");
    expect(sql).toContain("status IN ('required', 'pending', 'approved')");
    expect(sql).not.toMatch(/retention_days[^\n]*DEFAULT/i);
  });
});
