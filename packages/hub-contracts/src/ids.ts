import { z } from "zod";

/** Tiny validation boundary for consumers that only need portable Relay links. */
export const RelayIdSchema = z.string()
  .regex(/^relay_[0-7][0-9A-HJKMNP-TV-Z]{25}$/, "Invalid Relay ID.");

export type RelayId = z.infer<typeof RelayIdSchema>;
