import { UnprocessableEntityException } from "@nestjs/common";
import { beforeEach, jest } from "@jest/globals";
import { WorkflowAdminService } from "./workflow-admin.service.js";

describe("WorkflowAdminService", () => {
  beforeEach(() => {
    process.env.SOPHIA_RUNTIME_DATABASE_URL = "postgres://example";
    process.env.SOPHIA_RUNTIME_SCHEMA = "sophia_runtime";
  });
  const template = {
    templateKey: "real-estate.sale-property-report", version: "1.0.0", displayName: "Report",
    description: "Owner-managed report", ownerKey: "business-manager", connectorKey: "business-manager-real-estate",
    configurationSchema: { type: "object" }, requiredAuthorization: ["booking-explicit-user-review"],
    statusOperationId: "workflow.status" as const, retry: { support: "unsupported" as const },
    parseConfiguration: (value: unknown) => value as Record<string, unknown>,
    getStatus: jest.fn(),
  };

  it("exposes fixed authorization and honest retry support from the compiled template", () => {
    const service = new WorkflowAdminService({} as never, { workflowTemplates: () => [template] } as never, {} as never);
    expect(service.templates()).toEqual({ templates: [expect.objectContaining({
      templateKey: template.templateKey,
      requiredAuthorization: ["booking-explicit-user-review"],
      retry: { support: "unsupported" },
    })] });
  });

  it("does not invoke an owner when manual retry is unsupported", async () => {
    const database = { tenantTransaction: jest.fn(async (_tenant: string, work: (client: { query: jest.Mock }) => unknown) =>
      work({ query: jest.fn().mockResolvedValue({ rowCount: 1, rows: [{
        workflow_run_id: "run", workflow_version_id: "version", capability_binding_id: "binding",
        owner_key: "business-manager", external_run_ref: "external", last_status: "failed", last_status_at: null,
        template_key: template.templateKey, connector_key: template.connectorKey,
      }] }) })) };
    const service = new WorkflowAdminService(database as never, { workflowTemplates: () => [template] } as never, {} as never);
    await expect(service.retry("00000000-0000-4000-8000-000000000001", "run", "actor",
      { idempotencyKey: "retry-key-1" })).rejects.toBeInstanceOf(UnprocessableEntityException);
    expect(template.getStatus).not.toHaveBeenCalled();
  });
});
