import { afterAll, beforeAll, describe, expect, it, jest } from "@jest/globals";
import { BadGatewayException } from "@nestjs/common";
import { StudentOperationsXeroSyncService } from "./student-operations-xero-sync.service.js";

const originalDatabaseUrl = process.env.SOPHIA_RUNTIME_DATABASE_URL;
beforeAll(() => { process.env.SOPHIA_RUNTIME_DATABASE_URL = "postgresql://example.invalid/runtime"; });
afterAll(() => {
  if (originalDatabaseUrl === undefined) delete process.env.SOPHIA_RUNTIME_DATABASE_URL;
  else process.env.SOPHIA_RUNTIME_DATABASE_URL = originalDatabaseUrl;
});

const tenantId = "11111111-1111-4111-8111-111111111111";
const connectionId = "44444444-4444-4444-8444-444444444444";

describe("StudentOperationsXeroSyncService", () => {
  it("pages and searches the local read model without calling Xero", async () => {
    const query = jest.fn(async (sql: string) => {
      if (sql.includes("FROM sophia_runtime.xero_connections")) return { rows: [{ exists: 1 }], rowCount: 1 };
      return {
        rows: [{
          xero_contact_id: "55555555-5555-4555-8555-555555555555",
          legal_name: "Candidate Student",
          email: "candidate@example.invalid",
          contact_number: "STU-001",
          account_number: null,
          invoice_count: 2,
          latest_invoice_number: "INV-2",
          latest_invoice_date: "2026-10-02",
          latest_invoice_reference: "ENROL-200",
          latest_concept: "Diploma tuition",
          latest_advisor_name: "Maria Lopez",
          latest_college_name: "Example College",
          next_payment_date: "2026-10-20",
          next_payment_amount: "75.50",
          total_invoiced: "200.00",
          total_paid: "124.50",
          amount_due: "75.50",
          currency_code: "AUD",
          payment_status: "due",
          total_count: 1,
        }],
        rowCount: 1,
      };
    });
    const database = {
      tenantReadTransaction: jest.fn(async (_tenant: string, work: (db: unknown) => Promise<unknown>) =>
        work({ query })),
    };
    const xero = { syncContactPage: jest.fn(), syncInvoicePage: jest.fn() };
    const service = new StudentOperationsXeroSyncService(database as never, xero as never);

    const result = await service.candidates(tenantId, connectionId, {
      page: "1", limit: "20", q: "Candidate", sort: "invoiceDate", direction: "desc",
    });

    expect(result.total).toBe(1);
    expect(result.candidates[0]).toEqual(expect.objectContaining({
      legalName: "Candidate Student", amountDue: 75.5, paymentStatus: "due",
      latestInvoiceReference: "ENROL-200", concept: "Diploma tuition",
      advisorName: "Maria Lopez", collegeName: "Example College",
    }));
    expect(query.mock.calls.at(-1)?.[0]).toContain("ORDER BY latest_invoice_date DESC");
    expect(query).toHaveBeenLastCalledWith(expect.stringContaining("ILIKE $3"), [
      tenantId, connectionId, "%Candidate%", 20, 0,
    ]);
    expect(xero.syncContactPage).not.toHaveBeenCalled();
    expect(xero.syncInvoicePage).not.toHaveBeenCalled();
  });

  it("pages individual invoices and projects Xero list fields from the local read model", async () => {
    const invoiceId = "77777777-7777-4777-8777-777777777771";
    const query = jest.fn(async (sql: string) => {
      if (sql.includes("FROM sophia_runtime.xero_connections")) return { rows: [{ exists: 1 }], rowCount: 1 };
      return {
        rows: [{
          xero_invoice_id: invoiceId,
          xero_contact_id: "55555555-5555-4555-8555-555555555555",
          invoice_number: "INV-10035", invoice_reference: "ATI",
          legal_name: "Fabian Student", email: "student@example.invalid",
          contact_number: "S15", account_number: null,
          invoice_date: "2029-10-01", due_date: "2029-10-01", invoice_status: "DRAFT",
          currency_code: "AUD", total: "2200", amount_paid: "0", amount_due: "2200",
          sent_to_contact: false, concept: "Diploma tuition", advisor_name: "S15 Paulina",
          college_name: "ATI", payment_track: "Pending", review_status: "pending",
          student_id: null, total_count: 7793,
          invoice_total_count: 7545, credit_note_total_count: 200,
          prepayment_total_count: 30, overpayment_total_count: 18,
        }],
        rowCount: 1,
      };
    });
    const database = {
      tenantReadTransaction: jest.fn(async (_tenant: string, work: (db: unknown) => Promise<unknown>) =>
        work({ query })),
    };
    const service = new StudentOperationsXeroSyncService(database as never, {} as never);

    const result = await service.invoices(tenantId, connectionId, {
      page: "2", limit: "25", q: "ATI", sort: "dueDate", direction: "desc",
    });

    expect(result).toEqual(expect.objectContaining({
      page: 2, limit: 25, total: 7793, totalPages: 312,
      invoiceTotal: 7545, creditNoteTotal: 200,
      prepaymentTotal: 30, overpaymentTotal: 18,
    }));
    expect(result.invoices[0]).toEqual(expect.objectContaining({
      xeroInvoiceId: invoiceId, invoiceNumber: "INV-10035", reference: "ATI",
      advisorName: "S15 Paulina", paymentTrack: "Pending", amountDue: 2200,
    }));
    expect(query).toHaveBeenLastCalledWith(expect.stringContaining("ORDER BY i.due_date DESC"), [
      tenantId, connectionId, "%ATI%", 25, 25,
    ]);
    expect(query.mock.calls.at(-1)?.[0]).toContain(
      "i.invoice_status IN ('DRAFT','SUBMITTED','AUTHORISED','PAID')",
    );
    expect(query.mock.calls.at(-1)?.[0]).toContain("full_run.mode IN ('initial','reconciliation')");
  });

  it("returns stored line items for invoice detail without calling Xero", async () => {
    const invoiceId = "77777777-7777-4777-8777-777777777771";
    const query = jest.fn(async (sql: string) => {
      if (sql.includes("FROM sophia_runtime.xero_connections")) return { rows: [{ exists: 1 }], rowCount: 1 };
      return { rows: [{
        xero_invoice_id: invoiceId,
        xero_contact_id: "55555555-5555-4555-8555-555555555555",
        invoice_number: "INV-10035", invoice_reference: "ATI", legal_name: "Fabian Student",
        email: null, contact_number: null, account_number: null, invoice_date: "2029-10-01",
        due_date: "2029-10-01", invoice_status: "DRAFT", currency_code: "AUD",
        total: "2200", amount_paid: "0", amount_due: "2200", sent_to_contact: false,
        concept: "Diploma tuition", advisor_name: "S15 Paulina", college_name: "ATI",
        payment_track: "Pending", review_status: "pending", student_id: null,
        line_items: [{ description: "Diploma tuition", quantity: 1, lineAmount: 2200 }],
      }], rowCount: 1 };
    });
    const database = {
      tenantReadTransaction: jest.fn(async (_tenant: string, work: (db: unknown) => Promise<unknown>) =>
        work({ query })),
    };
    const xero = { syncInvoicePage: jest.fn() };
    const service = new StudentOperationsXeroSyncService(database as never, xero as never);

    const result = await service.invoice(tenantId, connectionId, invoiceId);

    expect(result.lineItems).toEqual([{ description: "Diploma tuition", quantity: 1, lineAmount: 2200 }]);
    expect(query.mock.calls.at(-1)?.[0]).toContain(
      "i.invoice_status IN ('DRAFT','SUBMITTED','AUTHORISED','PAID')",
    );
    expect(query.mock.calls.at(-1)?.[0]).toContain("full_run.mode IN ('initial','reconciliation')");
    expect(xero.syncInvoicePage).not.toHaveBeenCalled();
  });

  it("durably queues a manual initial sync before any provider work", async () => {
    jest.useFakeTimers();
    const now = new Date("2026-10-10T00:00:00.000Z");
    const query = jest.fn(async (sql: string) => {
      if (sql.includes("FROM sophia_runtime.xero_connections")) return { rows: [{ exists: 1 }], rowCount: 1 };
      if (sql.includes("INSERT INTO sophia_runtime.student_operations_xero_sync_configurations")) {
        return { rows: [{ last_successful_sync_at: null, last_reconciliation_sync_at: null }], rowCount: 1 };
      }
      if (sql.includes("status IN ('queued','processing')")) return { rows: [], rowCount: 0 };
      return {
        rows: [{
          sync_run_id: "66666666-6666-4666-8666-666666666666",
          xero_connection_id: connectionId,
          mode: "initial",
          trigger_type: "manual",
          status: "queued",
          modified_since: null,
          contact_count: 0,
          invoice_count: 0,
          candidate_count: 0,
          error_code: null,
          created_at: now,
          started_at: null,
          completed_at: null,
        }],
        rowCount: 1,
      };
    });
    const database = {
      tenantTransaction: jest.fn(async (_tenant: string, work: (db: unknown) => Promise<unknown>) =>
        work({ query })),
    };
    const xero = { syncContactPage: jest.fn(), syncInvoicePage: jest.fn() };
    const service = new StudentOperationsXeroSyncService(database as never, xero as never);

    const run = await service.enqueueManual({
      tenantId,
      identityUserId: "user-1",
    } as never, connectionId);

    expect(run).toEqual(expect.objectContaining({ status: "queued", mode: "initial" }));
    expect(xero.syncContactPage).not.toHaveBeenCalled();
    expect(xero.syncInvoicePage).not.toHaveBeenCalled();
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  it("uses a full reconciliation for an explicit refresh", async () => {
    jest.useFakeTimers();
    const now = new Date("2026-10-10T00:00:00.000Z");
    const query = jest.fn(async (sql: string) => {
      if (sql.includes("FROM sophia_runtime.xero_connections")) return { rows: [{ exists: 1 }], rowCount: 1 };
      if (sql.includes("INSERT INTO sophia_runtime.student_operations_xero_sync_configurations")) {
        return {
          rows: [{
            last_successful_sync_at: now,
            last_reconciliation_sync_at: now,
            invoice_metadata_version: 1,
            invoice_detail_version: 1,
          }],
          rowCount: 1,
        };
      }
      if (sql.includes("status IN ('queued','processing')")) return { rows: [], rowCount: 0 };
      return {
        rows: [{
          sync_run_id: "66666666-6666-4666-8666-666666666666",
          xero_connection_id: connectionId,
          mode: "reconciliation",
          trigger_type: "manual",
          status: "queued",
          modified_since: null,
          contact_count: 0,
          invoice_count: 0,
          candidate_count: 0,
          error_code: null,
          created_at: now,
          started_at: null,
          completed_at: null,
        }],
        rowCount: 1,
      };
    });
    const database = {
      tenantTransaction: jest.fn(async (_tenant: string, work: (db: unknown) => Promise<unknown>) =>
        work({ query })),
    };
    const service = new StudentOperationsXeroSyncService(database as never, {} as never);

    const run = await service.enqueueManual({ tenantId, identityUserId: "user-1" } as never, connectionId);

    expect(run).toEqual(expect.objectContaining({ mode: "reconciliation" }));
    expect(query).toHaveBeenCalledWith(expect.stringContaining("'manual'"), [
      tenantId, connectionId, "reconciliation", "user-1", null,
    ]);
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  it("bulk upserts provider pages and checkpoints visible progress", async () => {
    const now = new Date("2026-10-10T00:00:00.000Z");
    const run = {
      sync_run_id: "66666666-6666-4666-8666-666666666666",
      xero_connection_id: connectionId,
      mode: "initial",
      trigger_type: "manual",
      status: "processing",
      modified_since: null,
      contact_count: 0,
      invoice_count: 0,
      candidate_count: 0,
      error_code: null,
      created_at: now,
      started_at: now,
      completed_at: null,
    };
    const query = jest.fn(async (sql: string, _params?: unknown[]) => {
      if (sql.includes("SET status='processing'")) return { rows: [run], rowCount: 1 };
      if (sql.includes("count(DISTINCT i.xero_contact_id)")) return { rows: [{ count: 2 }], rowCount: 1 };
      return { rows: [{ exists: 1 }], rowCount: 1 };
    });
    const database = {
      tenantTransaction: jest.fn(async (_tenant: string, work: (db: unknown) => Promise<unknown>) =>
        work({ query })),
    };
    const contacts = [
      {
        contactId: "55555555-5555-4555-8555-555555555551", status: "ACTIVE",
        legalName: "Student One", email: "one@example.invalid", contactNumber: "STU-1",
        accountNumber: null, updatedAt: "2026-10-09T00:00:00.000Z",
      },
      {
        contactId: "55555555-5555-4555-8555-555555555552", status: "ACTIVE",
        legalName: "Student Two", email: "two@example.invalid", contactNumber: "STU-2",
        accountNumber: null, updatedAt: "2026-10-09T00:00:00.000Z",
      },
    ];
    const invoices = contacts.map((contact, index) => ({
      invoiceId: `77777777-7777-4777-8777-77777777777${index + 1}`,
      contactId: contact.contactId,
      invoiceNumber: `INV-${index + 1}`,
      invoiceReference: `REF-${index + 1}`,
      concept: "Tuition",
      advisorName: "Maria Lopez",
      collegeName: "Example College",
      paymentTrack: "Pending",
      sentToContact: true,
      lineItems: [],
      type: "ACCREC",
      status: "AUTHORISED",
      invoiceDate: "2026-10-01",
      dueDate: "2026-10-20",
      currencyCode: "AUD",
      total: 100,
      amountPaid: 0,
      amountDue: 100,
      updatedAt: "2026-10-09T00:00:00.000Z",
    }));
    const xero = {
      syncContactPage: jest.fn(async () => ({ items: contacts, page: 1, pageCount: 1 })),
      syncInvoicePage: jest.fn(async () => ({
        items: invoices, page: 1, pageCount: 1, itemCount: invoices.length,
      })),
      syncCreditNotePage: jest.fn(async () => ({
        items: [], page: 1, pageCount: 1, itemCount: 0,
      })),
      syncPrepaymentPage: jest.fn(async () => ({
        items: [], page: 1, pageCount: 1, itemCount: 0,
      })),
      syncOverpaymentPage: jest.fn(async () => ({
        items: [], page: 1, pageCount: 1, itemCount: 0,
      })),
    };
    const service = new StudentOperationsXeroSyncService(database as never, xero as never);

    await service.process(tenantId, run.sync_run_id);

    const contactUpserts = query.mock.calls.filter(([sql]) => String(sql).includes("jsonb_array_elements($4::jsonb)")
      && String(sql).includes("student_operations_xero_contacts"));
    const invoiceUpserts = query.mock.calls.filter(([sql]) => String(sql).includes("jsonb_array_elements($4::jsonb)")
      && String(sql).includes("student_operations_xero_invoices"));
    expect(contactUpserts).toHaveLength(1);
    expect(invoiceUpserts).toHaveLength(1);
    expect(JSON.parse(String(contactUpserts[0]?.[1]?.[3]))).toHaveLength(2);
    expect(JSON.parse(String(invoiceUpserts[0]?.[1]?.[3]))).toHaveLength(2);
    expect(query).toHaveBeenCalledWith(expect.stringContaining("SET contact_count=$4"), [
      tenantId, run.sync_run_id, expect.any(String), 2,
    ]);
    expect(query).toHaveBeenCalledWith(expect.stringContaining("SET invoice_count=$4"), [
      tenantId, run.sync_run_id, expect.any(String), 2,
    ]);
    expect(xero.syncInvoicePage).toHaveBeenCalledWith(
      tenantId, connectionId, 1, undefined, false,
    );
    expect(xero.syncCreditNotePage).toHaveBeenCalledWith(
      tenantId, connectionId, 1, undefined,
    );
    expect(xero.syncPrepaymentPage).toHaveBeenCalledWith(
      tenantId, connectionId, 1, undefined,
    );
    expect(xero.syncOverpaymentPage).toHaveBeenCalledWith(
      tenantId, connectionId, 1, undefined,
    );
    expect(query.mock.calls.some(([sql]) => String(sql).includes(
      "last_seen_sync_run_id IS DISTINCT FROM $3",
    ))).toBe(false);
    expect(query).toHaveBeenCalledWith(expect.stringContaining("SET status='succeeded'"), [
      tenantId, run.sync_run_id, expect.any(String), 2, 2, 2,
    ]);
  });

  it("backs off repeated Xero failures to protect the provider call allowance", async () => {
    const now = new Date("2026-10-10T00:00:00.000Z");
    const run = {
      sync_run_id: "66666666-6666-4666-8666-666666666666",
      xero_connection_id: connectionId,
      mode: "initial",
      trigger_type: "schedule",
      status: "processing",
      modified_since: null,
      contact_count: 0,
      invoice_count: 0,
      candidate_count: 0,
      error_code: null,
      created_at: now,
      started_at: now,
      completed_at: null,
    };
    const query = jest.fn(async (sql: string) => {
      if (sql.includes("SET status='processing'")) return { rows: [run], rowCount: 1 };
      if (sql.includes("FROM sophia_runtime.student_operations_xero_sync_runs failed")) {
        return { rows: [{ count: 3 }], rowCount: 1 };
      }
      return { rows: [{ exists: 1 }], rowCount: 1 };
    });
    const database = {
      tenantTransaction: jest.fn(async (_tenant: string, work: (db: unknown) => Promise<unknown>) =>
        work({ query })),
    };
    const xero = {
      syncContactPage: jest.fn(async () => {
        throw new BadGatewayException({
          message: "Xero could not complete the request.",
          errorCode: "xero_unavailable",
          providerStatus: 500,
          retryAfterSeconds: 300,
        });
      }),
      syncInvoicePage: jest.fn(),
    };
    const service = new StudentOperationsXeroSyncService(database as never, xero as never);

    await service.process(tenantId, run.sync_run_id);

    expect(query).toHaveBeenCalledWith(expect.stringContaining("SET status='failed'"), [
      tenantId, run.sync_run_id, expect.any(String), "xero_unavailable", 500, null, 21_600,
    ]);
    expect(query).toHaveBeenCalledWith(expect.stringContaining("next_sync_at=now()"), [
      tenantId, run.sync_run_id, "xero_unavailable", 21_600,
    ]);
    expect(query.mock.calls.some(([sql]) => String(sql).includes("last_seen_sync_run_id IS DISTINCT FROM $3")))
      .toBe(false);
  });

  it("assigns one explicit TRUST source and disables the previous assignment", async () => {
    const query = jest.fn(async () => ({ rows: [{ exists: 1 }], rowCount: 1 }));
    const database = {
      tenantTransaction: jest.fn(async (_tenant: string, work: (db: unknown) => Promise<unknown>) =>
        work({ query })),
    };
    const service = new StudentOperationsXeroSyncService(database as never, {} as never);

    await expect(service.configureTrust({
      tenantId, identityUserId: "user-1",
    } as never, connectionId)).resolves.toEqual({ connectionId, organisationRole: "trust" });

    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("organisation_role='unassigned', enabled=false"),
      [tenantId, connectionId],
    );
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("organisation_role='trust', enabled=true"),
      [tenantId, connectionId],
    );
  });
});
