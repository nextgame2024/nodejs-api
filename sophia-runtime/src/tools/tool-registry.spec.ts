import { describe, expect, it, jest } from "@jest/globals";
import { z } from "zod";
import { ToolRegistry } from "./tool-registry.js";
import { getInventoryTool } from "./mock/get-inventory.tool.js";

describe("ToolRegistry", () => {
  it("registers and executes a typed tool", async () => {
    const registry = new ToolRegistry();
    registry.register(getInventoryTool);

    const result = await registry.execute(
      "getInventory",
      { productId: "shoe-1", colour: "black" },
      { customerId: "customer-1", storeId: "store-1" },
    );

    expect(result).toMatchObject({
      productId: "shoe-1",
      colour: "black",
      storeId: "store-1",
    });
  });

  it("rejects invalid input before executing a tool", async () => {
    const registry = new ToolRegistry();
    registry.register({
      definition: {
        name: "typedTool",
        description: "Test tool",
        parameters: {},
      },
      inputSchema: z.object({ productId: z.string().min(1) }),
      execute: jest.fn(),
    });

    await expect(
      registry.execute("typedTool", { productId: "" }, { customerId: "c1" }),
    ).rejects.toThrow();
  });

  it("does not allow duplicate tool names", () => {
    const registry = new ToolRegistry();
    registry.register(getInventoryTool);

    expect(() => registry.register(getInventoryTool)).toThrow(
      "Tool already registered",
    );
  });
});
