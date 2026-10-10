import {
  Body,
  Controller,
  Headers,
  HttpCode,
  Post,
  Req,
  ServiceUnavailableException,
  UnauthorizedException,
} from "@nestjs/common";
import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { StudentOperationsXeroSyncService } from "../../business-packs/student-operations/student-operations-xero-sync.service.js";
import { xeroConfiguration } from "./xero.config.js";

const WebhookSchema = z.object({
  events: z.array(z.object({
    tenantId: z.string().uuid(),
    eventCategory: z.string().max(40),
  }).passthrough()).max(500),
}).passthrough();

@Controller("connectors/xero/v1/webhooks")
export class XeroWebhookController {
  constructor(private readonly sync: StudentOperationsXeroSyncService) {}

  @Post()
  @HttpCode(200)
  async receive(
    @Req() request: { rawBody?: Buffer },
    @Headers("x-xero-signature") signature: string | undefined,
    @Body() body: unknown,
  ) {
    const key = xeroConfiguration()?.webhookKey;
    if (!key) throw new ServiceUnavailableException("Xero webhooks are not configured.");
    const rawBody = request.rawBody;
    if (!rawBody || !validSignature(rawBody, signature, key)) {
      throw new UnauthorizedException("Invalid Xero webhook signature.");
    }
    const parsed = WebhookSchema.safeParse(body);
    if (!parsed.success) return {};
    const tenantIds = new Set(parsed.data.events
      .filter((event) => event.eventCategory === "INVOICE" || event.eventCategory === "CONTACT")
      .map((event) => event.tenantId));
    for (const tenantId of tenantIds) await this.sync.enqueueWebhook(tenantId);
    return {};
  }
}

function validSignature(rawBody: Buffer, signature: string | undefined, key: string): boolean {
  if (!signature) return false;
  const expected = createHmac("sha256", key).update(rawBody).digest();
  let supplied: Buffer;
  try { supplied = Buffer.from(signature, "base64"); }
  catch { return false; }
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}
