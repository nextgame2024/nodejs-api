import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common";
import type { PoolClient } from "pg";
import { runtimeConfig } from "../../config/runtime-config.js";
import { DatabaseService } from "../../database/database.service.js";
import {
  XeroClient,
  type XeroOrganisation,
  type XeroPage,
  type XeroContactRecord,
  type XeroInvoiceRecord,
  type XeroTokenSet,
} from "./xero.client.js";
import { XeroCryptoService } from "./xero-crypto.service.js";
import {
  XERO_CONNECTOR_KEY,
  XERO_READ_ONLY_SCOPES,
  XERO_STUDENT_DISCOVERY_SCOPES,
  xeroConfiguration,
  type XeroConfig,
} from "./xero.config.js";

const INTERNAL_READ_SCOPES = [
  "xero:organisation:read",
  "xero:accounts:read",
  "xero:invoices:read",
  "xero:contacts:read",
];

type TokenEnvelope = { accessToken: string; refreshToken: string };

type ConnectionRow = {
  xero_connection_id: string;
  xero_authorization_id: string;
  connector_binding_id: string;
  provider_connection_id: string;
  xero_tenant_id: string;
  tenant_name: string;
  tenant_type: string;
  tenant_short_code: string | null;
  status: string;
  last_tested_at: Date | null;
  last_error_code: string | null;
  health_status: string;
  granted_scopes: unknown;
  organisation_role: "trust" | "operating" | "unassigned" | null;
};

type AuthorizationRow = {
  token_ciphertext: string;
  token_expires_at: Date;
  revision: number;
  status: string;
};

@Injectable()
export class XeroConnectorService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(XeroClient) private readonly client: XeroClient,
    @Inject(XeroCryptoService) private readonly crypto: XeroCryptoService,
  ) {}

  async status(tenantId: string) {
    const configured = xeroConfiguration() !== null;
    const schema = runtimeConfig().schema;
    const result = await this.database.tenantReadTransaction(tenantId, (db) => db.query<ConnectionRow>(
      `SELECT x.xero_connection_id, x.xero_authorization_id, x.connector_binding_id,
              x.provider_connection_id, x.xero_tenant_id, x.tenant_name, x.tenant_type,
              x.tenant_short_code, x.status, x.last_tested_at, x.last_error_code,
              b.health_status, a.granted_scopes, c.organisation_role
         FROM ${schema}.xero_connections x
         JOIN ${schema}.connector_bindings b
           ON b.connector_binding_id=x.connector_binding_id AND b.customer_id=x.customer_id
         JOIN ${schema}.xero_authorizations a
           ON a.xero_authorization_id=x.xero_authorization_id AND a.customer_id=x.customer_id
         LEFT JOIN ${schema}.student_operations_xero_sync_configurations c
           ON c.xero_connection_id=x.xero_connection_id AND c.customer_id=x.customer_id
        WHERE x.customer_id=$1
        ORDER BY lower(x.tenant_name), x.created_at`,
      [tenantId],
    ));
    return {
      provider: "xero",
      configured,
      mode: "read_only",
      requestedScopes: [...XERO_READ_ONLY_SCOPES],
      connections: result.rows.map((row) => ({
        connectionId: row.xero_connection_id,
        tenantId: row.xero_tenant_id,
        tenantName: row.tenant_name,
        tenantType: row.tenant_type,
        tenantShortCode: row.tenant_short_code,
        status: row.status,
        healthStatus: row.health_status,
        lastTestedAt: row.last_tested_at?.toISOString() ?? null,
        lastErrorCode: row.last_error_code,
        organisationRole: row.organisation_role,
        missingStudentDiscoveryScopes: missingScopes(row.granted_scopes, XERO_STUDENT_DISCOVERY_SCOPES),
      })),
    };
  }

  async beginAuthorization(tenantId: string, identityUserId: string) {
    const config = requiredConfig();
    const verifier = randomBytes(48).toString("base64url");
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const state = this.crypto.signState({
      tenantId,
      identityUserId,
      nonce: randomBytes(32).toString("base64url"),
      issuedAt: Date.now(),
    }, config);
    const schema = runtimeConfig().schema;
    await this.database.tenantTransaction(tenantId, (db) => db.query(
      `INSERT INTO ${schema}.xero_oauth_states
         (state_digest, customer_id, identity_user_id, pkce_verifier_ciphertext, expires_at)
       VALUES ($1, $2, $3, $4, now() + interval '10 minutes')`,
      [this.crypto.digest(state), tenantId, identityUserId, this.crypto.seal(verifier, config)],
    ));
    const url = new URL("https://login.xero.com/identity/connect/authorize");
    url.search = new URLSearchParams({
      response_type: "code",
      client_id: config.clientId,
      redirect_uri: config.redirectUri,
      scope: XERO_READ_ONLY_SCOPES.join(" "),
      state,
      code_challenge: challenge,
      code_challenge_method: "S256",
    }).toString();
    return { authorizationUrl: url.toString(), expiresInSeconds: 600 };
  }

  async completeAuthorization(code: string, state: string): Promise<{ returnUrl: string; connectionCount: number }> {
    if (!code || code.length > 2_000 || !state || state.length > 4_000) {
      throw new BadRequestException("Xero authorization response is invalid.");
    }
    const config = requiredConfig();
    const payload = this.crypto.verifyState(state, config);
    const verifier = await this.consumeState(payload.tenantId, payload.identityUserId, state, config);
    const token = await this.client.exchangeCode(code, verifier, config);
    const providerConnections = await this.client.connections(token.accessToken);
    const organisationConnections = providerConnections.filter((entry) => entry.tenantType === "ORGANISATION");
    if (!organisationConnections.length) {
      throw new BadGatewayException("No Xero accounting organisation was authorized.");
    }

    const verified: Array<{ provider: typeof organisationConnections[number]; organisation: XeroOrganisation }> = [];
    for (const provider of organisationConnections) {
      verified.push({ provider, organisation: await this.client.organisation(token.accessToken, provider.tenantId) });
    }
    await this.persistAuthorization(payload.tenantId, payload.identityUserId, token, verified, config);
    return { returnUrl: appendOutcome(config.returnUrl, "connected"), connectionCount: verified.length };
  }

  cancelledReturnUrl(): string {
    return appendOutcome(requiredConfig().returnUrl, "cancelled");
  }

  failedReturnUrl(): string {
    const config = xeroConfiguration();
    return config ? appendOutcome(config.returnUrl, "failed") : "/";
  }

  async testConnection(tenantId: string, identityUserId: string, connectionId: string) {
    if (!/^[0-9a-f-]{36}$/i.test(connectionId)) throw new NotFoundException("Xero connection not found.");
    const config = requiredConfig();
    const connection = await this.loadConnection(tenantId, connectionId);
    try {
      const accessToken = await this.accessToken(tenantId, connection.xero_authorization_id, config);
      const [organisation, bankAccounts] = await Promise.all([
        this.client.organisation(accessToken, connection.xero_tenant_id),
        this.client.bankAccounts(accessToken, connection.xero_tenant_id),
      ]);
      await this.recordTest(tenantId, identityUserId, connection, "healthy", null);
      return {
        connectionId,
        verifiedAt: new Date().toISOString(),
        organisation,
        bankAccounts,
      };
    } catch (error) {
      await this.recordTest(tenantId, identityUserId, connection, "unhealthy", "xero_verification_failed");
      throw error;
    }
  }

  async discoverStudentCandidates(tenantId: string, connectionId: string) {
    if (!/^[0-9a-f-]{36}$/i.test(connectionId)) throw new NotFoundException("Xero connection not found.");
    const config = requiredConfig();
    const connection = await this.loadConnection(tenantId, connectionId);
    const missing = missingScopes(connection.granted_scopes, XERO_STUDENT_DISCOVERY_SCOPES);
    if (missing.length) {
      throw new ConflictException("Reconnect Xero to allow read-only invoice and contact access.");
    }
    const accessToken = await this.accessToken(tenantId, connection.xero_authorization_id, config);
    const result = await this.client.studentCandidates(accessToken, connection.xero_tenant_id);
    return {
      connection: {
        connectionId: connection.xero_connection_id,
        tenantName: connection.tenant_name,
      },
      generatedAt: new Date().toISOString(),
      ...result,
    };
  }

  async syncContactPage(
    tenantId: string,
    connectionId: string,
    page: number,
    modifiedSince?: Date,
  ): Promise<XeroPage<XeroContactRecord>> {
    const { connection, accessToken } = await this.syncAccess(tenantId, connectionId);
    return this.client.contactPage(accessToken, connection.xero_tenant_id, page, modifiedSince);
  }

  async syncInvoicePage(
    tenantId: string,
    connectionId: string,
    page: number,
    modifiedSince?: Date,
    registerOnly = false,
  ): Promise<XeroPage<XeroInvoiceRecord>> {
    const { connection, accessToken } = await this.syncAccess(tenantId, connectionId);
    return this.client.invoicePage(
      accessToken,
      connection.xero_tenant_id,
      page,
      modifiedSince,
      registerOnly,
    );
  }

  async syncCreditNotePage(
    tenantId: string,
    connectionId: string,
    page: number,
    modifiedSince?: Date,
  ): Promise<XeroPage<XeroInvoiceRecord>> {
    const { connection, accessToken } = await this.syncAccess(tenantId, connectionId);
    return this.client.creditNotePage(
      accessToken,
      connection.xero_tenant_id,
      page,
      modifiedSince,
    );
  }

  async syncPrepaymentPage(
    tenantId: string,
    connectionId: string,
    page: number,
    modifiedSince?: Date,
  ): Promise<XeroPage<XeroInvoiceRecord>> {
    const { connection, accessToken } = await this.syncAccess(tenantId, connectionId);
    return this.client.prepaymentPage(accessToken, connection.xero_tenant_id, page, modifiedSince);
  }

  async syncOverpaymentPage(
    tenantId: string,
    connectionId: string,
    page: number,
    modifiedSince?: Date,
  ): Promise<XeroPage<XeroInvoiceRecord>> {
    const { connection, accessToken } = await this.syncAccess(tenantId, connectionId);
    return this.client.overpaymentPage(accessToken, connection.xero_tenant_id, page, modifiedSince);
  }

  private async syncAccess(tenantId: string, connectionId: string) {
    if (!/^[0-9a-f-]{36}$/i.test(connectionId)) throw new NotFoundException("Xero connection not found.");
    const config = requiredConfig();
    const connection = await this.loadConnection(tenantId, connectionId);
    const missing = missingScopes(connection.granted_scopes, XERO_STUDENT_DISCOVERY_SCOPES);
    if (missing.length) {
      throw new ConflictException("Reconnect Xero to allow read-only invoice and contact access.");
    }
    const accessToken = await this.accessToken(tenantId, connection.xero_authorization_id, config);
    return { connection, accessToken };
  }

  private async consumeState(
    tenantId: string,
    identityUserId: string,
    state: string,
    config: XeroConfig,
  ): Promise<string> {
    const schema = runtimeConfig().schema;
    return this.database.tenantTransaction(tenantId, async (db) => {
      const result = await db.query<{ pkce_verifier_ciphertext: string }>(
        `UPDATE ${schema}.xero_oauth_states
            SET consumed_at=now()
          WHERE state_digest=$1 AND customer_id=$2 AND identity_user_id=$3
            AND consumed_at IS NULL AND expires_at>now()
        RETURNING pkce_verifier_ciphertext`,
        [this.crypto.digest(state), tenantId, identityUserId],
      );
      const row = result.rows[0];
      if (!row) throw new BadRequestException("Xero authorization state is expired or was already used.");
      return this.crypto.open(row.pkce_verifier_ciphertext, config);
    });
  }

  private async persistAuthorization(
    tenantId: string,
    identityUserId: string,
    token: XeroTokenSet,
    connections: Array<{
      provider: { id: string; tenantId: string; tenantType: string; tenantName: string };
      organisation: XeroOrganisation;
    }>,
    config: XeroConfig,
  ): Promise<void> {
    const schema = runtimeConfig().schema;
    const tokenCiphertext = this.crypto.seal(JSON.stringify({
      accessToken: token.accessToken,
      refreshToken: token.refreshToken,
    } satisfies TokenEnvelope), config);
    await this.database.tenantTransaction(tenantId, async (db) => {
      const authorization = await db.query<{ xero_authorization_id: string }>(
        `INSERT INTO ${schema}.xero_authorizations
           (customer_id, token_ciphertext, token_expires_at, granted_scopes, authorized_by_identity)
         VALUES ($1, $2, now() + ($3 * interval '1 second'), $4::jsonb, $5)
         RETURNING xero_authorization_id`,
        [tenantId, tokenCiphertext, token.expiresIn, JSON.stringify(token.scopes), identityUserId],
      );
      const authorizationId = authorization.rows[0]?.xero_authorization_id;
      if (!authorizationId) throw new Error("Xero authorization could not be persisted.");

      for (const connection of connections) {
        const existing = await db.query<Pick<ConnectionRow, "xero_connection_id" | "connector_binding_id">>(
          `SELECT xero_connection_id, connector_binding_id
             FROM ${schema}.xero_connections
            WHERE customer_id=$1 AND xero_tenant_id=$2
            FOR UPDATE`,
          [tenantId, connection.provider.tenantId],
        );
        const row = existing.rows[0];
        if (row) {
          await db.query(
            `UPDATE ${schema}.xero_connections
                SET xero_authorization_id=$3, provider_connection_id=$4,
                    tenant_name=$5, tenant_type=$6, tenant_short_code=$7,
                    status='active', last_error_code=NULL, updated_at=now()
              WHERE customer_id=$1 AND xero_connection_id=$2`,
            [tenantId, row.xero_connection_id, authorizationId, connection.provider.id,
              connection.organisation.name, connection.provider.tenantType,
              connection.organisation.shortCode],
          );
          await db.query(
            `UPDATE ${schema}.connector_bindings
                SET credential_ref=$3, status='active', health_status='unknown',
                    allowed_scopes=$4::jsonb, last_error_code=NULL,
                    revision=revision+1, updated_at=now()
              WHERE customer_id=$1 AND connector_binding_id=$2`,
            [tenantId, row.connector_binding_id, `xero-authorization://${authorizationId}`,
              JSON.stringify(INTERNAL_READ_SCOPES)],
          );
          await this.bindingEvent(db, schema, tenantId, row.connector_binding_id,
            identityUserId, "reconnected", "active");
          continue;
        }

        const binding = await db.query<{ connector_binding_id: string }>(
          `INSERT INTO ${schema}.connector_bindings
             (customer_id, connector_key, external_account_id, credential_ref,
              allowed_scopes, status, health_status)
           VALUES ($1, $2, $3, $4, $5::jsonb, 'active', 'unknown')
           RETURNING connector_binding_id`,
          [tenantId, XERO_CONNECTOR_KEY, connection.provider.tenantId,
            `xero-authorization://${authorizationId}`, JSON.stringify(INTERNAL_READ_SCOPES)],
        );
        const bindingId = binding.rows[0]?.connector_binding_id;
        if (!bindingId) throw new Error("Xero connector binding could not be persisted.");
        await db.query(
          `INSERT INTO ${schema}.xero_connections
             (customer_id, xero_authorization_id, connector_binding_id,
              provider_connection_id, xero_tenant_id, tenant_name, tenant_type, tenant_short_code)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [tenantId, authorizationId, bindingId, connection.provider.id,
            connection.provider.tenantId, connection.organisation.name,
            connection.provider.tenantType, connection.organisation.shortCode],
        );
        await this.bindingEvent(db, schema, tenantId, bindingId, identityUserId, "connected", "active");
      }
    });
  }

  private async loadConnection(tenantId: string, connectionId: string): Promise<ConnectionRow> {
    const schema = runtimeConfig().schema;
    const result = await this.database.tenantReadTransaction(tenantId, (db) => db.query<ConnectionRow>(
      `SELECT x.xero_connection_id, x.xero_authorization_id, x.connector_binding_id,
              x.provider_connection_id, x.xero_tenant_id, x.tenant_name, x.tenant_type,
              x.tenant_short_code, x.status, x.last_tested_at, x.last_error_code,
              b.health_status, a.granted_scopes
         FROM ${schema}.xero_connections x
         JOIN ${schema}.connector_bindings b
           ON b.connector_binding_id=x.connector_binding_id AND b.customer_id=x.customer_id
         JOIN ${schema}.xero_authorizations a
           ON a.xero_authorization_id=x.xero_authorization_id AND a.customer_id=x.customer_id
        WHERE x.customer_id=$1 AND x.xero_connection_id=$2
        LIMIT 1`,
      [tenantId, connectionId],
    ));
    const row = result.rows[0];
    if (!row || row.status === "revoked") throw new NotFoundException("Xero connection not found.");
    return row;
  }

  private async accessToken(tenantId: string, authorizationId: string, config: XeroConfig): Promise<string> {
    const schema = runtimeConfig().schema;
    return this.database.tenantTransaction(tenantId, async (db) => {
      const result = await db.query<AuthorizationRow>(
        `SELECT token_ciphertext, token_expires_at, revision, status
           FROM ${schema}.xero_authorizations
          WHERE customer_id=$1 AND xero_authorization_id=$2
          FOR UPDATE`,
        [tenantId, authorizationId],
      );
      const row = result.rows[0];
      if (!row || row.status !== "active") throw new ServiceUnavailableException("Xero authorization must be updated.");
      const envelope = parseTokenEnvelope(this.crypto.open(row.token_ciphertext, config));
      if (row.token_expires_at.getTime() > Date.now() + 120_000) return envelope.accessToken;

      const refreshed = await this.client.refresh(envelope.refreshToken, config);
      const encrypted = this.crypto.seal(JSON.stringify({
        accessToken: refreshed.accessToken,
        refreshToken: refreshed.refreshToken,
      } satisfies TokenEnvelope), config);
      await db.query(
        `UPDATE ${schema}.xero_authorizations
            SET token_ciphertext=$3, token_expires_at=now() + ($4 * interval '1 second'),
                granted_scopes=$5::jsonb, revision=revision+1, updated_at=now()
          WHERE customer_id=$1 AND xero_authorization_id=$2`,
        [tenantId, authorizationId, encrypted, refreshed.expiresIn, JSON.stringify(refreshed.scopes)],
      );
      return refreshed.accessToken;
    });
  }

  private async recordTest(
    tenantId: string,
    identityUserId: string,
    connection: ConnectionRow,
    health: "healthy" | "unhealthy",
    errorCode: string | null,
  ): Promise<void> {
    const schema = runtimeConfig().schema;
    await this.database.tenantTransaction(tenantId, async (db) => {
      await db.query(
        `UPDATE ${schema}.xero_connections
            SET status=$3, last_tested_at=now(), last_error_code=$4, updated_at=now()
          WHERE customer_id=$1 AND xero_connection_id=$2`,
        [tenantId, connection.xero_connection_id, health === "healthy" ? "active" : "degraded", errorCode],
      );
      await db.query(
        `UPDATE ${schema}.connector_bindings
            SET health_status=$3, health_checked_at=now(), last_error_code=$4, updated_at=now()
          WHERE customer_id=$1 AND connector_binding_id=$2`,
        [tenantId, connection.connector_binding_id, health, errorCode],
      );
      await this.bindingEvent(db, schema, tenantId, connection.connector_binding_id,
        identityUserId, "tested", health);
    });
  }

  private async bindingEvent(
    db: PoolClient,
    schema: string,
    tenantId: string,
    bindingId: string,
    identityUserId: string,
    eventType: "connected" | "reconnected" | "tested",
    status: string,
  ): Promise<void> {
    await db.query(
      `INSERT INTO ${schema}.connector_binding_events
         (connector_binding_event_id, customer_id, connector_binding_id,
          event_type, status, created_by_identity)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [randomUUID(), tenantId, bindingId, eventType, status, identityUserId],
    );
  }
}

function requiredConfig(): XeroConfig {
  const config = xeroConfiguration();
  if (!config) throw new ServiceUnavailableException("Xero integration is not configured on the server.");
  return config;
}

function parseTokenEnvelope(value: string): TokenEnvelope {
  let parsed: unknown;
  try { parsed = JSON.parse(value); }
  catch { throw new Error("Stored Xero authorization is unreadable."); }
  if (!parsed || typeof parsed !== "object") throw new Error("Stored Xero authorization is invalid.");
  const envelope = parsed as Partial<TokenEnvelope>;
  if (typeof envelope.accessToken !== "string" || typeof envelope.refreshToken !== "string") {
    throw new Error("Stored Xero authorization is invalid.");
  }
  return { accessToken: envelope.accessToken, refreshToken: envelope.refreshToken };
}

function appendOutcome(returnUrl: string, outcome: "connected" | "cancelled" | "failed"): string {
  const url = new URL(returnUrl);
  url.searchParams.set("xero", outcome);
  return url.toString();
}

function missingScopes(granted: unknown, required: readonly string[]): string[] {
  const values = Array.isArray(granted)
    ? granted.filter((value): value is string => typeof value === "string")
    : [];
  const present = new Set(values);
  return required.filter((scope) => !present.has(scope));
}
