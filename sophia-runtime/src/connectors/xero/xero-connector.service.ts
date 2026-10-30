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
  type XeroAttachmentSource,
} from "./xero.client.js";
import { XeroCryptoService } from "./xero-crypto.service.js";
import { XeroSharedBackoff } from './xero-rate-limit.js';
import type { XeroRequestKind } from './xero-quota-admission.js';
import {
  XERO_CONNECTOR_KEY,
  xeroRequestedScopes,
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
      requestedScopes: [...xeroRequestedScopes()],
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
        missingAttachmentScopes: missingScopes(row.granted_scopes, ['accounting.attachments']).length ? missingScopes(row.granted_scopes, ['accounting.attachments.read']) : [],
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
      scope: xeroRequestedScopes().join(" "),
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
      const [organisation, bankAccounts] = await this.providerRequest(tenantId, connectionId, async () => {
        // Establish an unknown allowance with the first real operation before
        // admitting the second verification request. No synthetic quota probe.
        if(process.env.XERO_SHARED_QUOTA_ENABLED==='true') {
          const organisation=await this.client.organisation(accessToken,connection.xero_tenant_id);
          return [organisation,await this.client.bankAccounts(accessToken,connection.xero_tenant_id)] as const;
        }
        return Promise.all([
          this.client.organisation(accessToken, connection.xero_tenant_id),
          this.client.bankAccounts(accessToken, connection.xero_tenant_id),
        ]);
      });
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
      throw new ConflictException({
        errorCode: "xero_authorization_rejected",
        message: "Reconnect Xero to allow read-only invoice, payment and contact access.",
      });
    }
    const accessToken = await this.accessToken(tenantId, connection.xero_authorization_id, config);
    const result = await this.providerRequest(tenantId, connectionId, () => this.client.studentCandidates(accessToken, connection.xero_tenant_id));
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
    return this.providerRequest(tenantId, connectionId, () => this.client.contactPage(accessToken, connection.xero_tenant_id, page, modifiedSince));
  }

  async salesCatalogue(tenantId:string,connectionId:string){
    const connection=await this.loadConnection(tenantId,connectionId);
    if(missingScopes(connection.granted_scopes,['accounting.settings.read']).length&&missingScopes(connection.granted_scopes,['accounting.settings']).length)
      throw new ConflictException({errorCode:'xero_authorization_rejected',message:'Sales catalogue access requires read-only settings permission.'});
    const accessToken=await this.accessToken(tenantId,connection.xero_authorization_id,requiredConfig());
    return this.providerRequest(tenantId,connectionId,()=>this.client.salesCatalogue(accessToken,connection.xero_tenant_id),'discovery');
  }

  async syncInvoicePage(
    tenantId: string,
    connectionId: string,
    page: number,
    modifiedSince?: Date,
    registerOnly = false,
  ): Promise<XeroPage<XeroInvoiceRecord>> {
    const { connection, accessToken } = await this.syncAccess(tenantId, connectionId);
    return this.providerRequest(tenantId, connectionId, () => this.client.invoicePage(
      accessToken,
      connection.xero_tenant_id,
      page,
      modifiedSince,
      registerOnly,
    ));
  }

  async syncCreditNotePage(
    tenantId: string,
    connectionId: string,
    page: number,
    modifiedSince?: Date,
  ): Promise<XeroPage<XeroInvoiceRecord>> {
    const { connection, accessToken } = await this.syncAccess(tenantId, connectionId);
    return this.providerRequest(tenantId, connectionId, () => this.client.creditNotePage(
      accessToken,
      connection.xero_tenant_id,
      page,
      modifiedSince,
    ));
  }

  async syncPrepaymentPage(
    tenantId: string,
    connectionId: string,
    page: number,
    modifiedSince?: Date,
  ): Promise<XeroPage<XeroInvoiceRecord>> {
    const { connection, accessToken } = await this.syncAccess(tenantId, connectionId);
    return this.providerRequest(tenantId, connectionId, () => this.client.prepaymentPage(accessToken, connection.xero_tenant_id, page, modifiedSince));
  }

  async syncOverpaymentPage(
    tenantId: string,
    connectionId: string,
    page: number,
    modifiedSince?: Date,
  ): Promise<XeroPage<XeroInvoiceRecord>> {
    const { connection, accessToken } = await this.syncAccess(tenantId, connectionId);
    return this.providerRequest(tenantId, connectionId, () => this.client.overpaymentPage(accessToken, connection.xero_tenant_id, page, modifiedSince));
  }

  private async syncAccess(tenantId: string, connectionId: string) {
    if (!/^[0-9a-f-]{36}$/i.test(connectionId)) throw new NotFoundException("Xero connection not found.");
    const config = requiredConfig();
    const connection = await this.loadConnection(tenantId, connectionId);
    const missing = missingScopes(connection.granted_scopes, XERO_STUDENT_DISCOVERY_SCOPES);
    if (missing.length) {
      throw new ConflictException({
        errorCode: "xero_authorization_rejected",
        message: "Reconnect Xero to allow read-only invoice, payment and contact access.",
      });
    }
    const accessToken = await this.accessToken(tenantId, connection.xero_authorization_id, config);
    return { connection, accessToken };
  }

  private async attachmentAccess(tenantId: string, connectionId: string) {
    const config = requiredConfig();
    const connection = await this.loadConnection(tenantId, connectionId);
    if (missingScopes(connection.granted_scopes, ['accounting.attachments.read']).length && missingScopes(connection.granted_scopes, ['accounting.attachments']).length) {
      throw new ConflictException({ errorCode: 'xero_attachment_scope_missing', message: 'An integration administrator must reconnect Xero with read-only attachment access.' });
    }
    const accessToken = await this.accessToken(tenantId,connection.xero_authorization_id,config);
    return {connection,accessToken};
  }

  async attachments(tenantId: string, connectionId: string, source: XeroAttachmentSource, sourceId: string) {
    const {connection,accessToken}=await this.attachmentAccess(tenantId,connectionId);
    return this.providerRequest(tenantId, connectionId, () => this.client.attachments(accessToken,connection.xero_tenant_id,source,sourceId),'discovery');
  }

  async attachmentContent(tenantId: string, connectionId: string, source: XeroAttachmentSource, sourceId: string, attachmentId: string) {
    const {connection,accessToken}=await this.attachmentAccess(tenantId,connectionId);
    return this.providerRequest(tenantId, connectionId, () => this.client.attachmentContent(accessToken,connection.xero_tenant_id,source,sourceId,attachmentId));
  }

  async documentContactAttachments(tenantId:string,connectionId:string,contactId:string) {
    if(process.env.XERO_ATTACHMENT_UPLOAD_ENABLED!=='true') throw new ConflictException({errorCode:'xero_attachment_upload_disabled',message:'An administrator must enable document storage.'});
    const config=requiredConfig(),connection=await this.loadConnection(tenantId,connectionId);
    if(missingScopes(connection.granted_scopes,['accounting.attachments']).length) throw new ConflictException({errorCode:'xero_attachment_write_scope_missing',message:'An administrator must authorize document storage.'});
    const accessToken=await this.accessToken(tenantId,connection.xero_authorization_id,config);
    return this.providerRequest(tenantId,connectionId,()=>this.client.attachments(accessToken,connection.xero_tenant_id,'Contacts',contactId));
  }

  async uploadAttachment(tenantId:string,connectionId:string,source:XeroAttachmentSource,sourceId:string,fileName:string,mimeType:string,buffer:Buffer,key:string,beforeWrite?:()=>Promise<void>) {
    if(source!=='Contacts') throw new BadRequestException('Documents must be uploaded to the student Contact.');
    if(process.env.XERO_ATTACHMENT_UPLOAD_ENABLED!=='true') throw new ConflictException({errorCode:'xero_attachment_upload_disabled',message:'An integration administrator must enable Xero Contact uploads.'});
    const config=requiredConfig();
    const connection=await this.loadConnection(tenantId,connectionId);
    if(missingScopes(connection.granted_scopes,['accounting.attachments']).length) throw new ConflictException({errorCode:'xero_attachment_write_scope_missing',message:'An integration administrator must authorize Xero attachment uploads from company integrations.'});
    const accessToken=await this.accessToken(tenantId,connection.xero_authorization_id,config);
    return this.providerRequest(tenantId,connectionId,async()=>{
      // Xero's ten-file limit is per Contact, not per Sophia case. This read is
      // part of an explicit mutation and uses operational quota, not discovery.
      const files=await this.client.attachments(accessToken,connection.xero_tenant_id,'Contacts',sourceId);
      const existing=files.find(file=>file.fileName===fileName);
      if(existing) {
        // Recover an uncertain write by its durable filename AND byte hash,
        // rather than relying on Xero's expiring idempotency cache or overwriting.
        const content=await this.client.attachmentContent(accessToken,connection.xero_tenant_id,'Contacts',sourceId,existing.attachmentId);
        if(existing.sizeBytes!==buffer.length || !createHash('sha256').update(content).digest().equals(createHash('sha256').update(buffer).digest()))
          throw new ConflictException({errorCode:'student_document_storage_review_required',message:'The stored document changed. Contact your administrator.'});
        return existing;
      }
      if(files.length>=10)
        throw new ConflictException({errorCode:'student_document_storage_full',message:'Document storage is full. Contact your administrator.'});
      return this.client.uploadAttachment(accessToken,connection.xero_tenant_id,source,sourceId,fileName,mimeType,buffer,key,beforeWrite);
    });
  }

  async replaceAttachment(tenantId:string,connectionId:string,source:XeroAttachmentSource,sourceId:string,fileName:string,mimeType:string,buffer:Buffer,key:string) {
    const connection=await this.loadConnection(tenantId,connectionId);
    if(missingScopes(connection.granted_scopes,['accounting.attachments']).length)
      throw new ConflictException({errorCode:'xero_attachment_write_scope_missing',message:'An integration administrator must authorize Xero attachment updates from company integrations.'});
    const accessToken=await this.accessToken(tenantId,connection.xero_authorization_id,requiredConfig());
    return this.providerRequest(tenantId,connectionId,()=>this.client.replaceAttachment(accessToken,connection.xero_tenant_id,source,sourceId,fileName,mimeType,buffer,key));
  }

  private async filesAccess(tenantId:string,connectionId:string,write=false) {
    const connection=await this.loadConnection(tenantId,connectionId);
    const accepted=write?['files']:['files.read'];
    if(missingScopes(connection.granted_scopes,accepted).length&&(write||missingScopes(connection.granted_scopes,['files']).length))
      throw new ConflictException({errorCode:write?'xero_files_write_scope_missing':'xero_files_read_scope_missing',message:'An administrator must reconnect Xero and authorize document files.'});
    const accessToken=await this.accessToken(tenantId,connection.xero_authorization_id,requiredConfig());return {connection,accessToken};
  }

  async uploadFile(tenantId:string,connectionId:string,fileName:string,mimeType:string,buffer:Buffer,key:string) {
    if(process.env.XERO_FILES_DOCUMENT_STORAGE_ENABLED!=='true')throw new ConflictException({errorCode:'xero_files_storage_disabled',message:'An administrator must enable Xero Files document storage.'});
    const {connection,accessToken}=await this.filesAccess(tenantId,connectionId,true);
    return this.providerRequest(tenantId,connectionId,()=>this.client.uploadFile(accessToken,connection.xero_tenant_id,fileName,mimeType,buffer,key));
  }

  async associateFileWithContact(tenantId:string,connectionId:string,fileId:string,contactId:string,key:string) {
    const {connection,accessToken}=await this.filesAccess(tenantId,connectionId,true);
    return this.providerRequest(tenantId,connectionId,()=>this.client.associateFileWithContact(accessToken,connection.xero_tenant_id,fileId,contactId,key));
  }

  async fileContent(tenantId:string,connectionId:string,fileId:string) {
    const {connection,accessToken}=await this.filesAccess(tenantId,connectionId);
    return this.providerRequest(tenantId,connectionId,()=>this.client.fileContent(accessToken,connection.xero_tenant_id,fileId));
  }

  async deleteFile(tenantId:string,connectionId:string,fileId:string) {
    const {connection,accessToken}=await this.filesAccess(tenantId,connectionId,true);
    return this.providerRequest(tenantId,connectionId,()=>this.client.deleteFile(accessToken,connection.xero_tenant_id,fileId));
  }

  async contactById(tenantId:string,connectionId:string,contactId:string) {
    const connection=await this.loadConnection(tenantId,connectionId);
    if(missingScopes(connection.granted_scopes,['accounting.contacts']).length&&missingScopes(connection.granted_scopes,['accounting.contacts.read']).length)
      throw new ConflictException({errorCode:'xero_contact_read_scope_missing',message:'An administrator must authorize Xero contact access in company integrations.'});
    const accessToken=await this.accessToken(tenantId,connection.xero_authorization_id,requiredConfig());
    return this.providerRequest(tenantId,connectionId,()=>this.client.contactById(accessToken,connection.xero_tenant_id,contactId));
  }

  async ensureStudentContact(tenantId:string,connectionId:string,value:{contactNumber:string;name:string;email:string|null},key:string) {
    if(process.env.XERO_CONTACT_CREATION_ENABLED!=='true' || (process.env.XERO_ATTACHMENT_UPLOAD_ENABLED!=='true'&&process.env.XERO_FILES_DOCUMENT_STORAGE_ENABLED!=='true'))
      throw new ConflictException({errorCode:'student_document_setup_required',message:'An administrator must enable student document storage in company integrations.'});
    const config=requiredConfig(),connection=await this.loadConnection(tenantId,connectionId);
    if(missingScopes(connection.granted_scopes,['accounting.contacts','accounting.attachments']).length)
      throw new ConflictException({errorCode:'xero_contact_write_scope_missing',message:'An administrator must authorize document storage in company integrations.'});
    const accessToken=await this.accessToken(tenantId,connection.xero_authorization_id,config);
    return this.providerRequest(tenantId,connectionId,()=>this.client.ensureStudentContact(accessToken,connection.xero_tenant_id,value,key));
  }

  async createInvoice(tenantId:string,connectionId:string,value:import('./xero.client.js').XeroInvoiceCreate,key:string) {
    return (await this.invoiceCreationSession(tenantId,connectionId)).createInvoice(value,key);
  }

  async invoiceCreationSession(tenantId:string,connectionId:string) {
    // A batch shares authorization lookup/refresh, but never shares credentials
    // across requests or tenants. Long batches recheck authorization every minute.
    const load=async()=>{
      if(process.env.XERO_INVOICE_CREATION_ENABLED!=='true')throw new ConflictException({errorCode:'xero_invoice_creation_disabled',message:'An administrator must enable Xero invoice creation.'});
      const connection=await this.loadConnection(tenantId,connectionId);
      if(missingScopes(connection.granted_scopes,['accounting.invoices']).length&&missingScopes(connection.granted_scopes,['accounting.transactions']).length)
        throw new ConflictException({errorCode:'xero_invoice_write_scope_missing',message:'An administrator must reconnect Xero and authorize invoice creation.'});
      const accessToken=await this.accessToken(tenantId,connection.xero_authorization_id,requiredConfig());
      return {connection,accessToken,validUntil:Date.now()+60_000};
    };
    let current=await load(),refresh:ReturnType<typeof load>|undefined;
    const credentials=async()=>{
      if(Date.now()<current.validUntil)return current;
      if(!refresh)refresh=load().then(value=>current=value).finally(()=>{refresh=undefined;});
      return refresh;
    };
    const themeName=process.env.XERO_INVOICE_BRANDING_THEME_NAME?.trim()||'Trust Open for Australia acc';
    let brandingTheme:Promise<string>|undefined;
    const resolveBrandingTheme=()=>brandingTheme??= (async()=>{
      const {connection,accessToken}=await credentials();
      if(missingScopes(connection.granted_scopes,['accounting.settings.read']).length&&missingScopes(connection.granted_scopes,['accounting.settings']).length)
        throw new ConflictException({errorCode:'xero_branding_theme_scope_missing',message:'Invoice branding could not be checked. An administrator must authorize Xero settings access.'});
      let themes:Awaited<ReturnType<XeroClient['brandingThemes']>>;
      try{themes=await this.providerRequest(tenantId,connectionId,()=>this.client.brandingThemes(accessToken,connection.xero_tenant_id));}
      catch{throw new ConflictException({errorCode:'xero_branding_theme_unavailable',message:'Invoice branding could not be verified. No invoice was sent; retry when Xero settings are available.'});}
      const matches=themes.filter(theme=>theme.name.trim().toLowerCase()===themeName.toLowerCase());
      if(matches.length!==1)throw new ConflictException({errorCode:'xero_branding_theme_missing',message:`Configure one Xero invoice branding theme named "${themeName}" before creating invoices.`});
      return matches[0].brandingThemeId;
    })();
    let pendingTracking:Promise<{name:string;option:string;trackingCategoryId:string;trackingOptionId:string}>|undefined;
    const resolvePendingTracking=()=>pendingTracking??= (async()=>{
      const {connection,accessToken}=await credentials();
      if(missingScopes(connection.granted_scopes,['accounting.settings.read']).length&&missingScopes(connection.granted_scopes,['accounting.settings']).length)
        throw new ConflictException({errorCode:'xero_tracking_scope_missing',message:'An administrator must authorize Xero settings access before checking invoice tracking.'});
      let categories:Awaited<ReturnType<XeroClient['trackingCategories']>>;
      try{categories=await this.providerRequest(tenantId,connectionId,()=>this.client.trackingCategories(accessToken,connection.xero_tenant_id));}
      catch{throw new ConflictException({errorCode:'xero_pending_tracking_unavailable',message:'PENDING tracking could not be verified. No invoice was sent; retry when Xero settings are available.'});}
      const matches=categories.filter(category=>category.name.trim().toLowerCase()==='payment track');
      const options=matches.length===1?matches[0].options.filter(option=>option.name.trim().toLowerCase()==='pending'):[];
      if(matches.length!==1||options.length!==1)throw new ConflictException({errorCode:'xero_pending_tracking_missing',message:'Configure one active Pending option in the Xero Payment Track category before creating invoices.'});
      return {name:matches[0].name,option:options[0].name,trackingCategoryId:matches[0].trackingCategoryId,trackingOptionId:options[0].trackingOptionId};
    })();
    return {
      createInvoice:async(value:import('./xero.client.js').XeroInvoiceCreate,key:string)=>{
        if(process.env.XERO_INVOICE_CREATION_ENABLED!=='true')throw new ConflictException({errorCode:'xero_invoice_creation_disabled',message:'An administrator must enable Xero invoice creation.'});
        const [brandingThemeId,pending]=await Promise.all([resolveBrandingTheme(),resolvePendingTracking()]);
        const {connection,accessToken}=await credentials();
        if(process.env.XERO_INVOICE_CREATION_ENABLED!=='true')throw new ConflictException({errorCode:'xero_invoice_creation_disabled',message:'An administrator must enable Xero invoice creation.'});
        const lines=value.lines.map(line=>({...line,tracking:line.tracking.map(item=>item.name.trim().toLowerCase()==='payment track'&&item.option.trim().toLowerCase()==='pending'?pending:item)}));
        return this.providerRequest(tenantId,connectionId,()=>this.client.createInvoice(accessToken,connection.xero_tenant_id,{...value,lines,brandingThemeId},key));
      },
      invoiceById:async(invoiceId:string)=>{
        const {connection,accessToken}=await credentials();
        if(missingScopes(connection.granted_scopes,['accounting.invoices.read']).length&&missingScopes(connection.granted_scopes,['accounting.transactions.read']).length)
          throw new ConflictException({errorCode:'xero_invoice_read_scope_missing',message:'An administrator must reconnect Xero and authorize invoice verification.'});
        return this.providerRequest(tenantId,connectionId,()=>this.client.invoiceById(accessToken,connection.xero_tenant_id,invoiceId));
      },
    };
  }

  async invoiceById(tenantId:string,connectionId:string,invoiceId:string){
    const connection=await this.loadConnection(tenantId,connectionId);
    if(missingScopes(connection.granted_scopes,['accounting.invoices.read']).length&&missingScopes(connection.granted_scopes,['accounting.transactions.read']).length)
      throw new ConflictException({errorCode:'xero_invoice_read_scope_missing',message:'An administrator must reconnect Xero and authorize invoice verification.'});
    const accessToken=await this.accessToken(tenantId,connection.xero_authorization_id,requiredConfig());
    return this.providerRequest(tenantId,connectionId,()=>this.client.invoiceById(accessToken,connection.xero_tenant_id,invoiceId));
  }

  async invoiceCandidates(tenantId:string,connectionId:string,contactId:string,date:string){
    const connection=await this.loadConnection(tenantId,connectionId);
    if(missingScopes(connection.granted_scopes,['accounting.invoices.read']).length&&missingScopes(connection.granted_scopes,['accounting.transactions.read']).length)
      throw new ConflictException({errorCode:'xero_invoice_read_scope_missing',message:'An administrator must reconnect Xero and authorize invoice verification.'});
    const accessToken=await this.accessToken(tenantId,connection.xero_authorization_id,requiredConfig());
    return this.providerRequest(tenantId,connectionId,()=>this.client.invoiceCandidates(accessToken,connection.xero_tenant_id,contactId,date));
  }

  private providerRequest<T>(tenantId: string, connectionId: string, request: () => Promise<T>,kind:XeroRequestKind='operational'): Promise<T> {
    // Additive rollout: apply 082 first, then enable on both Runtime API and
    // shared worker. A missing/inaccessible store fails closed before fetch.
    if(process.env.XERO_SHARED_QUOTA_ENABLED==='true' && process.env.XERO_SHARED_BACKOFF_ENABLED!=='true')
      throw new ServiceUnavailableException('Shared Xero quota requires shared backoff.');
    if (process.env.XERO_SHARED_BACKOFF_ENABLED !== 'true') return request();
    return this.client.withRequestPolicy(new XeroSharedBackoff(this.database).policy(tenantId, connectionId,kind), request);
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
  return required.filter((scope) => !present.has(scope)
    && !(scope.endsWith('.read') && present.has(scope.slice(0,-5))));
}
