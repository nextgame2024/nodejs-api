import { Module } from "@nestjs/common";
import { ConfigurationProfileService } from "./configuration-profile.service.js";

@Module({
  providers: [ConfigurationProfileService],
  exports: [ConfigurationProfileService],
})
export class ConfigurationModule {}
