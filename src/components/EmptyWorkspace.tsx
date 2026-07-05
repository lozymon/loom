// First-run / empty-workspace state (Frameless §5 "Scratch"). Shown when a workspace has zero
// panes — a centered column that points at the two ways to get terminals into it. In practice the
// app keeps every workspace at ≥1 pane (closePane never empties a workspace), so this is a
// defensive surface: it renders correctly if an empty workspace ever exists.

import { MOD_NAMESPACE } from "../lib/keybindings";

export default function EmptyWorkspace(props: { onChooseLayout: () => void }) {
  return (
    <div class="empty-ws">
      <div class="empty-ws-col">
        <div class="empty-ws-icon">
          <span class="empty-ws-grid">
            <i /><i /><i /><i />
          </span>
        </div>
        <h2 class="empty-ws-title">No panes yet</h2>
        <p class="empty-ws-help">Pick a layout to fill this workspace with terminals, or split one open.</p>
        <div class="empty-ws-actions">
          <button class="empty-ws-primary" onClick={() => props.onChooseLayout()}>Choose a layout</button>
          <button class="empty-ws-secondary" onClick={() => props.onChooseLayout()}>Split a pane</button>
        </div>
        <span class="empty-ws-hint">or press {MOD_NAMESPACE}+D</span>
      </div>
    </div>
  );
}
