import { Logger } from "@nestjs/common";
import { performance } from "node:perf_hooks";

export type StudentOperationsTimingPhase =
  | "workspace-guard"
  | "workspace-resolution"
  | "student-register"
  | "xero-status"
  | "xero-invoices"
  | "xero-payment-tracks";

export function studentOperationsTimingEnabled(): boolean {
  return process.env.SOPHIA_STUDENT_OPERATIONS_TIMING === "1";
}

export function elapsedMs(startedAt: number): number {
  return Math.round((performance.now() - startedAt) * 100) / 100;
}

export function addDatabaseTimings(
  durations: Record<string, number | undefined>,
  timings: object,
): void {
  for (const [name, value] of Object.entries(timings)) {
    if (typeof value === "number") {
      durations[`db${name.charAt(0).toUpperCase()}${name.slice(1)}`] = value;
    }
  }
}

export function logStudentOperationsTiming(
  phase: StudentOperationsTimingPhase,
  correlationId: string | undefined,
  outcome: "ok" | "error",
  durations: Record<string, number | undefined>,
  operation?: string,
): void {
  if (!studentOperationsTimingEnabled()) return;
  const rounded = Object.fromEntries(Object.entries(durations)
    .filter((entry): entry is [string, number] => typeof entry[1] === "number")
    .map(([name, value]) => [name, Math.round(value * 100) / 100]));
  Logger.log(JSON.stringify({
    event: "student_operations_timing",
    phase,
    ...(operation ? { operation } : {}),
    correlationId: correlationId ?? "unavailable",
    outcome,
    ...rounded,
  }), "StudentOperationsTiming");
}

export async function timeStudentOperations<T>(
  phase: StudentOperationsTimingPhase,
  correlationId: string | undefined,
  work: () => Promise<T>,
): Promise<T> {
  const startedAt = performance.now();
  let outcome: "ok" | "error" = "error";
  try {
    const result = await work();
    outcome = "ok";
    return result;
  } finally {
    logStudentOperationsTiming(phase, correlationId, outcome, { totalMs: elapsedMs(startedAt) });
  }
}
