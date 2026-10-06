import { beforeEach, describe, expect, jest, test } from "@jest/globals";

const query = jest.fn();
const release = jest.fn();
const connect = jest.fn(async () => ({ query, release }));

jest.unstable_mockModule("../src/config/db.js", () => ({
  default: { connect },
}));

const model = await import("../src/models/bm.business.pack.entitlements.model.js");

const companyId = "11111111-1111-4111-8111-111111111111";
const customerId = "22222222-2222-4222-8222-222222222222";
const actorUserId = "33333333-3333-4333-8333-333333333333";
const targetUserId = "44444444-4444-4444-8444-444444444444";

function targetScope() {
  return {
    user_id: targetUserId,
    user_status: "active",
    workspace_profile: "student_operations",
    customer_id: customerId,
  };
}

describe("student operations role administration authority", () => {
  beforeEach(() => {
    query.mockReset();
    release.mockClear();
    connect.mockClear();
  });

  test("denies role reads when the actor is not the company's Chief Executive", async () => {
    query
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ rows: [targetScope()] })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({});

    await expect(model.getBusinessPackEntitlement({
      companyId,
      targetUserId,
      packId: "open-for-australia",
      actorUserId,
    })).rejects.toMatchObject({ status: 403 });
    expect(query).toHaveBeenCalledWith(expect.stringContaining("role_key = 'chief_executive'"), [
      customerId,
      actorUserId,
      "open-for-australia",
      companyId,
    ]);
    expect(release).toHaveBeenCalled();
  });

  test("prevents a Chief Executive from removing their own authority", async () => {
    query
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ rows: [{ ...targetScope(), user_id: actorUserId }] })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ rows: [{ entitlement_id: "entitlement-1" }] })
      .mockResolvedValueOnce({});

    await expect(model.setBusinessPackEntitlement({
      companyId,
      targetUserId: actorUserId,
      packId: "open-for-australia",
      roleKey: null,
      actorUserId,
    })).rejects.toMatchObject({ status: 409 });
    expect(release).toHaveBeenCalled();
  });
});
