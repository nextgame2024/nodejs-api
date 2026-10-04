import { z } from "zod";
import { ADMIN_PERMISSIONS, ADMIN_ROLE_PERMISSIONS } from "../permissions/admin-permissions.js";

export const ADMIN_API_VERSION = "1.0.0" as const;
export const AdminPermissionSchema = z.enum(ADMIN_PERMISSIONS);
export const AdminRoleKeySchema = z.enum(
  Object.keys(ADMIN_ROLE_PERMISSIONS) as [keyof typeof ADMIN_ROLE_PERMISSIONS, ...(keyof typeof ADMIN_ROLE_PERMISSIONS)[]],
);
export const AdminPrincipalRoleSchema = z.union([
  AdminRoleKeySchema,
  z.literal("platform_operator"),
]);

export const AdminPrincipalSchema = z.object({
  apiVersion: z.literal(ADMIN_API_VERSION),
  identityUserId: z.string().min(1).max(200),
  tenantId: z.string().uuid(),
  externalCompanyId: z.string().uuid(),
  membershipId: z.string().uuid(),
  role: AdminPrincipalRoleSchema,
  permissions: z.array(AdminPermissionSchema),
  authorizationRevision: z.number().int().positive(),
  authorityType: z.enum(["tenant", "platform"]).optional(),
  operatorCompanyId: z.string().uuid().optional(),
  mfaVerifiedAt: z.string().datetime({ offset: true }).optional(),
}).strict();

export type AdminPrincipal = z.infer<typeof AdminPrincipalSchema>;
