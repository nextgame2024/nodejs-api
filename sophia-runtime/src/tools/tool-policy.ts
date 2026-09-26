import { z } from "zod";
import type { RuntimeToolPolicy } from "./tool-registry.js";

export const SafeToolOutputSchema = z.unknown().superRefine((value, context) => {
  const issue = validateJson(value, 0);
  if (issue) context.addIssue({ code: "custom", message: issue });
});

export function toolPolicy(
  input: Pick<RuntimeToolPolicy, "toolId" | "requiredCapability" | "sideEffectClass"> &
    Partial<Omit<RuntimeToolPolicy, "toolId" | "requiredCapability" | "sideEffectClass">>,
): RuntimeToolPolicy {
  const mutation = ["business-mutation", "notification", "handoff"].includes(input.sideEffectClass);
  const read = input.sideEffectClass === "read";
  return {
    version: "1.0.0",
    requiredScopes: [],
    riskClass: mutation ? "high" : input.sideEffectClass === "prepare-command" ? "medium" : "low",
    confirmationPolicy: mutation ? "explicit-user-review" : "none",
    timeoutMs: read ? 8_000 : 15_000,
    retryPolicy: read ? "safe-read" : "none",
    idempotencyPolicy: mutation ? "stable-command" : "tool-call",
    ...input,
  };
}

export function minimiseToolOutput(value: unknown, depth = 0): unknown {
  if (depth > 10) return "[TRUNCATED_DEPTH]";
  if (typeof value === "string") return value.length > 4_000 ? `${value.slice(0, 4_000)}…` : value;
  if (Array.isArray(value)) return value.slice(0, 100).map((item) => minimiseToolOutput(item, depth + 1));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .slice(0, 100)
      .map(([key, entry]) => [key, minimiseToolOutput(entry, depth + 1)]));
  }
  return value;
}

function validateJson(value: unknown, depth: number): string | undefined {
  if (depth > 20) return "Tool output exceeds the maximum nesting depth.";
  if (value === null || typeof value === "string" || typeof value === "boolean") return undefined;
  if (typeof value === "number") return Number.isFinite(value) ? undefined : "Tool output contains a non-finite number.";
  if (Array.isArray(value)) {
    if (value.length > 1_000) return "Tool output contains too many array items.";
    for (const entry of value) { const issue = validateJson(entry, depth + 1); if (issue) return issue; }
    return undefined;
  }
  if (value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length > 1_000) return "Tool output contains too many object fields.";
    for (const [, entry] of entries) { const issue = validateJson(entry, depth + 1); if (issue) return issue; }
    return undefined;
  }
  return "Tool output must be JSON-safe data.";
}
