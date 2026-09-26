import { Module } from "@nestjs/common";
import { DatabaseModule } from "../database/database.module.js";
import { runtimeConfig } from "../config/runtime-config.js";
import { PostgresActionReviewStore } from "../tools/action-review.store.js";
import { BusinessManagerClient } from "./real-estate/business-manager.client.js";
import { BusinessPackRegistry } from "./business-pack.registry.js";
import { BusinessManagerRealEstateConnector } from "./real-estate/business-manager-real-estate.connector.js";
import { createRealEstateBusinessPack } from "./real-estate/real-estate.pack.js";

@Module({
  imports: [DatabaseModule],
  providers: [
    PostgresActionReviewStore,
    BusinessManagerClient,
    BusinessManagerRealEstateConnector,
    {
      provide: BusinessPackRegistry,
      inject: [BusinessManagerClient, PostgresActionReviewStore, BusinessManagerRealEstateConnector],
      useFactory: (
        client: BusinessManagerClient,
        reviews: PostgresActionReviewStore,
        connector: BusinessManagerRealEstateConnector,
      ) => new BusinessPackRegistry(
        runtimeConfig().enabledBusinessPacks.includes("real-estate")
          ? [createRealEstateBusinessPack(client, reviews, connector)]
          : [],
      ),
    },
  ],
  exports: [BusinessPackRegistry, PostgresActionReviewStore, BusinessManagerClient],
})
export class BusinessPacksModule {}
