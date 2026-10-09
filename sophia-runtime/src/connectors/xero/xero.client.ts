import { BadGatewayException, Injectable } from "@nestjs/common";
import type { XeroConfig } from "./xero.config.js";

export type XeroTokenSet = {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  scopes: string[];
};

export type XeroProviderConnection = {
  id: string;
  tenantId: string;
  tenantType: string;
  tenantName: string;
};

export type XeroOrganisation = {
  organisationId: string;
  name: string;
  legalName: string | null;
  organisationType: string | null;
  shortCode: string | null;
  baseCurrency: string | null;
  countryCode: string | null;
  isDemoCompany: boolean;
};

export type XeroBankAccount = {
  accountId: string;
  code: string | null;
  name: string;
  status: string | null;
  bankAccountType: string | null;
};

@Injectable()
export class XeroClient {
  async exchangeCode(code: string, verifier: string, config: XeroConfig): Promise<XeroTokenSet> {
    return this.tokenRequest(new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: config.redirectUri,
      code_verifier: verifier,
    }), config);
  }

  async refresh(refreshToken: string, config: XeroConfig): Promise<XeroTokenSet> {
    return this.tokenRequest(new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    }), config);
  }

  async connections(accessToken: string): Promise<XeroProviderConnection[]> {
    const payload = await this.json("https://api.xero.com/connections", accessToken) as unknown;
    if (!Array.isArray(payload)) throw new BadGatewayException("Xero returned an invalid connections response.");
    return payload.map((entry) => {
      const value = record(entry);
      return {
        id: requiredString(value.id, "connection id"),
        tenantId: requiredString(value.tenantId, "tenant id"),
        tenantType: requiredString(value.tenantType, "tenant type"),
        tenantName: requiredString(value.tenantName, "tenant name"),
      };
    });
  }

  async organisation(accessToken: string, tenantId: string): Promise<XeroOrganisation> {
    const payload = record(await this.json(
      "https://api.xero.com/api.xro/2.0/Organisation",
      accessToken,
      tenantId,
    ));
    const organisations = payload.Organisations;
    if (!Array.isArray(organisations) || organisations.length !== 1) {
      throw new BadGatewayException("Xero returned an invalid organisation response.");
    }
    const value = record(organisations[0]);
    return {
      organisationId: requiredString(value.OrganisationID, "organisation id"),
      name: requiredString(value.Name, "organisation name"),
      legalName: optionalString(value.LegalName),
      organisationType: optionalString(value.OrganisationType),
      shortCode: optionalString(value.ShortCode),
      baseCurrency: optionalString(value.BaseCurrency),
      countryCode: optionalString(value.CountryCode),
      isDemoCompany: value.IsDemoCompany === true,
    };
  }

  async bankAccounts(accessToken: string, tenantId: string): Promise<XeroBankAccount[]> {
    const payload = record(await this.json(
      "https://api.xero.com/api.xro/2.0/Accounts",
      accessToken,
      tenantId,
    ));
    if (!Array.isArray(payload.Accounts)) {
      throw new BadGatewayException("Xero returned an invalid accounts response.");
    }
    return payload.Accounts.map(record)
      .filter((value) => value.Type === "BANK")
      .map((value) => ({
        accountId: requiredString(value.AccountID, "account id"),
        code: optionalString(value.Code),
        name: requiredString(value.Name, "account name"),
        status: optionalString(value.Status),
        bankAccountType: optionalString(value.BankAccountType),
      }));
  }

  private async tokenRequest(body: URLSearchParams, config: XeroConfig): Promise<XeroTokenSet> {
    const response = await fetch("https://identity.xero.com/connect/token", {
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from(`${config.clientId}:${config.clientSecret}`).toString("base64")}`,
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body,
      signal: AbortSignal.timeout(15_000),
    });
    const payload = record(await parseJson(response));
    if (!response.ok) throw new BadGatewayException("Xero authorization could not be completed.");
    const accessToken = requiredString(payload.access_token, "access token");
    const refreshToken = requiredString(payload.refresh_token, "refresh token");
    const expiresIn = typeof payload.expires_in === "number"
      && Number.isFinite(payload.expires_in)
      && payload.expires_in > 0
      && payload.expires_in <= 86_400
      ? Math.floor(payload.expires_in)
      : 1800;
    return {
      accessToken,
      refreshToken,
      expiresIn,
      scopes: typeof payload.scope === "string" ? payload.scope.split(" ").filter(Boolean) : [],
    };
  }

  private async json(url: string, accessToken: string, tenantId?: string): Promise<unknown> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
    };
    if (tenantId) headers["xero-tenant-id"] = tenantId;
    const response = await fetch(url, { headers, signal: AbortSignal.timeout(15_000) });
    const payload = await parseJson(response);
    if (!response.ok) throw new BadGatewayException("Xero could not verify the connected organisation.");
    return payload;
  }
}

async function parseJson(response: Response): Promise<unknown> {
  try { return await response.json(); }
  catch { throw new BadGatewayException("Xero returned an unreadable response."); }
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new BadGatewayException("Xero returned an invalid response.");
  }
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value) throw new BadGatewayException(`Xero response omitted ${label}.`);
  return value;
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}
