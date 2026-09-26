import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import { BadRequestException, ConflictException, ForbiddenException } from "@nestjs/common";
import type { PoolClient } from "pg";
import { createHash } from "node:crypto";
import type { AdminPrincipal } from "../contracts/admin-contracts.js";
import { OrganisationLifecycleService } from "./organisation-lifecycle.service.js";

const tenantId = "11111111-1111-4111-8111-111111111111";
const principal = {
  apiVersion: "1.0.0", identityUserId: "owner-user", tenantId,
  externalCompanyId: "33333333-3333-4333-8333-333333333333",
  membershipId: "22222222-2222-4222-8222-222222222222",
  role: "organisation_owner", permissions: [], authorizationRevision: 1,
} as AdminPrincipal;

describe("organisation membership lifecycle", () => {
  beforeEach(() => {
    process.env.SOPHIA_RUNTIME_DATABASE_URL = "postgres://example";
    process.env.SOPHIA_RUNTIME_SCHEMA = "sophia_runtime";
  });

  it("maps strict contract failures to an HTTP 400 response", async () => {
    const service = new OrganisationLifecycleService(database({ query: jest.fn() } as unknown as PoolClient) as never, { record: jest.fn() } as never);
    await expect(service.issueInvitation(tenantId, principal, {
      email: "not-an-email", role: "platform_admin", deliveryMode: "live",
    })).rejects.toBeInstanceOf(BadRequestException);
  });

  it("returns server-computed effective grants without exposing permission overrides", async () => {
    const client = { query: jest.fn().mockResolvedValue({ rows: [{
      membership_id: "44444444-4444-4444-8444-444444444444",
      identity_user_id: "auditor", role_key: "read_only_auditor", status: "active",
      authorization_revision: 2,
      permission_overrides: { allow: [], deny: ["audit.read", "not.a.permission"] },
      created_at: new Date("2026-01-01T00:00:00.000Z"),
      updated_at: new Date("2026-01-02T00:00:00.000Z"),
    }], rowCount: 1 }) } as unknown as PoolClient;
    const service = new OrganisationLifecycleService(database(client) as never, { record: jest.fn() } as never);

    const result = await service.listMembers(tenantId);

    expect(result.members[0]).toEqual(expect.objectContaining({
      role_key: "read_only_auditor",
      effective_permissions: expect.arrayContaining(["permissions.read", "organisation.read"]),
    }));
    expect(result.members[0].effective_permissions).not.toContain("audit.read");
    expect(result.members[0]).not.toHaveProperty("permission_overrides");
  });

  it("describes fixed roles, MFA-sensitive grants and platform-only permissions", () => {
    const service = new OrganisationLifecycleService(database({ query: jest.fn() } as unknown as PoolClient) as never, { record: jest.fn() } as never);
    const registry = service.permissionRegistry();

    expect(registry.roles.find((item) => item.role === "organisation_owner")?.permissions)
      .toContain("users.roles.assign");
    expect(registry.mfaRequiredPermissions).toContain("users.roles.assign");
    expect(registry.platformPermissions).toEqual([
      "platform.organisations.provision",
      "platform.support.access",
    ]);
    expect(registry.customRolesSupported).toBe(false);
  });

  it("issues a single-use dry-run invitation without persisting or auditing its plaintext token", async () => {
    const query = jest.fn()
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [{ invitation_id: "invite-1", revision: 1 }], rowCount: 1 });
    const client = { query } as unknown as PoolClient;
    const audit = { record: jest.fn().mockResolvedValue(undefined) };
    const service = new OrganisationLifecycleService(database(client) as never, audit as never);
    const result = await service.issueInvitation(tenantId, principal, {
      email: "Person@Example.com", role: "configuration_editor", expiresInHours: 24, deliveryMode: "dry-run",
    });
    const insertParams = query.mock.calls[2]?.[1] as unknown[];
    expect(result.delivery.token).toHaveLength(43);
    expect(insertParams[3]).not.toBe(result.delivery.token);
    expect(String(insertParams[3])).toHaveLength(64);
    expect(JSON.stringify(audit.record.mock.calls)).not.toContain(result.delivery.token);
  });

  it.each([
    ["redeemed", new Date(Date.now() + 60_000), "person@example.com"],
    ["pending", new Date(Date.now() - 60_000), "person@example.com"],
    ["pending", new Date(Date.now() + 60_000), "wrong@example.com"],
  ])("rejects replayed, expired, and wrong-recipient invitations", async (status, expiresAt, email) => {
    const client = { query: jest.fn().mockResolvedValue({ rows: [{
      invitation_id: "invite-1", recipient_email_hash: sha256("person@example.com"),
      role_key: "configuration_editor", status, expires_at: expiresAt,
      external_company_id: principal.externalCompanyId,
    }], rowCount: 1 }) } as unknown as PoolClient;
    const service = new OrganisationLifecycleService(database(client, true) as never, { record: jest.fn() } as never);
    await expect(service.redeemInvitation({
      userId: "invitee", companyId: principal.externalCompanyId, status: "active", email,
    }, { token: "A".repeat(43) })).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("redeems a valid invitation once and creates its fixed-role membership", async () => {
    const client = { query: jest.fn()
      .mockResolvedValueOnce({ rows: [{
        invitation_id: "invite-1", recipient_email_hash: sha256("person@example.com"),
        role_key: "configuration_editor", status: "pending",
        expires_at: new Date(Date.now() + 60_000), external_company_id: principal.externalCompanyId,
      }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [{ membership_id: "membership-1" }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 }) } as unknown as PoolClient;
    const audit = { record: jest.fn().mockResolvedValue(undefined) };
    const service = new OrganisationLifecycleService(database(client, true) as never, audit as never);

    await expect(service.redeemInvitation({
      userId: "invitee", companyId: principal.externalCompanyId,
      status: "active", email: "Person@Example.com",
    }, { token: "A".repeat(43) })).resolves.toEqual({
      tenantId, membershipId: "membership-1", role: "configuration_editor",
    });
    expect(client.query.mock.calls[2]?.[1]).toEqual([tenantId, "invitee", "configuration_editor"]);
    expect(client.query.mock.calls[3]?.[1]).toEqual(["invitee", "invite-1"]);
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({
      eventType: "invitation.redeemed", resourceId: "membership-1",
    }), client);
  });

  it("prevents stale membership updates", async () => {
    const client = { query: jest.fn().mockResolvedValue({ rows: [{
      membership_id: "44444444-4444-4444-8444-444444444444",
      identity_user_id: "member", role_key: "configuration_editor", status: "active", authorization_revision: 3,
    }], rowCount: 1 }) } as unknown as PoolClient;
    const service = new OrganisationLifecycleService(database(client) as never, { record: jest.fn() } as never);
    await expect(service.updateMembership(
      tenantId, "44444444-4444-4444-8444-444444444444", principal,
      { expectedRevision: 2, role: "release_publisher" },
    )).rejects.toBeInstanceOf(ConflictException);
  });

  it("prevents members from changing their own role or status", async () => {
    const client = { query: jest.fn().mockResolvedValue({ rows: [{
      membership_id: principal.membershipId, identity_user_id: principal.identityUserId,
      role_key: "organisation_owner", status: "active", authorization_revision: 1,
    }], rowCount: 1 }) } as unknown as PoolClient;
    const service = new OrganisationLifecycleService(database(client) as never, { record: jest.fn() } as never);
    await expect(service.updateMembership(
      tenantId, principal.membershipId, principal,
      { expectedRevision: 1, role: "configuration_editor" },
    )).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("protects the final active organisation owner", async () => {
    const client = { query: jest.fn()
      .mockResolvedValueOnce({ rows: [{
        membership_id: "44444444-4444-4444-8444-444444444444",
        identity_user_id: "other-owner", role_key: "organisation_owner", status: "active", authorization_revision: 1,
      }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ count: 1 }], rowCount: 1 }) } as unknown as PoolClient;
    const service = new OrganisationLifecycleService(database(client) as never, { record: jest.fn() } as never);
    await expect(service.updateMembership(
      tenantId, "44444444-4444-4444-8444-444444444444", principal,
      { expectedRevision: 1, status: "revoked" },
    )).rejects.toThrow("final active organisation owner");
  });
});

function database(client: PoolClient, invitationLookup = false) {
  return {
    query: jest.fn().mockResolvedValue(invitationLookup ? { rows: [{ customer_id: tenantId }], rowCount: 1 } : { rows: [] }),
    tenantTransaction: jest.fn(async (_tenant: string, work: (client: PoolClient) => unknown) => work(client)),
  };
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
