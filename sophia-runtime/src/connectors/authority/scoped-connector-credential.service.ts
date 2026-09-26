import { createHmac, randomUUID } from "node:crypto";
import { Injectable } from "@nestjs/common";

export type ConnectorBindingAuthority = {
  connectorBindingId: string;
  tenantId: string;
  externalCompanyId: string;
  allowedScopes: string[];
};

@Injectable()
export class ScopedConnectorCredentialService {
  issue(binding: ConnectorBindingAuthority, requestedScopes: string[]): string {
    const secret = process.env.SOPHIA_CONNECTOR_SIGNING_SECRET?.trim();
    if (!secret || secret.length < 32) throw new Error("Scoped connector signing is not configured safely.");
    const scopes = [...new Set(requestedScopes)];
    if (!scopes.length || scopes.some((scope) => !binding.allowedScopes.includes(scope))) {
      throw new Error("Requested connector scope is not granted by the binding.");
    }
    const now = Math.floor(Date.now() / 1000);
    const header = encode({ alg: "HS256", typ: "JWT", kid: "sophia-connector-v1" });
    const payload = encode({
      iss: process.env.SOPHIA_CONNECTOR_ISSUER || "sophia-runtime",
      aud: process.env.SOPHIA_CONNECTOR_AUDIENCE || "business-manager",
      sub: "sophia-runtime",
      jti: randomUUID(),
      iat: now,
      exp: now + 120,
      tenantId: binding.tenantId,
      companyId: binding.externalCompanyId,
      connectorBindingId: binding.connectorBindingId,
      scopes,
    });
    const unsigned = `${header}.${payload}`;
    const signature = createHmac("sha256", secret).update(unsigned).digest("base64url");
    return `${unsigned}.${signature}`;
  }
}

function encode(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}
