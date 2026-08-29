import { Controller, Get, Inject } from "@nestjs/common";
import { DatabaseService } from "../database/database.service.js";

@Controller("healthz")
export class HealthController {
  constructor(@Inject(DatabaseService) private readonly database: DatabaseService) {}

  @Get()
  async healthz() {
    await this.database.ping();
    return { ok: true };
  }
}
