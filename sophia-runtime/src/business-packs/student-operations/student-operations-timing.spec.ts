import { afterEach, describe, expect, it, jest } from "@jest/globals";
import { Logger } from "@nestjs/common";
import { logStudentOperationsTiming, timeStudentOperations } from "./student-operations-timing.js";

const originalFlag = process.env.SOPHIA_STUDENT_OPERATIONS_TIMING;

afterEach(() => {
  if (originalFlag === undefined) delete process.env.SOPHIA_STUDENT_OPERATIONS_TIMING;
  else process.env.SOPHIA_STUDENT_OPERATIONS_TIMING = originalFlag;
  jest.restoreAllMocks();
});

describe("Student Operations timing diagnostics", () => {
  it("emits nothing unless explicitly enabled", () => {
    delete process.env.SOPHIA_STUDENT_OPERATIONS_TIMING;
    const log = jest.spyOn(Logger, "log").mockImplementation(() => undefined);
    logStudentOperationsTiming("student-register", "test-correlation", "ok", { totalMs: 4 });
    expect(log).not.toHaveBeenCalled();
  });

  it("emits only a correlation ID, phase, outcome, and durations", async () => {
    process.env.SOPHIA_STUDENT_OPERATIONS_TIMING = "1";
    const log = jest.spyOn(Logger, "log").mockImplementation(() => undefined);
    await expect(timeStudentOperations("xero-status", "test-correlation", async () => "ok"))
      .resolves.toBe("ok");
    const entry = JSON.parse(String(log.mock.calls[0]?.[0]));
    expect(entry).toEqual({
      event: "student_operations_timing",
      phase: "xero-status",
      correlationId: "test-correlation",
      outcome: "ok",
      totalMs: expect.any(Number),
    });
    expect(log.mock.calls[0]?.[1]).toBe("StudentOperationsTiming");
  });

  it("preserves request failures while recording an error outcome", async () => {
    process.env.SOPHIA_STUDENT_OPERATIONS_TIMING = "1";
    const log = jest.spyOn(Logger, "log").mockImplementation(() => undefined);
    await expect(timeStudentOperations("xero-payment-tracks", "test-correlation", async () => {
      throw new Error("private upstream detail");
    })).rejects.toThrow("private upstream detail");
    const entry = JSON.parse(String(log.mock.calls[0]?.[0]));
    expect(entry.outcome).toBe("error");
    expect(JSON.stringify(entry)).not.toContain("private upstream detail");
  });
});
