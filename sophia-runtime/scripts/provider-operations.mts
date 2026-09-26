import { NestFactory } from "@nestjs/core";
import { AppModule } from "../src/app.module.js";
import { ProviderCatalogProvisioner } from "../src/providers/provisioning/provider-catalog-provisioner.js";
import { ProviderOperationsService } from "../src/providers/session/provider-operations.service.js";

const action = process.argv[2];
const customerId = process.env.SOPHIA_PROVIDER_OPERATION_CUSTOMER_ID?.trim() ?? "";
if (!customerId || process.env.SOPHIA_PROVIDER_OPERATION_CONFIRM !== customerId) {
  throw new Error("Set SOPHIA_PROVIDER_OPERATION_CUSTOMER_ID and set SOPHIA_PROVIDER_OPERATION_CONFIRM to the same tenant UUID.");
}

const app = await NestFactory.createApplicationContext(AppModule, { logger: ["error", "warn"] });
try {
  if (action === "provision") {
    const version = process.env.SOPHIA_PROVIDER_CATALOG_VERSION?.trim() ?? "";
    const result = await app.get(ProviderCatalogProvisioner).provisionTavus(customerId, version);
    console.log(JSON.stringify(result));
  } else if (action === "reconcile") {
    const limit = Number(process.env.SOPHIA_PROVIDER_RECONCILE_LIMIT || 25);
    const result = await app.get(ProviderOperationsService).reconcileTenant(customerId, limit);
    console.log(JSON.stringify(result));
  } else {
    throw new Error("Use provider operation 'provision' or 'reconcile'.");
  }
} finally {
  await app.close();
}
