import { describe, expect, it } from "vitest";
import {
  ACTIONS,
  DEFAULT_KEYBINDINGS,
  SWITCH_WORKSPACE_ACTIONS,
  actionForKey,
  formatBinding,
} from "./keybindings";

const kb = DEFAULT_KEYBINDINGS;

describe("actionForKey — shift-folding", () => {
  it("folds Shift'd digit symbols back to workspace-jump actions (US layout)", () => {
    // Ctrl+Shift+1 reports "!", …+9 reports "(" — must still resolve to switch-workspace-N.
    const symbols = ["!", "@", "#", "$", "%", "^", "&", "*", "("];
    symbols.forEach((sym, i) => {
      expect(actionForKey(kb, sym)).toBe(`switch-workspace-${i + 1}`);
    });
  });

  it("still resolves a plain digit (layouts that report 1 not !)", () => {
    expect(actionForKey(kb, "1")).toBe("switch-workspace-1");
    expect(actionForKey(kb, "9")).toBe("switch-workspace-9");
  });

  it("resolves the existing +/-/, folds (regression guard)", () => {
    expect(actionForKey(kb, "+")).toBe("font-increase");
    expect(actionForKey(kb, "_")).toBe("font-decrease");
    expect(actionForKey(kb, "<")).toBe("settings");
  });

  it("resolves ? to the shortcuts cheat-sheet", () => {
    expect(actionForKey(kb, "?")).toBe("shortcuts");
  });

  it("returns null for an unbound key", () => {
    expect(actionForKey(kb, "q")).toBeNull();
  });
});

describe("keybinding registry", () => {
  it("every action has a default key and they're unique after folding", () => {
    for (const a of ACTIONS) expect(kb[a.id]).toBeTruthy();
    // No two actions resolve from the same physical key (folded), or shortcuts would collide.
    const folded = ACTIONS.map((a) => actionForKey(kb, kb[a.id]));
    expect(new Set(folded).size).toBe(ACTIONS.length);
  });

  it("exposes the nine workspace-jump actions bound to 1…9", () => {
    expect(SWITCH_WORKSPACE_ACTIONS).toHaveLength(9);
    SWITCH_WORKSPACE_ACTIONS.forEach((id, i) => {
      expect(kb[id]).toBe(String(i + 1));
    });
  });

  it("formatBinding renders the Ctrl+Shift namespace", () => {
    expect(formatBinding("1")).toBe("Ctrl+Shift+1");
    expect(formatBinding("?")).toBe("Ctrl+Shift+?");
    expect(formatBinding("d")).toBe("Ctrl+Shift+D");
    expect(formatBinding("arrowup")).toBe("Ctrl+Shift+↑");
  });
});
