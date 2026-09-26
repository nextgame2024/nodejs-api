import { CallHandler, ExecutionContext, Inject, Injectable, NestInterceptor } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { catchError, from, map, mergeMap, Observable, of, throwError } from "rxjs";
import { randomUUID } from "node:crypto";
import { ADMIN_PERMISSIONS_METADATA } from "./admin-permission.decorator.js";
import type { AdminPermission } from "../permissions/admin-permissions.js";
import type { AdminPrincipal } from "../contracts/admin-contracts.js";
import { AdminAuditService } from "./admin-audit.service.js";

type Request = {
  method?: string; route?: { path?: string }; params?: Record<string, string | undefined>;
  headers?: Record<string, string | string[] | undefined>; adminPrincipal?: AdminPrincipal;
};

@Injectable()
export class AdminAuditInterceptor implements NestInterceptor {
  constructor(private readonly reflector: Reflector, @Inject(AdminAuditService) private readonly audit: AdminAuditService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context.switchToHttp().getRequest<Request>();
    const principal = request.adminPrincipal;
    if (!principal) return next.handle();
    const required = this.reflector.getAllAndOverride<AdminPermission[]>(ADMIN_PERMISSIONS_METADATA,
      [context.getHandler(), context.getClass()]) ?? [];
    const correlationId = validCorrelation(header(request, "x-correlation-id")) ?? randomUUID();
    const metadata = {
      method: request.method ?? "UNKNOWN",
      route: request.route?.path ?? "admin-route",
      requiredPermissions: required,
    };
    const resource = resourceTarget(request.params ?? {});
    return next.handle().pipe(
      mergeMap((value) => from(this.audit.record({
        tenantId: principal.tenantId, identityUserId: principal.identityUserId,
        eventType: "admin.request.allowed", permission: required[0], outcome: "allowed", correlationId,
        ...resource, metadata,
      })).pipe(catchError(() => of(undefined)), map(() => value))),
      catchError((error: unknown) => from(this.audit.record({
        tenantId: principal.tenantId, identityUserId: principal.identityUserId,
        eventType: "admin.request.failed", permission: required[0], outcome: "failed", correlationId,
        ...resource, metadata: { ...metadata, errorType: safeErrorType(error) },
      })).pipe(catchError(() => of(undefined)), mergeMap(() => throwError(() => error)))),
    );
  }
}

function header(request: Request, name: string): string | undefined {
  const value = request.headers?.[name]; return Array.isArray(value) ? value[0] : value;
}
function validCorrelation(value: string | undefined): string | undefined {
  return value && /^[a-zA-Z0-9._:-]{1,160}$/.test(value) ? value : undefined;
}
function resourceTarget(params: Record<string, string | undefined>) {
  const entry = Object.entries(params).find(([key, value]) => key !== "tenantId" && Boolean(value));
  return entry ? { resourceType: entry[0].replace(/Id$/, ""), resourceId: entry[1] } : {};
}
function safeErrorType(error: unknown): string {
  if (!error || typeof error !== "object") return "Error";
  const name = (error as { name?: unknown }).name; return typeof name === "string" ? name.slice(0, 120) : "Error";
}
