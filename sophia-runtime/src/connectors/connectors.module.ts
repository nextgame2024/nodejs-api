import { Module } from "@nestjs/common";
import { ConnectorAuthorityService } from "./authority/connector-authority.service.js";
import { ScopedConnectorCredentialService } from "./authority/scoped-connector-credential.service.js";
import { XeroClient } from "./xero/xero.client.js";
import { XeroConnectorService } from "./xero/xero-connector.service.js";
import { XeroCryptoService } from "./xero/xero-crypto.service.js";
import { XeroOAuthController } from "./xero/xero-oauth.controller.js";

@Module({
  controllers: [XeroOAuthController],
  providers: [
    ConnectorAuthorityService,
    ScopedConnectorCredentialService,
    XeroClient,
    XeroCryptoService,
    XeroConnectorService,
  ],
  exports: [ConnectorAuthorityService, XeroConnectorService],
})
export class ConnectorsModule {}
