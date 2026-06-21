# Handoff: Termhaus — "Frameless" chrome redesign

## Overview

Termhaus is a desktop **control room of real terminals** — a graphical terminal multiplexer (a GUI tmux) for running many CLI tools/agents at once in resizable split grids, with a left rail of workspaces and a **broadcast bar** that types one prompt into many panes. This handoff covers a full visual redesign codenamed **Frameless**: the chrome around panes is quieted into floating cards, glassy identity chips, a detached broadcast bar, a slim borderless rail, and a single cool accent per theme. It spans every surface: workspace grid, fleet-at-scale grid, empty state, side panels (Git / Preview / Docs), command palette, new-workspace launcher, and settings — across four themes.

**Hard product constraint:** a _pane_ is **opaque**. Termhaus renders the raw bytes of whatever runs inside (xterm.js) and never interprets them. So this redesign is entirely about the **chrome around panes** — never the terminal content. Hierarchy is exactly two levels: **Workspace → Pane** (no tabs, no windows).

## About the Design Files

The files in this bundle are **design references created in HTML** — prototypes that show the intended look and behavior. They are **not production code to copy**. They are authored as "Design Components" (a streaming HTML format) and use a `support.js` runtime that is included only so the prototypes open and run in a browser for reference.

Termhaus' real frontend is **React + TypeScript (Tauri + WebKitGTK desktop app)**, components in `src/components/` (`WorkspaceRail`, `LayoutNode`, `Terminal`, `BroadcastBar`, `NewWorkspaceWizard`, `GitPanel`, `PreviewPanel`, `DocsPanel`, `CommandPalette`, `Settings`, `TitleBar`, `ShortcutsOverlay`). **The task is to recreate these designs in that existing React/TS codebase, using its established patterns** (component structure, state, theming via `data-theme` CSS custom properties) — not to port the HTML. Keep the opacity constraint and the two-level hierarchy intact.

## Fidelity

**High-fidelity.** Final colors, typography, spacing, radii, shadows, and interactions are specified below and in the prototypes. Recreate the UI pixel-faithfully using the codebase's libraries. Exact hex values, sizes, and copy are given — match them.

---

## Themes (CSS custom properties keyed off `<html data-theme>`)

A theme drives **both** the app chrome and every terminal palette, live. Four built-ins. The accent is reserved for **focus / active / live** only.

| Token                        | Dark (default)          | Light                   | Midnight                | Paper                   |
| ---------------------------- | ----------------------- | ----------------------- | ----------------------- | ----------------------- |
| `--canvas` (app bg)          | `#0e0f12`               | `#eef1f6`               | `#0b0d14`               | `#ece4d4`               |
| `--surface` (pane/card)      | `#191b20`               | `#ffffff`               | `#141826`               | `#faf7f0`               |
| `--surface-dead`             | `#141518`               | `#f3f4f7`               | `#10131d`               | `#f0ebe0`               |
| `--text-bright`              | `#e7e7ea`               | `#1c1e22`               | `#e3e8f0`               | `#2b2620`               |
| `--text-mid`                 | `#9a9da3`               | `#5b616c`               | `#9aa3b8`               | `#6b6253`               |
| `--text-dim`                 | `#7b7e84`               | `#767d89`               | `#79839a`               | `#857b6b`               |
| `--text-faint`               | `#5f6268`               | `#aab0bb`               | `#586273`               | `#b0a892`               |
| `--accent`                   | `#5b8cff`               | `#2f6bff`               | `#6ea8fe`               | `#5a55d6`               |
| `--accent-text`              | `#9bbcff`               | `#2f6bff`               | `#a9ccff`               | `#5a55d6`               |
| `--accent-rgb` (for alphas)  | `91,140,255`            | `47,107,255`            | `110,168,254`           | `90,85,214`             |
| `--well` (recessed input bg) | `#0f1013`               | `#eef1f6`               | `#0b0d14`               | `#efe9dc`               |
| `--chip` (glass chip bg)     | `rgba(12,13,16,.72)`    | `rgba(255,255,255,.82)` | `rgba(8,10,16,.72)`     | `rgba(250,247,240,.85)` |
| `--chip-border` (inset)      | `rgba(255,255,255,.07)` | `rgba(0,0,0,.08)`       | `rgba(255,255,255,.08)` | `rgba(43,38,32,.12)`    |
| `--hairline`                 | `rgba(255,255,255,.06)` | `rgba(0,0,0,.07)`       | `rgba(255,255,255,.06)` | `rgba(43,38,32,.1)`     |
| `--tint-weak` (hover/btn)    | `rgba(255,255,255,.04)` | `rgba(0,0,0,.04)`       | `rgba(255,255,255,.05)` | `rgba(43,38,32,.05)`    |

**Derived accent uses:** active-workspace / broadcast / selected-row fill = `linear-gradient(90deg, rgba(--accent-rgb,.16), rgba(--accent-rgb,.03))`; target chip bg = `rgba(--accent-rgb,.14)`.
**Light-theme rule:** on `light` and `paper`, **drop the focus glow** — the focused-pane ring becomes a solid `1.5px` accent stroke (no blur halo). The live-dot glow is also dropped.

### State colors (constant meaning across all themes)

| State             | Dark/Midnight         | Light/Paper           | Treatment                                                                                                                    |
| ----------------- | --------------------- | --------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| **working**       | `#5fb389`             | `#2e9e6b` / `#3f8f5f` | pulsing 6px dot                                                                                                              |
| **idle**          | `#6b6e74`             | `#9aa0ab` / `#b0a892` | static grey dot                                                                                                              |
| **needs you**     | `#c89244`             | `#c07d1f` / `#b07d2e` | amber dot + pane ring `0 0 0 1px rgba(200,146,68,.5)` + chip border `rgba(200,146,68,.32)` + label                           |
| **dead / exited** | `#9a6b6b` (fail text) | `#c0473f` / `#b25444` | hollow dot (1px border, `--text-dim`), dimmed `--surface-dead`, `inset 0 0 0 1px hairline`, shows `exited · N` + `↻ restart` |

---

## Design tokens — spacing, radius, shadow, type

**Layout / spacing**

- Rail width: `212px` (compact themed variant `172px`). Top bar height: `50px`. Broadcast bar height: `54px`.
- Grid gutter: `14px` (fleet grid `11px`). Grid padding: `8px 16px 0`. Body left padding (rail gutter): `14px`.
- Pane chip: `padding 6px 12px`, offset `top 13px / left 14px`. Pane content padding: `52px 20px 18px` (chip clearance at top).

**Radius**

- Pane card `14px` (fleet tiles `12px`) · bar/panel `14–15px` · overlay card `16–18px` · chips & pills `999px` · controls/inputs `8–9px` · rail rows `12px`.

**Shadow**

- Pane (dark): `0 18px 40px -22px rgba(0,0,0,.7)` · (light): `0 14px 30px -20px rgba(30,40,70,.26), inset 0 0 0 1px rgba(0,0,0,.05)`.
- Focus ring (dark): `0 0 0 1.5px rgba(--accent-rgb,.7), 0 0 32px -6px rgba(--accent-rgb,.42), 0 18px 40px -22px rgba(0,0,0,.7)` · (light): `0 0 0 1.5px var(--accent), 0 14px 30px -20px rgba(30,40,70,.25)`.
- Broadcast bar (dark): `0 16px 38px -18px rgba(0,0,0,.85), inset 0 0 0 1px rgba(255,255,255,.06)`.
- Side panel (dark): `0 18px 40px -22px rgba(0,0,0,.8), inset 0 0 0 1px rgba(255,255,255,.05)`.
- Overlay card (dark): `0 40px 100px -30px rgba(0,0,0,.9), inset 0 0 0 1px rgba(255,255,255,.07)`. Scrim: `rgba(8,9,11,.62)` dark / `rgba(40,46,60,.34)` light, `backdrop-filter: blur(2px)`.

**Typography** — `IBM Plex Sans` (chrome) + `IBM Plex Mono` (terminals, paths, badges, counts, shortcuts). Real app default mono is JetBrains/Cascadia; Plex Mono is the prototype stand-in.

| Use                       | Size / weight                                              |
| ------------------------- | ---------------------------------------------------------- |
| Page title                | 24–32 / 600, letter-spacing -.015em                        |
| Section heading           | 16 / 600                                                   |
| Body & controls           | 13–14 / 450                                                |
| Pane name (mono)          | 12 / 600 (fleet 10.5)                                      |
| Terminal text (mono)      | 12 / 400, line-height 1.75 (fleet 10)                      |
| Rail/section label (mono) | 10.5 / 500, letter-spacing .2em, uppercase, `--text-faint` |
| Status badge (mono)       | 9–10.5 / 500, letter-spacing .05em                         |

---

## Screens / Views

### 1. Top bar

- Height `50px`, transparent over `--canvas`, `padding 0 18px`.
- Left: app mark — `17px` circle, `radial-gradient(circle at 30% 30%, --accent-text, --accent)` — + "Termhaus" (14.5/600, -.01em). Clicking returns to Overview.
- Nav (left of center, `gap 24px`, 13px): **Overview · Palette · Git · Preview · Docs · Settings**. Active item = `--text-bright`, others `--text-dim` (hover → `#c9ccd1`). Active item reflects current surface: Git/Preview/Docs highlight when their panel is open; Palette when its overlay is open; Settings when on settings; else Overview.
- Right: window controls — minimize (`12×1.5px` bar), maximize (`9×9px` 1.5px-border square), close (`×`, 16px). Color `--text-faint`/`--text-dim`.

### 2. Workspace rail (left, 212px)

- `WORKSPACES` mono label + a `+` button (24px, radius 7) that opens the launcher.
- Workspace rows: height `44px`, radius `12px`, `gap 11px`, `padding 0 14px`. Each = live dot (6px) + name (13.5/500) + mono count badge. On hover bg `rgba(255,255,255,.04)`; active = accent gradient fill, name `--text-bright`, count `--accent-text`, dot glows (dark only). Inline duplicate/✕ controls fade in on hover (`.wsact`, opacity 0→1).
- Default rows: **Termhaus** (4, active), **Fleet** (12), **Scratch** (0).
- A dashed/tinted **New** row (radius 12, `--tint-weak`) opens the launcher.
- Footer: avatar (24px) + `lozymon`, mono, `--text-faint`, pinned bottom (`margin-top:auto`).

### 3. Overview — workspace grid (Termhaus, hero layout)

- Main area = flex column. Grid: `display:grid; grid-template-columns:1.45fr 1fr; grid-template-rows:1fr 1fr; gap:14px`. When a side panel is open, columns collapse to `1fr` and the panel docks at right.
- Four **pane cards** (one per state) demonstrate the language: **Faye** working+focused (accent ring), **Cleo** idle, **Wade** needs-you (amber ring), **Dext** dead (dimmed + restart).
- **Pane card anatomy:** `position:relative`, `--surface`, radius 14, `overflow:hidden`, state-dependent box-shadow. Floating **chip** top-left: `--chip` bg, `backdrop-filter:blur(8px)`, `inset 0 0 0 1px --chip-border`, radius 999 — contains state dot (6px, pulsing if live) + pane name (mono 12/600) + branch/status (mono 10.5, `⎇ main` or status word in state color). Hover controls top-right (`.pctl`, opacity 0→1 unless "always"): `+  ⤢  ×` (dead pane shows `↻ restart  ×`). Terminal text fills below with `padding 52px 20px 18px`.

### 4. Overview — Fleet (12-pane, scale test)

- Grid: `grid-template-columns:repeat(4,1fr)` (`repeat(3,1fr)` when a panel is open), `grid-auto-rows:1fr`, `gap:11px`. Tiles radius 12, compact chip (`padding 4px 9px`, name mono 10.5).
- **Per-agent tint:** panes are grouped (here 4× `claude --resume` accent, 4× `codex run` `#3fb6a8`, 4× `tail -f log` `#9a7fd8`). Each tile's chip carries a **2nd 5px dot** in the group tint, and a faint group-colored inset border (`inset 0 0 0 1px <tint>33`). State (dot + a tiny uppercase status label top-right: `WORKING / IDLE / NEEDS YOU / EXITED·1`) stays the primary signal; tint is secondary. Focused tile still gets the accent ring; dead/needs use their state treatments.

### 5. Overview — Scratch (empty / first run)

- Centered column (max 360px): a 62px dashed rounded-square icon containing a 2×2 mini-grid glyph; "No panes yet" (18/600); one-line helper (`--text-mid`); primary button **Choose a layout** (accent, white text, radius 11) → opens launcher; secondary **Split a pane** (inset hairline border); mono hint `or press Ctrl+Shift+D`.
- The broadcast bar is **hidden** on empty workspaces.

### 6. Broadcast bar (bottom of grid area)

- Detached floating bar: height 54, radius 15, `--surface`, bar shadow, `padding 0 8px 0 16px`, `gap 14`.
- Contents: an on/off **toggle** (32×18 pill, accent when on) + "Broadcast" label; a hairline divider; the prompt field hint `Type a prompt → <scope hint>…` (mono, `--text-faint`); a **Targets chip** (`⌖ <scope label> ▾`, accent text on `rgba(--accent-rgb,.14)`, radius 999); a **Send** button (accent, white, radius 11).
- **Targets dropdown:** clicking the chip opens a menu (absolute, above the bar, 236px, `--surface`, panel shadow, radius 12). Rows: **All live panes** (`2 live`), **Group: claude** (`4`), **Current pane** (`1`). Selected row gets the accent-gradient fill. Selecting updates the chip label and the prompt hint, and closes the menu.

### 7. Side panels — Git / Preview / Docs (dock right, never replace grid)

- Each is its own floating card (`--surface`, radius 14, panel shadow). Width: Git `440px`, Preview/Docs `480px`. Grid reflows to a single column to make room.
- **Git:** 46px header ("Source Control" + `⎇ main` + refresh `↻` + close `×`). `CHANGES · 3` list with M/A/D status letters (M=needs amber, A=working green, D=fail red) + mono file paths; selected row has `--tint-weak` bg. Below, a unified-diff viewer (mono 11.5): context lines `--text-dim`, added lines `rgba(working,.12)` bg + working text, removed lines `rgba(fail,.12)` bg + fail text. Footer hint: `⌖ drag to select lines → send to terminal`.
- **Preview:** header = reload `↻` + a URL field (`localhost:3000`, mono, in `--well`) + pop-out `⤤` + close. Body is a white web-preview placeholder (mock page; accent-colored header bar).
- **Docs:** header "Docs" + close; a row of file tabs (README active = accent-gradient pill, others `--text-mid`); rendered-markdown body (title 21/600, lead `--text-mid`, a mono code block in `--well` with working-green text).

### 8. Command palette (overlay)

- Centered-top over scrim (padding-top 96px). Card 640px, `--surface`, radius 16, overlay shadow. Header: `⌘` accent + a mono search line with a blinking cursor + an `esc` kbd chip. Body sections `ACTIONS` and `GO TO PANE` (mono uppercase labels). Rows (radius 9, `gap 12`): icon + label (13.5) + right-aligned mono shortcut. First/selected row gets accent-gradient fill. "Go to pane" rows lead with a state dot.

### 9. New-workspace launcher (overlay)

- Centered over scrim. Card 880px, `--surface`, radius 18, overlay shadow. Header "New workspace" + close.
- **Left column (380px, "WHERE"):** Workspace name field (in `--well`, accent inset ring + cursor); Working folder field (mono path) + Browse button + recents chips; Presets chips (active "Fleet ×4" = accent-gradient + accent text).
- **Right column ("WHAT RUNS"):** **Layout** row (`4 panes`, accent text) with mini layout-tile previews (1/2/**4 selected**/6) — the selected tile has an accent ring and one accent-filled cell — plus a 1–16 slider (accent fill ~25%). A **Fleet** row in `--well`: "Fill every pane with [Claude Code ▾]" + "Apply to all" (accent). An interactive 2×2 **Preview** grid (Faye selected w/ accent ring; each shows name + `claude`). Footer: `Ctrl+Shift+T` hint + Cancel + **Create workspace** (accent).

### 10. Settings

- Centered max-width 860 column, scrollable. Title "Settings" (24/600). Tab bar: **Appearance** / **Key bindings** (active = `--text-bright` + 2px accent underline).
- **Appearance → THEME:** 4 live "Ab" swatch tiles (Dark/Light/Midnight/Paper) showing each theme's bg/fg + accent dot. Clicking a tile **applies the theme live across the whole app**; the active tile has a `0 0 0 2px accent` ring (others `inset 0 0 0 1px hairline`).
- **Appearance → TERMINAL:** a grouped card (`--surface`, inset hairline, rows divided by hairline): Font family (select chip `JetBrains Mono ▾`), Font size (slider at 14px), Cursor style (segmented Block/Bar/Underline, Block active = accent), Cursor blink (toggle on = accent), Scrollback lines (`5000`).
- **Key bindings:** intro note that all app shortcuts live in the `Ctrl+Shift` namespace (so plain keys reach the terminal). Grouped lists **FOCUS / PANES / WORKSPACES**, each row = action + a mono kbd chip in `--well`. Bindings: Move focus `Ctrl+Shift+Arrows`, Palette `Ctrl+Shift+P`, Split right `Ctrl+Shift+D`, Split down `Ctrl+Shift+E`, Zoom `Ctrl+Shift+Enter`, New workspace `Ctrl+Shift+T`, Jump to workspace `Ctrl+Shift+1…9`.

---

## Interactions & Behavior

- **Top nav** switches the main surface. Overview/Settings are full-area views; Git/Preview/Docs toggle a docked side panel (clicking the active one again closes it); Palette/Launcher open as scrim overlays. Opening a panel or settings clears any overlay.
- **Rail rows** switch the active workspace (Termhaus hero / Fleet / Scratch empty) and return to Overview.
- **Overlays** close on scrim click or Esc; inner card stops propagation. Card animates in: `@keyframes ovin { from{opacity:0; transform:translateY(8px) scale(.99)} to{opacity:1;transform:none} }`, `.16s ease-out`. Scrim fades `.14s`.
- **Targets chip** toggles the scope dropdown (stops propagation so a document click can close it); selecting a scope updates label + hint.
- **Hover reveals:** pane controls (`.pctl`) and rail row controls (`.wsact`) transition opacity 0→1 over `.12s`. (A "pane controls: always visible" option forces opacity 1.)
- **Theme tiles** in Settings set the active theme and repaint the entire app instantly via tokens.
- **Animations:** live dots pulse — `@keyframes { 0%,100%{opacity:1} 50%{opacity:.4} }`, `2.4s ease-in-out infinite`. Terminal cursors blink — same idea, `1.1s steps(1,end)`.
- **Responsive:** desktop resizable window. Rail fixed width; grid is a fluid binary split tree (fractional rows/cols, draggable gutters in the real app). Panes have no min content width — gutters/chip padding stay constant as panes shrink. Side panels keep px width; the grid yields. Below ~1100px the rail can collapse to icons (future enhancement, not in mocks).

## State Management

Prototype state (recreate as component/store state):

- `theme`: `dark | light | midnight | paper` — drives `data-theme` / token set, app-wide.
- `activeWorkspace`: `termhaus | fleet | scratch` — selects grid content.
- `surface/nav`: `overview | settings`.
- `panel`: `null | git | preview | docs` — docked side panel (toggle).
- `overlay`: `null | palette | launcher` — scrim overlay.
- `settingsTab`: `appearance | keys`.
- `broadcast.targetsOpen`: boolean; `broadcast.scope`: `all | group | current` (drives chip label + hint).
- Per pane (real app): name, status (`working|idle|needs|dead`), branch, agent/command, cwd, alive, exitCode, tint(group). Per workspace: name, pane tree, count.

## Assets

No raster assets or icon files — all glyphs are Unicode (`+ × ⤢ ⎇ ⌖ ⌘ ↻ ⊟ ⊞ ◫ ▣`) and shapes are CSS. Fonts: **IBM Plex Sans** + **IBM Plex Mono** (Google Fonts) for the prototype; the real app uses its configured monospace stack (JetBrains/Cascadia). Swap to the codebase's icon set if preferred — keep glyphs simple and monoline.

## Files (in this bundle)

- `Termhaus App.dc.html` — the full interactive prototype: all surfaces, 4 themes, fleet, empty state, targets dropdown, panels, overlays, settings. **Primary reference.**
- `Termhaus Themes.dc.html` — the workspace grid rendered in all four themes side by side (accent/state verification).
- `Termhaus Frameless.dc.html` — standalone single-window workspace grid (clean reference for the hero layout).
- `Termhaus Minimal.dc.html` — the original three exploration directions (Quiet / Instrument / Frameless) for context on why Frameless was chosen.
- `ThemeWorkspace.dc.html` — the themed grid component used by the matrix (per-theme token sets in its logic).
- `support.js` — runtime so the `.dc.html` references open in a browser. **Not part of the design**; do not port.

To view a reference: open any `.dc.html` in a browser (they load `support.js` from the same folder).
