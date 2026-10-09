import { Controller, Get, Query, Redirect } from "@nestjs/common";
import { XeroConnectorService } from "./xero-connector.service.js";

@Controller("connectors/xero/v1")
export class XeroOAuthController {
  constructor(private readonly xero: XeroConnectorService) {}

  @Get("oauth/callback")
  @Redirect()
  async callback(@Query("code") code?: string, @Query("state") state?: string, @Query("error") error?: string) {
    if (error) return { url: this.xero.cancelledReturnUrl(), statusCode: 302 };
    try {
      const result = await this.xero.completeAuthorization(code ?? "", state ?? "");
      return { url: result.returnUrl, statusCode: 302 };
    } catch {
      return { url: this.xero.failedReturnUrl(), statusCode: 302 };
    }
  }
}
