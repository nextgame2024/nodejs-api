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

export type XeroStudentCandidate = {
  xeroContactId: string;
  legalName: string;
  email: string | null;
  suggestedStudentReference: string | null;
  invoiceCount: number;
  latestInvoiceNumber: string | null;
  latestInvoiceDate: string | null;
  nextPaymentDate: string | null;
  nextPaymentAmount: number | null;
  totalInvoiced: number;
  totalPaid: number;
  amountDue: number;
  currencyCode: string | null;
  paymentStatus: "paid" | "due" | "overdue";
};

export type XeroStudentCandidateResult = {
  candidates: XeroStudentCandidate[];
  invoiceCount: number;
  truncated: boolean;
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

  async studentCandidates(accessToken: string, tenantId: string): Promise<XeroStudentCandidateResult> {
    const invoicesUrl = new URL("https://api.xero.com/api.xro/2.0/Invoices");
    invoicesUrl.search = new URLSearchParams({
      Statuses: "DRAFT,SUBMITTED,AUTHORISED,PAID",
      page: "1",
      pageSize: "500",
      summaryOnly: "true",
      order: "UpdatedDateUTC DESC",
    }).toString();
    const payload = record(await this.json(invoicesUrl.toString(), accessToken, tenantId));
    if (!Array.isArray(payload.Invoices)) {
      throw new BadGatewayException("Xero returned an invalid invoices response.");
    }
    const invoices = payload.Invoices.map(record)
      .filter((invoice) => invoice.Type === "ACCREC" && invoice.Status !== "VOIDED" && invoice.Status !== "DELETED");
    const contactIds = Array.from(new Set(invoices.map((invoice) => {
      const contact = record(invoice.Contact);
      return requiredString(contact.ContactID, "contact id");
    })));
    const contacts = await this.contacts(accessToken, tenantId, contactIds);
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    const grouped = new Map<string, XeroStudentCandidate>();

    for (const invoice of invoices) {
      const invoiceContact = record(invoice.Contact);
      const contactId = requiredString(invoiceContact.ContactID, "contact id");
      const contact = contacts.get(contactId) ?? invoiceContact;
      const total = optionalNumber(invoice.Total) ?? 0;
      const amountPaid = optionalNumber(invoice.AmountPaid) ?? 0;
      const amountDue = optionalNumber(invoice.AmountDue) ?? Math.max(0, total - amountPaid);
      const invoiceDate = optionalDate(invoice.DateString) ?? optionalXeroDate(invoice.Date);
      const dueDate = optionalDate(invoice.DueDateString) ?? optionalXeroDate(invoice.DueDate);
      const existing = grouped.get(contactId) ?? {
        xeroContactId: contactId,
        legalName: optionalString(contact.Name) ?? optionalString(invoiceContact.Name) ?? "Unnamed Xero contact",
        email: optionalString(contact.EmailAddress) ?? optionalString(invoiceContact.EmailAddress),
        suggestedStudentReference: optionalString(contact.ContactNumber) ?? optionalString(contact.AccountNumber),
        invoiceCount: 0,
        latestInvoiceNumber: null,
        latestInvoiceDate: null,
        nextPaymentDate: null,
        nextPaymentAmount: null,
        totalInvoiced: 0,
        totalPaid: 0,
        amountDue: 0,
        currencyCode: optionalString(invoice.CurrencyCode),
        paymentStatus: "paid" as const,
      };
      existing.invoiceCount += 1;
      existing.totalInvoiced += total;
      existing.totalPaid += amountPaid;
      existing.amountDue += amountDue;
      if (invoiceDate && (!existing.latestInvoiceDate || invoiceDate > existing.latestInvoiceDate)) {
        existing.latestInvoiceDate = invoiceDate;
        existing.latestInvoiceNumber = optionalString(invoice.InvoiceNumber);
      }
      if (amountDue > 0 && dueDate && (!existing.nextPaymentDate || dueDate < existing.nextPaymentDate)) {
        existing.nextPaymentDate = dueDate;
        existing.nextPaymentAmount = amountDue;
      }
      if (amountDue > 0) {
        const overdue = Boolean(dueDate && new Date(`${dueDate}T00:00:00Z`).getTime() < today.getTime());
        existing.paymentStatus = overdue ? "overdue" : existing.paymentStatus === "overdue" ? "overdue" : "due";
      }
      grouped.set(contactId, existing);
    }

    return {
      candidates: Array.from(grouped.values())
        .map((candidate) => ({
          ...candidate,
          totalInvoiced: money(candidate.totalInvoiced),
          totalPaid: money(candidate.totalPaid),
          amountDue: money(candidate.amountDue),
          nextPaymentAmount: candidate.nextPaymentAmount === null ? null : money(candidate.nextPaymentAmount),
        }))
        .sort((left, right) => left.legalName.localeCompare(right.legalName)),
      invoiceCount: invoices.length,
      truncated: payload.Pagination
        ? Number(record(payload.Pagination).PageCount ?? 1) > 1
        : payload.Invoices.length >= 500,
    };
  }

  private async contacts(
    accessToken: string,
    tenantId: string,
    contactIds: string[],
  ): Promise<Map<string, Record<string, unknown>>> {
    const output = new Map<string, Record<string, unknown>>();
    const batches: string[][] = [];
    for (let index = 0; index < contactIds.length; index += 100) {
      batches.push(contactIds.slice(index, index + 100));
    }
    const responses = await Promise.all(batches.map(async (ids) => {
      const url = new URL("https://api.xero.com/api.xro/2.0/Contacts");
      url.search = new URLSearchParams({ IDs: ids.join(","), page: "1", pageSize: "100" }).toString();
      const payload = record(await this.json(url.toString(), accessToken, tenantId));
      if (!Array.isArray(payload.Contacts)) {
        throw new BadGatewayException("Xero returned an invalid contacts response.");
      }
      return payload.Contacts;
    }));
    for (const contacts of responses) {
      for (const entry of contacts) {
        const contact = record(entry);
        output.set(requiredString(contact.ContactID, "contact id"), contact);
      }
    }
    return output;
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

function optionalNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Number(value);
  return null;
}

function optionalDate(value: unknown): string | null {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}/.test(value)) return null;
  return value.slice(0, 10);
}

function optionalXeroDate(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const match = /\/Date\((\d+)/.exec(value);
  if (!match?.[1]) return null;
  const parsed = new Date(Number(match[1]));
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString().slice(0, 10);
}

function money(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}
