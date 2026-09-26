import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { ZodType } from "zod";
import { runtimeConfig } from "../../config/runtime-config.js";
import { DatabaseService } from "../../database/database.service.js";
import { AdminAuditService } from "../authorization/admin-audit.service.js";
import type { AdminPrincipal } from "../contracts/admin-contracts.js";
import type { VerifiedBusinessManagerIdentity } from "../identity/business-manager-identity.bridge.js";
import {
  ADMIN_PERMISSIONS,
  ADMIN_ROLE_PERMISSIONS,
  MFA_REQUIRED_PERMISSIONS,
  isAdminPermission,
} from "../permissions/admin-permissions.js";
import {
  InvitationIssueSchema,
  InvitationRedeemSchema,
  MembershipUpdateSchema,
  OrganisationSettingsUpdateSchema,
  OrganisationSuspensionSchema,
  RevisionCheckSchema,
} from "./organisation-lifecycle.contracts.js";

type MembershipRow = {
  membership_id: string;
  identity_user_id: string;
  role_key: keyof typeof ADMIN_ROLE_PERMISSIONS;
  status: "active" | "suspended" | "revoked";
  authorization_revision: number;
};

@Injectable()
export class OrganisationLifecycleService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(AdminAuditService) private readonly audit: AdminAuditService,
  ) {}

  async getOrganisation(tenantId: string) {
    const schema = runtimeConfig().schema;
    const result = await this.database.tenantTransaction(tenantId, (client) => client.query(
      `SELECT customer_id, name, external_company_id, status, metadata,
              settings_revision, admission_suspended_at, suspension_reason,
              created_at, updated_at
       FROM ${schema}.customers WHERE customer_id = $1`,
      [tenantId],
    ));
    if (!result.rows[0]) throw new NotFoundException("Organisation not found.");
    return result.rows[0];
  }

  async updateOrganisation(tenantId: string, principal: AdminPrincipal, input: unknown) {
    const parsed = parseInput(OrganisationSettingsUpdateSchema, input);
    const metadataPatch = {
      ...(parsed.timezone ? { timezone: parsed.timezone } : {}),
      ...(parsed.defaultLocale ? { defaultLocale: parsed.defaultLocale } : {}),
      ...(parsed.branding ? { branding: parsed.branding } : {}),
    };
    const schema = runtimeConfig().schema;
    return this.database.tenantTransaction(tenantId, async (client) => {
      const result = await client.query(
        `UPDATE ${schema}.customers
         SET name = COALESCE($1, name), metadata = metadata || $2::jsonb,
             settings_revision = settings_revision + 1, updated_at = now()
         WHERE customer_id = $3 AND settings_revision = $4
         RETURNING customer_id, name, status, metadata, settings_revision, updated_at`,
        [parsed.name ?? null, JSON.stringify(metadataPatch), tenantId, parsed.expectedRevision],
      );
      if (result.rowCount !== 1) throw new ConflictException("Organisation settings changed; reload before saving.");
      await this.audit.record({
        tenantId, identityUserId: principal.identityUserId,
        eventType: "organisation.settings.updated", permission: "organisation.manage", outcome: "allowed",
        resourceType: "organisation", resourceId: tenantId,
        metadata: { previousRevision: parsed.expectedRevision, changedFields: Object.keys(parsed).filter((key) => key !== "expectedRevision") },
      }, client);
      return result.rows[0];
    });
  }

  async suspendOrganisation(tenantId: string, principal: AdminPrincipal, input: unknown) {
    const parsed = parseInput(OrganisationSuspensionSchema, input);
    return this.setOrganisationAdmission(tenantId, principal, parsed.expectedRevision, false, parsed.reason);
  }

  async resumeOrganisation(tenantId: string, principal: AdminPrincipal, input: unknown) {
    const parsed = parseInput(RevisionCheckSchema, input);
    return this.setOrganisationAdmission(tenantId, principal, parsed.expectedRevision, true);
  }

  async listMembers(tenantId: string) {
    const schema = runtimeConfig().schema;
    const result = await this.database.tenantTransaction(tenantId, (client) => client.query<MembershipRow & {
      created_at: Date;
      updated_at: Date;
      permission_overrides: { allow?: unknown; deny?: unknown } | null;
    }>(
      `SELECT membership_id, identity_user_id, role_key, status,
              authorization_revision, permission_overrides, created_at, updated_at
       FROM ${schema}.admin_memberships WHERE customer_id = $1
       ORDER BY created_at, membership_id`,
      [tenantId],
    ));
    return {
      members: result.rows.map(({ permission_overrides: overrides, ...member }) => ({
        ...member,
        effective_permissions: effectivePermissions(member.role_key, overrides),
      })),
    };
  }

  async updateMembership(
    tenantId: string,
    membershipId: string,
    principal: AdminPrincipal,
    input: unknown,
  ) {
    const parsed = parseInput(MembershipUpdateSchema, input);
    const schema = runtimeConfig().schema;
    return this.database.tenantTransaction(tenantId, async (client) => {
      const target = await client.query<MembershipRow>(
        `SELECT membership_id, identity_user_id, role_key, status, authorization_revision
         FROM ${schema}.admin_memberships
         WHERE membership_id = $1 AND customer_id = $2 FOR UPDATE`,
        [membershipId, tenantId],
      );
      const current = target.rows[0];
      if (!current) throw new NotFoundException("Membership not found.");
      if (current.authorization_revision !== parsed.expectedRevision) {
        throw new ConflictException("Membership changed; reload before saving.");
      }
      if (current.membership_id === principal.membershipId) {
        throw new ForbiddenException("Members cannot change their own role or membership status.");
      }
      const nextRole = parsed.role ?? current.role_key;
      const nextStatus = parsed.status ?? current.status;
      if (current.role_key === "organisation_owner" && current.status === "active"
          && (nextRole !== "organisation_owner" || nextStatus !== "active")) {
        const owners = await client.query<{ count: number }>(
          `SELECT count(*)::int AS count FROM ${schema}.admin_memberships
           WHERE customer_id = $1 AND role_key = 'organisation_owner' AND status = 'active'`,
          [tenantId],
        );
        if (Number(owners.rows[0]?.count ?? 0) <= 1) {
          throw new ConflictException("The final active organisation owner cannot be removed or demoted.");
        }
      }
      const updated = await client.query(
        `UPDATE ${schema}.admin_memberships
         SET role_key = $1, status = $2, authorization_revision = authorization_revision + 1,
             permission_overrides = '{"allow":[],"deny":[]}'::jsonb, updated_at = now()
         WHERE membership_id = $3 AND customer_id = $4
         RETURNING membership_id, identity_user_id, role_key, status, authorization_revision, updated_at`,
        [nextRole, nextStatus, membershipId, tenantId],
      );
      await this.audit.record({
        tenantId, identityUserId: principal.identityUserId,
        eventType: "membership.changed", permission: "users.roles.assign", outcome: "allowed",
        resourceType: "membership", resourceId: membershipId,
        metadata: { previousRole: current.role_key, nextRole, previousStatus: current.status, nextStatus },
      }, client);
      return updated.rows[0];
    });
  }

  async listInvitations(tenantId: string) {
    const schema = runtimeConfig().schema;
    const result = await this.database.tenantTransaction(tenantId, (client) => client.query(
      `SELECT invitation_id, recipient_email, role_key,
              CASE WHEN status = 'pending' AND expires_at <= now() THEN 'expired' ELSE status END AS status,
              revision, expires_at, redeemed_at, revoked_at, created_at, updated_at
       FROM ${schema}.admin_invitations WHERE customer_id = $1
       ORDER BY created_at DESC`,
      [tenantId],
    ));
    return { invitations: result.rows };
  }

  async issueInvitation(tenantId: string, principal: AdminPrincipal, input: unknown) {
    const parsed = parseInput(InvitationIssueSchema, input);
    const token = randomBytes(32).toString("base64url");
    const tokenHash = hashOpaque(token);
    const emailHash = hashEmail(parsed.email);
    const expiresAt = new Date(Date.now() + parsed.expiresInHours * 60 * 60 * 1_000);
    const schema = runtimeConfig().schema;
    return this.database.tenantTransaction(tenantId, async (client) => {
      await client.query(
        `UPDATE ${schema}.admin_invitations SET status = 'expired', revision = revision + 1, updated_at = now()
         WHERE customer_id = $1 AND recipient_email_hash = $2
           AND status = 'pending' AND expires_at <= now()`,
        [tenantId, emailHash],
      );
      const existing = await client.query(
        `SELECT 1 FROM ${schema}.admin_invitations
         WHERE customer_id = $1 AND recipient_email_hash = $2
           AND status = 'pending' AND expires_at > now()`,
        [tenantId, emailHash],
      );
      if (existing.rowCount) throw new ConflictException("An active invitation already exists for this recipient.");
      const result = await client.query<{ invitation_id: string; revision: number }>(
        `INSERT INTO ${schema}.admin_invitations (
           customer_id, recipient_email, recipient_email_hash, token_hash,
           role_key, invited_by_identity, expires_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING invitation_id, revision`,
        [tenantId, parsed.email, emailHash, tokenHash, parsed.role, principal.identityUserId, expiresAt],
      );
      await this.audit.record({
        tenantId, identityUserId: principal.identityUserId,
        eventType: "invitation.issued", permission: "users.invite", outcome: "allowed",
        resourceType: "invitation", resourceId: result.rows[0].invitation_id,
        metadata: { recipientEmailHash: emailHash, role: parsed.role, deliveryMode: parsed.deliveryMode, expiresAt: expiresAt.toISOString() },
      }, client);
      return {
        invitationId: result.rows[0].invitation_id,
        revision: result.rows[0].revision,
        expiresAt: expiresAt.toISOString(),
        delivery: { mode: "dry-run" as const, token },
      };
    });
  }

  async revokeInvitation(
    tenantId: string,
    invitationId: string,
    principal: AdminPrincipal,
    input: unknown,
  ) {
    const parsed = parseInput(RevisionCheckSchema, input);
    const schema = runtimeConfig().schema;
    return this.database.tenantTransaction(tenantId, async (client) => {
      const result = await client.query(
        `UPDATE ${schema}.admin_invitations
         SET status = 'revoked', revoked_at = now(), revision = revision + 1, updated_at = now()
         WHERE invitation_id = $1 AND customer_id = $2 AND status = 'pending' AND revision = $3
         RETURNING invitation_id, status, revision, revoked_at`,
        [invitationId, tenantId, parsed.expectedRevision],
      );
      if (result.rowCount !== 1) throw new ConflictException("Invitation is unavailable, already used, or changed.");
      await this.audit.record({
        tenantId, identityUserId: principal.identityUserId,
        eventType: "invitation.revoked", permission: "users.invite", outcome: "allowed",
        resourceType: "invitation", resourceId: invitationId,
      }, client);
      return result.rows[0];
    });
  }

  async redeemInvitation(identity: VerifiedBusinessManagerIdentity, input: unknown) {
    const parsed = parseInput(InvitationRedeemSchema, input);
    if (!identity.email) throw new ForbiddenException("A verified Business Manager email is required to redeem an invitation.");
    const identityEmail = identity.email;
    const tokenHash = hashOpaque(parsed.token);
    const schema = runtimeConfig().schema;
    const lookup = await this.database.query<{ customer_id: string }>(
      `SELECT customer_id FROM ${schema}.admin_invitations WHERE token_hash = $1`,
      [tokenHash],
    );
    if (lookup.rowCount !== 1) throw new ForbiddenException("Invitation is invalid or unavailable.");
    const tenantId = lookup.rows[0].customer_id;
    return this.database.tenantTransaction(tenantId, async (client) => {
      const invitation = await client.query<{
        invitation_id: string; recipient_email_hash: string; role_key: string; status: string;
        expires_at: Date; external_company_id: string;
      }>(
        `SELECT i.invitation_id, i.recipient_email_hash, i.role_key, i.status,
                i.expires_at, c.external_company_id
         FROM ${schema}.admin_invitations i
         JOIN ${schema}.customers c ON c.customer_id = i.customer_id
         WHERE i.token_hash = $1 AND i.customer_id = $2 FOR UPDATE OF i`,
        [tokenHash, tenantId],
      );
      const row = invitation.rows[0];
      if (!row || row.status !== "pending" || new Date(row.expires_at).getTime() <= Date.now()) {
        throw new ForbiddenException("Invitation is expired, revoked, or already redeemed.");
      }
      if (row.external_company_id !== identity.companyId) {
        throw new ForbiddenException("Invitation organisation does not match the authenticated identity.");
      }
      if (!safeHashEqual(row.recipient_email_hash, hashEmail(identityEmail))) {
        throw new ForbiddenException("Invitation recipient does not match the authenticated identity.");
      }
      const existing = await client.query(
        `SELECT 1 FROM ${schema}.admin_memberships WHERE customer_id = $1 AND identity_user_id = $2`,
        [tenantId, identity.userId],
      );
      if (existing.rowCount) throw new ConflictException("This identity already has an organisation membership.");
      const membership = await client.query<{ membership_id: string }>(
        `INSERT INTO ${schema}.admin_memberships (customer_id, identity_user_id, role_key)
         VALUES ($1, $2, $3) RETURNING membership_id`,
        [tenantId, identity.userId, row.role_key],
      );
      await client.query(
        `UPDATE ${schema}.admin_invitations
         SET status = 'redeemed', redeemed_by_identity = $1, redeemed_at = now(),
             revision = revision + 1, updated_at = now()
         WHERE invitation_id = $2`,
        [identity.userId, row.invitation_id],
      );
      await this.audit.record({
        tenantId, identityUserId: identity.userId,
        eventType: "invitation.redeemed", outcome: "allowed",
        resourceType: "membership", resourceId: membership.rows[0].membership_id,
        metadata: { invitationId: row.invitation_id, role: row.role_key },
      }, client);
      return { tenantId, membershipId: membership.rows[0].membership_id, role: row.role_key };
    });
  }

  permissionRegistry() {
    return {
      roles: Object.entries(ADMIN_ROLE_PERMISSIONS).map(([role, permissions]) => ({ role, permissions })),
      permissions: [...ADMIN_PERMISSIONS],
      mfaRequiredPermissions: [...MFA_REQUIRED_PERMISSIONS],
      platformPermissions: ["platform.organisations.provision", "platform.support.access"],
      customRolesSupported: false,
      permissionElevationOverridesSupported: false,
    };
  }

  private async setOrganisationAdmission(
    tenantId: string,
    principal: AdminPrincipal,
    expectedRevision: number,
    active: boolean,
    reason?: string,
  ) {
    const schema = runtimeConfig().schema;
    return this.database.tenantTransaction(tenantId, async (client) => {
      const result = await client.query(
        `UPDATE ${schema}.customers
         SET status = $1, admission_suspended_at = $2, suspension_reason = $3,
             settings_revision = settings_revision + 1, updated_at = now()
         WHERE customer_id = $4 AND settings_revision = $5
         RETURNING customer_id, status, settings_revision, admission_suspended_at, suspension_reason`,
        [active ? "active" : "inactive", active ? null : new Date(), active ? null : reason, tenantId, expectedRevision],
      );
      if (result.rowCount !== 1) throw new ConflictException("Organisation lifecycle changed; reload before saving.");
      await this.audit.record({
        tenantId, identityUserId: principal.identityUserId,
        eventType: active ? "organisation.resumed" : "organisation.suspended",
        permission: "organisation.suspend", outcome: "allowed",
        resourceType: "organisation", resourceId: tenantId,
        metadata: active ? {} : { reason },
      }, client);
      return result.rows[0];
    });
  }
}

function effectivePermissions(
  role: keyof typeof ADMIN_ROLE_PERMISSIONS,
  overrides: { allow?: unknown; deny?: unknown } | null,
): string[] {
  const denied = new Set(
    (Array.isArray(overrides?.deny) ? overrides.deny : [])
      .filter((value): value is string => typeof value === "string" && isAdminPermission(value)),
  );
  return ADMIN_ROLE_PERMISSIONS[role].filter((permission) => !denied.has(permission));
}

function hashEmail(value: string): string {
  return createHash("sha256").update(value.trim().toLowerCase()).digest("hex");
}

function hashOpaque(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function safeHashEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function parseInput<T>(schema: ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new BadRequestException({
      message: "The request body is invalid.",
      issues: result.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })),
    });
  }
  return result.data;
}
