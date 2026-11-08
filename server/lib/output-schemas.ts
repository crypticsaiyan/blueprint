import { z } from "zod";

// Output contracts for the shapes many actions return. Nested payloads are
// typed in shared/*; here they are validated loosely by shape.
export const changeItemOutput = z.object({
  id: z.string(),
  kind: z.string(),
  payload: z.record(z.string(), z.unknown()),
  reason: z.string(),
  status: z.enum(["proposed", "accepted", "rejected"]),
  locked: z.boolean(),
  origin: z.enum(["agent", "drawing", "user"]),
  position: z.number(),
  summary: z.string(),
});

export const jsonObject = z.record(z.string(), z.unknown());
