// Remote-origin authority — the deny-by-default per-op policy (ADR-0012 rule 3). A command tagged
// with a non-local Origin (a paired Device, over the LAN bridge or, later, the VPS relay) is
// governed by this table, NOT by the existing local guardrails — those are an allowlist-by-omission
// inherited from ADR-0007's OS-user trust model, which remote control repeals.
//
// The table is keyed by op and **fails closed**: an op earns a disposition only by being listed, so
// a new bus op (and the codebase grows them routinely — CLAUDE.md) is remote-inert until someone
// deliberately rules on it. Adding a row is a decision; forgetting to is safe.
//
// One reader, two writers, everything else closed — the whole remote surface (rule 3, post-grill):
//   allow   → `list` (metadata; feeds the fleet screen; no prompt)
//   approve → `send`, `read` (the Pane-detail screen; each fires a Confirmation — rule 3.2)
//   deny    → everything else, including ops that do not exist yet
//
// `status`/`attention` are DENY despite sounding like reads: they are setters (a Device must not
// rewrite labels or clear borders fleet-wide). `spawn` is absent, not gated — the silent-RCE
// primitive has no remote surface. Judge an op by what it does, not its name.
//
// This table is unchanged by "trust this device" (stores/remoteTrust): trust only collapses the
// per-op Confirmation for `approve` ops into a one-time grant, so a paired phone is drivable when
// nobody is at the laptop. `allow` stays promptless, `deny` stays closed, and trusted ops are still
// audited (rule 4). Trust is the operator's opt-in tradeoff, revoked by unpairing.

export type RemoteDisposition = "allow" | "approve" | "deny";

/** The remote disposition of a bus op. Unlisted → `deny` (fail closed). */
export function remoteDisposition(op: string): RemoteDisposition {
  switch (op) {
    case "list":
      return "allow";
    case "send":
    case "read":
    // A Device uploading an image writes a file to the laptop — same trust tier as send/read: gated
    // by a Clearance (or the trusted-device grant), never silent. The Rust side sanitizes the name
    // into a fixed uploads dir, so it can't write outside it.
    case "upload":
      return "approve";
    default:
      return "deny";
  }
}
