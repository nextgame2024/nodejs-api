import { z } from "zod";
import type { RuntimeTool } from "../tool-registry.js";

export const getInventoryInputSchema = z.object({
  productId: z.string().min(1),
  colour: z.string().min(1).optional(),
  storeId: z.string().min(1).optional(),
});

export type GetInventoryInput = z.infer<typeof getInventoryInputSchema>;

export type GetInventoryOutput = {
  productId: string;
  colour?: string;
  storeId: string;
  quantityAvailable: number;
  status: "in_stock" | "low_stock" | "out_of_stock";
};

export const getInventoryTool: RuntimeTool<
  GetInventoryInput,
  GetInventoryOutput
> = {
  definition: {
    name: "getInventory",
    description:
      "Return current product inventory for a store. Phase 1 uses a typed mock fixture.",
    parameters: {
      type: "object",
      properties: {
        productId: { type: "string" },
        colour: { type: "string" },
        storeId: { type: "string" },
      },
      required: ["productId"],
      additionalProperties: false,
    },
  },
  inputSchema: getInventoryInputSchema,
  async execute(input, context) {
    const storeId = input.storeId || context.storeId || "demo-store";
    const quantityAvailable = mockQuantity(input.productId, input.colour, storeId);

    return {
      productId: input.productId,
      colour: input.colour,
      storeId,
      quantityAvailable,
      status:
        quantityAvailable === 0
          ? "out_of_stock"
          : quantityAvailable < 5
            ? "low_stock"
            : "in_stock",
    };
  },
};

function mockQuantity(
  productId: string,
  colour: string | undefined,
  storeId: string,
): number {
  const seed = `${productId}:${colour || "any"}:${storeId}`;
  const total = [...seed].reduce((sum, char) => sum + char.charCodeAt(0), 0);
  return total % 18;
}
