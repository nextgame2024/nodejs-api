import { Injectable, UnauthorizedException } from "@nestjs/common";
import { runtimeConfig } from "../../config/runtime-config.js";

export type VerifiedBusinessManagerIdentity = {
  userId: string;
  companyId: string;
  status: string;
  email?: string;
  mfaVerifiedAt?: string;
};

@Injectable()
export class BusinessManagerIdentityBridge {
  async authenticate(authorization: string): Promise<VerifiedBusinessManagerIdentity> {
    if (!/^\s*(?:Bearer|Token)\s+\S+\s*$/i.test(authorization)) {
      throw new UnauthorizedException("A Business Manager access token is required.");
    }
    const response = await fetch(`${runtimeConfig().businessManager.apiUrl}/user`, {
      method: "GET",
      headers: { authorization, accept: "application/json" },
      signal: AbortSignal.timeout(5_000),
    }).catch(() => undefined);
    if (!response?.ok) {
      throw new UnauthorizedException("Business Manager identity could not be verified.");
    }
    const payload = await response.json() as { user?: Record<string, unknown> };
    const userId = String(payload.user?.["id"] ?? "");
    const companyId = String(payload.user?.["companyId"] ?? "");
    const status = String(payload.user?.["status"] ?? "");
    if (!userId || !companyId || status !== "active") {
      throw new UnauthorizedException("The Business Manager identity is not active and tenant-bound.");
    }
    const mfaVerifiedAt = payload.user?.["mfaVerifiedAt"];
    const email = payload.user?.["email"];
    return {
      userId,
      companyId,
      status,
      ...(typeof email === "string" && email.trim() ? { email: email.trim().toLowerCase() } : {}),
      ...(typeof mfaVerifiedAt === "string" ? { mfaVerifiedAt } : {}),
    };
  }
}
