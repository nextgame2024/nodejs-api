import { z } from "zod";

export const hostedCheckoutSchema = z.object({
  requestId: z.string().uuid(),
  planVersionId: z.string().uuid(),
}).strict();

export const hostedActionSchema = z.object({ requestId: z.string().uuid() }).strict();
