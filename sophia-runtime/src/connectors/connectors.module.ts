import { Module } from "@nestjs/common";
import { ConnectorAuthorityService } from "./authority/connector-authority.service.js";
import { ScopedConnectorCredentialService } from "./authority/scoped-connector-credential.service.js";

@Module({
  providers: [ConnectorAuthorityService, ScopedConnectorCredentialService],
  exports: [ConnectorAuthorityService],
})
export class ConnectorsModule {}
