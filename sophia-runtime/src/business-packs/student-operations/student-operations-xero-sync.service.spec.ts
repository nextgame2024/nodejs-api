import { afterAll, beforeAll, describe, expect, it, jest } from "@jest/globals";
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

    const result = await service.candidates(tenantId, connectionId, { page: "1", limit: "20", q: "Candidate" });

    expect(result.total).toBe(1);
    expect(result.candidates[0]).toEqual(expect.objectContaining({
      legalName: "Candidate Student", amountDue: 75.5, paymentStatus: "due",
    }));
    expect(query).toHaveBeenLastCalledWith(expect.stringContaining("ILIKE $3"), [
      tenantId, connectionId, "%Candidate%", 20, 0,
    ]);
    expect(xero.syncContactPage).not.toHaveBeenCalled();
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
