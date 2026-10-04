import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const REQUIRED_COMPOSITIONS = ["essential", "professional", "premium"];
const REQUIRED_METRICS = [
  "startup", "first_audio", "interruption", "tool_execution", "concurrency",
  "report_duration", "delivery_queue_age",
];
const REQUIRED_OBJECTIVES = [...REQUIRED_METRICS, "provider_cost_per_session", "failover_limit"];
const REQUIRED_REHEARSALS = ["provider_outage", "partial_startup", "queue_backlog", "privacy_incident", "rollback"];

const registerUrl = new URL("../../docs/sophia/p6-05-evidence-register.json", import.meta.url);
const register = JSON.parse(await readFile(registerUrl, "utf8"));
const structuralErrors = [];

if (register.taskId !== "P6-05") structuralErrors.push("taskId must be P6-05");
if (register.dependency?.taskId !== "P6-04") structuralErrors.push("P6-04 dependency is missing");

for (const id of REQUIRED_COMPOSITIONS) {
  const composition = register.compositions?.find((entry) => entry.id === id);
  if (!composition) structuralErrors.push(`composition ${id} is missing`);
  else if (!composition.owner || !composition.runbook || !composition.rollback) {
    structuralErrors.push(`composition ${id} must have owner, runbook and rollback`);
  }
}
for (const id of REQUIRED_METRICS) {
  const metric = register.requiredMetrics?.find((entry) => entry.id === id);
  if (!metric?.requiredModes?.length) structuralErrors.push(`metric ${id} or its modes are missing`);
}
for (const id of REQUIRED_OBJECTIVES) {
  if (!register.objectives?.some((entry) => entry.id === id)) structuralErrors.push(`objective ${id} is missing`);
}
for (const id of REQUIRED_REHEARSALS) {
  if (!register.rehearsals?.some((entry) => entry.id === id)) structuralErrors.push(`rehearsal ${id} is missing`);
}

const evidenceGaps = [];
for (const compositionId of REQUIRED_COMPOSITIONS) {
  for (const metric of register.requiredMetrics ?? []) {
    for (const mode of metric.requiredModes ?? []) {
      const observation = register.observations?.find((entry) =>
        entry.compositionId === compositionId && entry.metricId === metric.id && entry.mode === mode);
      if (!observation || !observation.datasetRef || !Number.isInteger(observation.sampleSize) || observation.sampleSize < 1) {
        evidenceGaps.push(`${compositionId}:${metric.id}:${mode}`);
      }
    }
  }
}

const unapprovedObjectives = (register.objectives ?? [])
  .filter((entry) => entry.approval !== "approved" || entry.target === null || entry.target === undefined)
  .map((entry) => entry.id ?? "unknown");
const unrehearsed = (register.rehearsals ?? [])
  .filter((entry) => entry.status !== "passed")
  .map((entry) => entry.id ?? "unknown");
const ready = structuralErrors.length === 0
  && register.dependency?.status === "complete"
  && evidenceGaps.length === 0
  && unapprovedObjectives.length === 0
  && unrehearsed.length === 0
  && register.claims?.productionReady === true;

console.log(JSON.stringify({
  stage: "p6_05_service_objective_audit",
  register: fileURLToPath(registerUrl),
  decision: ready ? "ready_for_approval" : "keep_production_activation_blocked",
  structure: structuralErrors.length === 0 ? "pass" : "fail",
  dependency: register.dependency,
  supportedCompositions: register.compositions?.map((entry) => entry.id) ?? [],
  evidenceGapCount: evidenceGaps.length,
  evidenceGaps,
  unapprovedObjectives,
  unrehearsed,
  declaredBlockers: register.blockers ?? [],
  externalMutation: false,
  liveProviderRequest: false,
}, null, 2));

if (structuralErrors.length > 0) {
  console.error(structuralErrors.join("\n"));
  process.exitCode = 1;
} else if (!ready && !process.argv.includes("--preflight")) {
  process.exitCode = 2;
}
