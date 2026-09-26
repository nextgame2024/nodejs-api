import { describe, expect, it, jest } from "@jest/globals";
import { ToolRegistryService } from "../../tools/tools.service.js";
import { SecureReasoningToolExecutor } from "./reasoning-tool.executor.js";

describe("SecureReasoningToolExecutor", () => {
  it("routes server-owned calls through the secured v2 dispatcher with the session credential", async () => {
    const executeV2 = jest.fn<ToolRegistryService["executeV2"]>().mockResolvedValue({
      toolCallId: "invocation-1", toolId: "catalog.search", status: "succeeded", capability: "catalog", data: {},
    });
    const executor = new SecureReasoningToolExecutor({ executeV2 } as unknown as ToolRegistryService);
    await executor.execute({ callId: "provider-call-1", name: "catalog.search", arguments: { query: "Bulimba" } }, {
      customerId: "customer-1", sessionId: "session-1", sessionAccessToken: "access-token", correlationId: "correlation-1",
    });

    expect(executeV2).toHaveBeenCalledWith("catalog.search", { query: "Bulimba" }, expect.objectContaining({
      customerId: "customer-1", sessionId: "session-1", providerCallId: "provider-call-1",
      provenance: "server-provider-connection",
    }), "access-token");
  });
});
