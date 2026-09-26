import { Controller, Headers, HttpCode, Post, Req } from "@nestjs/common";
import { BillingLifecycleService } from "./billing-lifecycle.service.js";

type RawRequest = { rawBody?: Buffer };

@Controller("billing/v1/webhooks")
export class BillingWebhookController {
  constructor(private readonly lifecycle: BillingLifecycleService) {}

  @Post("stripe") @HttpCode(200)
  stripe(@Headers() headers: Record<string, string | string[] | undefined>, @Req() request: RawRequest) {
    const normalized = Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), Array.isArray(value) ? value[0] : value]));
    return this.lifecycle.webhook(normalized, request.rawBody ?? new Uint8Array());
  }
}
