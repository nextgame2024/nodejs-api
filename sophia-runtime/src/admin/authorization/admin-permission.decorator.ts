import { SetMetadata } from "@nestjs/common";
import type { AdminPermission } from "../permissions/admin-permissions.js";

export const ADMIN_PERMISSIONS_METADATA = "sophia.admin.permissions";

export const RequireAdminPermissions = (...permissions: AdminPermission[]) =>
  SetMetadata(ADMIN_PERMISSIONS_METADATA, permissions);
