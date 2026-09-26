import { describe, expect, it } from "@jest/globals";
import { MemoryActionReviewStore } from "./action-review.store.js";

describe("MemoryActionReviewStore", () => {
  const context = { customerId: "customer-1", sessionId: "session-1" };

  it("returns only the current review for the authenticated session context", async () => {
    const store = new MemoryActionReviewStore();
    const created = await store.create(context, "inspection.booking", { customerEmail: "person@example.com" });

    await expect(store.current(context)).resolves.toMatchObject({
      reviewId: created.reviewId,
      actionType: "inspection.booking",
      status: "reviewed",
      payload: { customerEmail: "person@example.com" },
    });
    await expect(store.current({ ...context, sessionId: "session-2" })).resolves.toBeNull();
  });

  it("invalidates cancellation and scrubs committed review payloads on session cleanup", async () => {
    const store = new MemoryActionReviewStore();
    const cancelled = await store.create(context, "inspection.booking", { customerEmail: "cancel@example.com" });
    await store.cancel(context, cancelled.reviewId);
    await expect(store.current(context)).resolves.toBeNull();

    const committed = await store.create(context, "inspection.booking", { customerEmail: "commit@example.com" });
    await store.confirm(context, committed.reviewId);
    await store.consume(context, committed.reviewId, "inspection.booking", { customerEmail: "commit@example.com" });
    await store.clear(context);
    await expect(store.current(context)).resolves.toBeNull();
  });
});
