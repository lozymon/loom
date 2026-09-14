/** Who is issuing a hub command (ADR-0007). */
export type SessionRole = "session" | "cockpit";

export type Actor = { kind: "human" } | { kind: "session"; sessionId: string; role: SessionRole };

export const HUMAN: Actor = { kind: "human" };
