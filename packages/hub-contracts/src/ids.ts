import { z } from "zod";

/** Tiny validation boundary for consumers that only need portable Hub links. */
export const TeamMemberIdSchema = z.string()
  .regex(/^member_[0-7][0-9A-HJKMNP-TV-Z]{25}$/, "Invalid member ID.");

export const RelayIdSchema = z.string()
  .regex(/^relay_[0-7][0-9A-HJKMNP-TV-Z]{25}$/, "Invalid Relay ID.");

export type TeamMemberId = z.infer<typeof TeamMemberIdSchema>;
export type RelayId = z.infer<typeof RelayIdSchema>;
