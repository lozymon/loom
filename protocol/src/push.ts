import { z } from "zod";
import type { ApprovalRequest, StewardReview } from "./approvals.ts";

/** A browser push subscription, as `PushSubscription.toJSON()` gives it. */
export const PushSubscriptionJson = z.object({
  endpoint: z.string().url().max(2000),
  expirationTime: z.number().nullable().optional(),
  keys: z.object({ p256dh: z.string().min(1).max(200), auth: z.string().min(1).max(100) }),
});
export type PushSubscriptionJson = z.infer<typeof PushSubscriptionJson>;

/** A device that receives this hub's push notifications. */
export interface PushDevice {
  id: string;
  label: string;
  createdAt: number;
  /** The push service's host, e.g. fcm.googleapis.com, for telling devices apart. */
  service: string;
}

/**
 * True when only a person is left to decide: no Steward review running, and no Steward about to act
 * on its verdict. Read-back and push both wait for this.
 */
export function waitsForPerson(request: ApprovalRequest, steward: StewardReview | undefined = request.steward): boolean {
  if (!steward) return true;
  if (steward.status === "reviewing") return false;
  if (steward.status === "done" && steward.mode === "decide" && steward.decision !== "escalate" && !steward.heldBecause) return false;
  return true;
}
